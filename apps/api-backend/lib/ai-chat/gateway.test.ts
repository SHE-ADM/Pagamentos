import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.stubEnv('ANTHROPIC_API_KEY', `test-${crypto.randomUUID()}`);

// Mock do SDK: `create` é controlado por teste, e as classes de erro precisam ser REAIS — o
// gateway e a tradução usam instanceof, que falharia contra uma classe redefinida no mock (a
// mesma armadilha que quebrou 36 testes na migração do ApiServiceError).
const create = vi.fn();
vi.mock('@anthropic-ai/sdk', async () => {
  const actual = await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk');
  class MockAnthropic {
    // O gateway usa `.stream(...).finalMessage()`; o mock devolve o mesmo objeto de mensagem por
    // trás dessa fachada, porque o que os testes verificam é o CONTEÚDO enviado e recebido, não o
    // transporte. Uma rejeição precisa vir de `finalMessage()` — é onde o SDK real a lança.
    // `.on('text', cb)` existe porque o gateway o usa para repassar o texto em tempo real à rota
    // SSE. O mock o simula da forma mais fiel que importa aqui: emite cada bloco de texto da
    // resposta ANTES de `finalMessage()` resolver, que é a ordem do SDK real. Sem isso não haveria
    // como provar que o progresso sai do MESMO loop que produz a resposta.
    messages = {
      stream: (...a: unknown[]) => {
        const p = create(...a);
        const handlers: Array<(delta: string) => void> = [];
        const fachada = {
          on: (evento: string, cb: (delta: string) => void) => {
            if (evento === 'text') handlers.push(cb);
            return fachada;
          },
          finalMessage: async () => {
            const msg = (await p) as { content?: Array<{ type: string; text?: string }> };
            for (const bloco of msg.content ?? []) {
              if (bloco.type === 'text' && bloco.text) {
                for (const cb of handlers) cb(bloco.text);
              }
            }
            return msg;
          },
        };
        return fachada;
      },
    };
  }
  return {
    default: Object.assign(MockAnthropic, {
      RateLimitError: actual.default.RateLimitError,
      APIError: actual.default.APIError,
      APIConnectionError: actual.default.APIConnectionError,
      APIConnectionTimeoutError: actual.default.APIConnectionTimeoutError,
    }),
  };
});

const runToolMock = vi.fn();
vi.mock('./tools', async () => {
  const actual = await vi.importActual<typeof import('./tools')>('./tools');
  return { ...actual, runTool: (...a: unknown[]) => runToolMock(...a) };
});

import { runChat } from './gateway';
import { AiChatAbortedError, AiChatError, readPartialRun } from './errors';

const supabase = {} as never;
const TOKEN = 'jwt';
/** Espelha MAX_ITERATIONS do gateway (interno de propósito — não faz parte da API). */
const MAX_ITERATIONS = 6;

/**
 * O gateway MUTA o array `messages` a cada iteração, e um mock guarda apenas a referência —
 * `create.mock.calls[i][0].messages` refletiria o estado FINAL, não o daquele turno. Snapshots
 * clonados por chamada são o que permite afirmar o que realmente foi enviado em cada iteração.
 */
interface Snapshot {
  system: unknown;
  tools: unknown;
  tool_choice: unknown;
  messages: { role: string; content: unknown }[];
}
const snapshots: Snapshot[] = [];

function snapshotOf(i: number): Snapshot {
  const s = snapshots[i];
  if (!s) throw new Error(`sem snapshot para a chamada ${i} (houve ${snapshots.length})`);
  return s;
}

/** Conteúdo da última mensagem `user` daquele turno — onde vivem os tool_result. */
function lastUserContent(i: number): { tool_use_id: string; is_error?: boolean; content: string }[] {
  const msgs = snapshotOf(i).messages;
  const user = [...msgs].reverse().find((m) => m.role === 'user');
  return user?.content as never;
}

/**
 * Fila de respostas do modelo, em vez de `mockResolvedValueOnce`: este mock precisa de
 * `mockImplementation` para tirar o snapshot, e o `...Once` tem precedência sobre a
 * implementation — o snapshot nunca seria capturado.
 */
const queue: unknown[] = [];
let repeat: unknown = null;

const reply = (...rs: unknown[]) => queue.push(...rs);
/** Responde o mesmo indefinidamente — para exercitar o teto de iterações. */
const replyAlways = (r: unknown) => {
  repeat = r;
};

/**
 * As fixtures padrão trazem `cache_read_input_tokens` porque é assim que um turno REAL se parece:
 * o `cache_control` no bloco estável faz a API sempre criar ou ler o prefixo. Sem isso, todo caso
 * do arquivo exercitaria o caminho de falha de `warnIfCachingDisabled` e o aviso viraria ruído
 * constante na saída — o jeito mais rápido de ensinar que ele pode ser ignorado.
 */
const textReply = (text: string) => ({
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3000 },
});

const toolReply = (calls: { id: string; name: string; input: unknown }[]) => ({
  content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
  stop_reason: 'tool_use',
  usage: { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 3000 },
});

beforeEach(() => {
  create.mockReset();
  runToolMock.mockReset();
  snapshots.length = 0;
  queue.length = 0;
  repeat = null;

  create.mockImplementation((args: Snapshot) => {
    snapshots.push(
      structuredClone({
        system: args.system,
        tools: args.tools,
        tool_choice: args.tool_choice,
        messages: args.messages,
      }),
    );
    const next = queue.shift() ?? repeat;
    if (!next) return Promise.reject(new Error('fila de respostas vazia'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
});

afterEach(() => vi.restoreAllMocks());

describe('runChat — caminho normal', () => {
  it('responde sem tools quando a pergunta não exige consulta', async () => {
    reply(textReply('Olá! Posso consultar suas contas a pagar.'));
    const r = await runChat(supabase, TOKEN, { question: 'o que você faz?' });

    expect(r.answer).toMatch(/contas a pagar/);
    expect(r.toolCalls).toEqual([]);
    expect(r.truncated).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('executa a tool e devolve a resposta final, somando os tokens das duas chamadas', async () => {
    reply(
      toolReply([{ id: 't1', name: 'resumo_situacao', input: {} }]),
      textReply('Você tem R$ 8.338.039,49 em aberto.'),
    );
    runToolMock.mockResolvedValueOnce([{ status_name: 'pago', total_amount: '8338039.49' }]);

    const r = await runChat(supabase, TOKEN, { question: 'como estamos?' });

    expect(r.answer).toContain('8.338.039,49');
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]).toMatchObject({ name: 'resumo_situacao', rows: 1 });
    expect(r.rowCount).toBe(1);
    expect(r.inputTokens).toBe(30); // 20 + 10
    expect(r.outputTokens).toBe(13); // 8 + 5
  });

  it('a data de hoje vai na MENSAGEM, não no system — senão o cache nunca acerta (§17.4)', async () => {
    reply(textReply('ok'));
    await runChat(supabase, TOKEN, { question: 'quanto paguei este mês?' });

    const hoje = new Date().toISOString().slice(0, 10);
    expect(JSON.stringify(snapshotOf(0).system)).not.toContain(hoje);
    expect(JSON.stringify(snapshotOf(0).messages)).toContain(hoje);
  });

  it('marca o bloco estável com cache_control (prompt caching)', async () => {
    reply(textReply('ok'));
    await runChat(supabase, TOKEN, { question: 'teste' });

    const system = snapshotOf(0).system as { cache_control?: unknown }[];
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('runChat — invariantes do loop (§17.6)', () => {
  it('devolve TODOS os tool_result paralelos em UMA única mensagem user', async () => {
    reply(
      toolReply([
        { id: 'a', name: 'resumo_situacao', input: {} },
        { id: 'b', name: 'aging_vencidos', input: {} },
      ]),
      textReply('pronto'),
    );
    runToolMock.mockResolvedValue([{ x: 1 }]);

    await runChat(supabase, TOKEN, { question: 'resumo e aging' });

    const userMsgs = snapshotOf(1).messages.filter((m) => m.role === 'user');
    // 1 = a pergunta; 2 = o bloco com AMBOS os resultados. Dividir em duas mensagens ensinaria o
    // modelo a parar de paralelizar.
    expect(userMsgs).toHaveLength(2);
    const results = userMsgs[1].content as { tool_use_id: string }[];
    expect(results).toHaveLength(2);
    expect(results.map((c) => c.tool_use_id)).toEqual(['a', 'b']);
  });

  it('preserva a resposta do assistente INTEIRA (blocos tool_use), não só o texto', async () => {
    reply(toolReply([{ id: 't1', name: 'resumo_situacao', input: {} }]), textReply('ok'));
    runToolMock.mockResolvedValueOnce([]);

    await runChat(supabase, TOKEN, { question: 'x' });

    const assistant = snapshotOf(1).messages.find((m) => m.role === 'assistant');
    // Extrair só o texto quebraria o pareamento tool_use/tool_result.
    expect((assistant?.content as { type: string }[])[0].type).toBe('tool_use');
  });

  it('falha da tool volta como tool_result com is_error, sem omitir o bloco', async () => {
    reply(
      toolReply([{ id: 't1', name: 'resumo_situacao', input: {} }]),
      textReply('não consegui consultar'),
    );
    runToolMock.mockRejectedValueOnce(new Error('permission denied for schema analytics'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const r = await runChat(supabase, TOKEN, { question: 'x' });

    const block = lastUserContent(1)[0];
    expect(block).toMatchObject({ tool_use_id: 't1', is_error: true });
    // O detalhe do erro fica no log, não vai ao modelo.
    expect(block.content).not.toContain('permission denied');
    expect(r.toolCalls[0].error).toContain('permission denied');
  });

  it('parâmetro inválido do modelo volta como erro legível, sem chamar o banco', async () => {
    reply(
      toolReply([{ id: 't1', name: 'gasto_por_periodo', input: { date_from: '01/07/2026' } }]),
      textReply('corrigido'),
    );

    await runChat(supabase, TOKEN, { question: 'x' });

    expect(runToolMock).not.toHaveBeenCalled();
    const block = lastUserContent(1)[0];
    expect(block.is_error).toBe(true);
    expect(block.content).toContain('date_from');
  });

  it('tool inexistente inventada pelo modelo não chega ao banco', async () => {
    reply(
      toolReply([{ id: 't1', name: 'drop_all_tables', input: {} }]),
      textReply('não tenho essa ferramenta'),
    );

    await runChat(supabase, TOKEN, { question: 'x' });

    expect(runToolMock).not.toHaveBeenCalled();
    expect(lastUserContent(1)[0].is_error).toBe(true);
  });
});

describe('runChat — resposta cortada por max_tokens', () => {
  it('marca truncated: o turno terminou, mas o texto foi cortado no meio', async () => {
    reply({
      content: [{ type: 'text', text: 'O total em aberto é de R$ 8.33' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 10, output_tokens: 8192, cache_read_input_tokens: 3000 },
    });

    const r = await runChat(supabase, TOKEN, { question: 'x' });
    // Sem isso, uma frase pela metade chegaria ao usuário como resposta completa.
    expect(r.truncated).toBe(true);
    expect(r.answer).toContain('8.33');
  });

  it('turno sem bloco de texto devolve aviso, não string vazia', async () => {
    reply({
      content: [],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 3000 },
    });
    const r = await runChat(supabase, TOKEN, { question: 'x' });
    expect(r.answer).toMatch(/reformular/i);
  });
});

describe('runChat — teto do resultado de tool', () => {
  it('corta por REGISTRO e avisa quantos ficaram, sem quebrar o JSON', async () => {
    // ~200 bytes por linha × 2000 linhas ≈ 400 KB — muito acima do teto.
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      id: i,
      supplier: `FORNECEDOR COM RAZÃO SOCIAL LONGA NÚMERO ${i} LTDA`,
      description: 'x'.repeat(120),
      amount: '1234.56',
    }));
    reply(
      toolReply([
        {
          id: 't1',
          name: 'listar_contas',
          input: { date_from: '2026-01-01', date_to: '2026-12-31' },
        },
      ]),
      textReply('ok'),
    );
    runToolMock.mockResolvedValueOnce(rows);

    await runChat(supabase, TOKEN, { question: 'liste tudo' });

    const sent = lastUserContent(1)[0].content;
    expect(sent.length).toBeLessThan(80_000);
    expect(sent).toContain('de 2000 registros');
    // O corte é entre registros: o trecho antes do aviso continua sendo JSON válido.
    const json = sent.slice(0, sent.indexOf('\n\n[Resultado truncado'));
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('UM registro grande demais é cortado e o corte é declarado', async () => {
    // `additional_info` é TEXT sem limite: uma conta sozinha pode estourar o teto. Devolver o
    // registro inteiro furaria justamente a proteção do contexto; cortar sem avisar faria o modelo
    // ler o fragmento final como dado.
    const enorme = [{ id: 1, additional_info: 'x'.repeat(200_000) }];
    reply(
      toolReply([
        {
          id: 't1',
          name: 'listar_contas',
          input: { date_from: '2026-01-01', date_to: '2026-12-31' },
        },
      ]),
      textReply('ok'),
    );
    runToolMock.mockResolvedValueOnce(enorme);

    await runChat(supabase, TOKEN, { question: 'x' });

    const sent = lastUserContent(1)[0].content;
    expect(sent.length).toBeLessThan(80_000);
    expect(sent).toContain('JSON CORTADO');
    // Não pode afirmar "1 de 1 registros" — não houve corte POR REGISTRO, e o JSON está partido.
    expect(sent).not.toContain('1 de 1 registros');
  });

  it('resultado pequeno passa intacto', async () => {
    reply(toolReply([{ id: 't1', name: 'resumo_situacao', input: {} }]), textReply('ok'));
    runToolMock.mockResolvedValueOnce([{ status_name: 'pago', total: '10.00' }]);

    await runChat(supabase, TOKEN, { question: 'x' });

    const sent = lastUserContent(1)[0].content;
    expect(sent).not.toContain('truncado');
    expect(JSON.parse(sent)).toEqual([{ status_name: 'pago', total: '10.00' }]);
  });
});

describe('runChat — teto de iterações (§17.2)', () => {
  it('para no teto e ainda responde com o que apurou, marcando truncated', async () => {
    // Modelo que pede tool indefinidamente: sem teto, isto rodaria até a function morrer.
    replyAlways(toolReply([{ id: 't', name: 'resumo_situacao', input: {} }]));
    runToolMock.mockResolvedValue([{ x: 1 }]);

    const r = await runChat(supabase, TOKEN, { question: 'loop infinito' });

    expect(r.truncated).toBe(true);
    expect(create).toHaveBeenCalledTimes(7); // 6 iterações + 1 fechamento
    // `iterations === MAX_ITERATIONS` é a ASSINATURA da pergunta que estourou o teto no
    // ai_chat_log (migration 102) — sem ela, este run é indistinguível de um limpo com 6 consultas.
    // O fechamento nao conta: ele e implicado por truncated = true.
    expect(r.iterations).toBe(MAX_ITERATIONS);
  });

  it('conta as iterações de um run normal (auditoria do custo)', async () => {
    reply(toolReply([{ id: 't1', name: 'resumo_situacao', input: {} }]), textReply('pronto'));
    runToolMock.mockResolvedValueOnce([{ x: 1 }]);

    const r = await runChat(supabase, TOKEN, { question: 'x' });

    // Duas chamadas ao modelo: a que pediu a tool e a que respondeu.
    expect(r.iterations).toBe(2);
    expect(r.truncated).toBe(false);
  });

  it('o fechamento MANTÉM as tools e usa tool_choice none — omiti-las destruiria o cache', async () => {
    replyAlways(toolReply([{ id: 't', name: 'resumo_situacao', input: {} }]));
    runToolMock.mockResolvedValue([{ x: 1 }]);

    await runChat(supabase, TOKEN, { question: 'loop infinito' });

    const fechamento = snapshotOf(6);
    // Remover o array `tools` é mudança de DEFINIÇÃO de tool: invalida os três níveis de cache
    // (tools + system + messages) justamente na chamada de histórico mais longo. Trocar só o
    // `tool_choice` preserva o cache — e o histórico com blocos tool_use segue acompanhado da
    // definição das tools, como a API espera.
    expect(fechamento.tools).toEqual(snapshotOf(0).tools);
    expect(fechamento.tool_choice).toEqual({ type: 'none' });
  });
});

describe('runChat — contabilidade de tokens', () => {
  it('soma os tokens de CACHE, não só o resto não-cacheado', async () => {
    reply({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 120,
      },
    });

    const r = await runChat(supabase, TOKEN, { question: 'x' });

    // `input_tokens` sozinho diria "10" para um prompt de 4130 tokens. Sem os campos de cache não
    // há como estimar custo nem notar um invalidador silencioso do cache.
    expect(r.inputTokens).toBe(10);
    expect(r.cacheReadTokens).toBe(4000);
    expect(r.cacheCreationTokens).toBe(120);
  });

  it('trata usage sem os campos de cache (turno sem cache) como zero', async () => {
    // O aviso de caching desligado é esperado aqui (é o caminho sob teste); silenciado para não
    // poluir a saída, já que quem o verifica é o describe dedicado abaixo.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Reply explícito SEM os campos: as fixtures padrão agora trazem cache (turno saudável), e é
    // exatamente a ausência que este caso testa — o `?? 0` do acumulador.
    reply({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const r = await runChat(supabase, TOKEN, { question: 'x' });
    expect(r.cacheReadTokens).toBe(0);
    expect(r.cacheCreationTokens).toBe(0);
    err.mockRestore();
  });

  /**
   * O prefixo cacheável CRESCE a cada tool (3.653 tokens com 6 tools em 30/07/2026 → 7.408 com 9
   * em 10/08/2026), então documentar o número não protege: ele envelhece, e o modo de falha —
   * prefixo abaixo do mínimo do modelo — não produz erro nenhum, só custo. Estes casos travam a
   * detecção em runtime, que é o que substitui a conferência manual da coluna.
   */
  describe('detecção de prompt caching desligado', () => {
    const semCache = (stop: string) => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: stop,
      usage: { input_tokens: 4000, output_tokens: 5 },
    });

    it('avisa quando cache_read E cache_creation vêm zerados', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      reply(semCache('end_turn'));

      await runChat(supabase, TOKEN, { question: 'x' });

      expect(err).toHaveBeenCalledTimes(1);
      expect(err.mock.calls[0][0]).toContain('prompt caching NÃO ocorreu');
      // O modelo em vigor precisa aparecer: sem ele o aviso não diz o que trocar de volta.
      expect(err.mock.calls[0][0]).toContain('claude-opus-5');
      err.mockRestore();
    });

    it('NÃO avisa quando o prefixo foi lido do cache', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      reply(textReply('ok')); // fixture padrão = turno saudável
      await runChat(supabase, TOKEN, { question: 'x' });
      expect(err).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it('NÃO avisa quando o prefixo foi CRIADO neste turno (1ª chamada / TTL expirado)', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      reply({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        // Criação sem leitura é o turno que ESTREIA o prefixo — saudável, e o caso que um
        // detector escrito como `cacheRead === 0` sozinho acusaria por engano.
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 7408 },
      });
      await runChat(supabase, TOKEN, { question: 'x' });
      expect(err).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it('também cobre o caminho de FECHAMENTO (teto de iterações)', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      // Sem cache em nenhuma chamada: o turno estoura o teto e sai pelo fechamento, o outro
      // ponto de retorno. Antes do `finish` único, a checagem valeria só para o primeiro.
      replyAlways({
        content: [{ type: 'tool_use', id: 't', name: 'resumo_situacao', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 2 },
      });
      runToolMock.mockResolvedValue([]);

      const r = await runChat(supabase, TOKEN, { question: 'x' });

      expect(r.truncated).toBe(true); // provou que saiu pelo fechamento
      expect(err).toHaveBeenCalledWith(expect.stringContaining('prompt caching NÃO ocorreu'));
      err.mockRestore();
    });
  });

  it('acumula ao longo das iterações, incluindo o fechamento', async () => {
    replyAlways({
      content: [{ type: 'tool_use', id: 't', name: 'resumo_situacao', input: {} }],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
      },
    });
    runToolMock.mockResolvedValue([]);

    const r = await runChat(supabase, TOKEN, { question: 'x' });

    expect(r.inputTokens).toBe(7); // 6 iterações + 1 fechamento
    expect(r.cacheReadTokens).toBe(700);
  });
});

describe('runChat — estado parcial anexado ao erro (auditoria de falha)', () => {
  it('leva os tokens e as tools já executados até a rota', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    reply(
      toolReply([{ id: 't1', name: 'resumo_situacao', input: {} }]),
      new Anthropic.RateLimitError(429, undefined, 'rate_limit', new Headers()),
    );
    runToolMock.mockResolvedValueOnce([{ x: 1 }, { y: 2 }]);

    const erro = await runChat(supabase, TOKEN, { question: 'x' }).catch((e: unknown) => e);
    const parcial = readPartialRun(erro);

    // Sem isto, a falha de uma pergunta que já custou N chamadas é auditada como "0 tokens, 0
    // tools" — e some justamente o registro que revela quais tools faltam.
    expect(parcial).not.toBeNull();
    expect(parcial?.toolCalls).toHaveLength(1);
    expect(parcial?.rowCount).toBe(2);
    expect(parcial?.inputTokens).toBeGreaterThan(0);
    // Onde a pergunta cara parou: a 1ª chamada concluiu (pediu a tool), a 2ª falhou.
    expect(parcial?.iterations).toBe(1);
  });

  it('readPartialRun devolve null para erro sem estado anexado', () => {
    expect(readPartialRun(new Error('qualquer'))).toBeNull();
    expect(readPartialRun(null)).toBeNull();
    expect(readPartialRun('texto')).toBeNull();
  });
});

// O ponto desta feature é PARAR DE GASTAR quando ninguém está mais esperando.
describe('runChat — cancelamento pelo cliente', () => {
  it('não chama o modelo nenhuma vez se o cliente já desistiu', async () => {
    const controller = new AbortController();
    controller.abort();
    reply(textReply('não deveria ser pedido'));

    await expect(
      runChat(supabase, TOKEN, { question: 'x' }, controller.signal),
    ).rejects.toBeInstanceOf(AiChatAbortedError);
    expect(create).not.toHaveBeenCalled();
  });

  it('para no LIMITE da iteração seguinte — não gasta as demais', async () => {
    const controller = new AbortController();
    // 1ª iteração pede tool; a tool aborta (simula o usuário clicando em "Parar" durante a
    // consulta). A 2ª chamada ao modelo — a que custaria de novo — não pode acontecer.
    reply(toolReply([{ id: 't1', name: 'resumo_situacao', input: {} }]), textReply('tarde demais'));
    runToolMock.mockImplementationOnce(async () => {
      controller.abort();
      return [{ x: 1 }];
    });

    const erro = await runChat(supabase, TOKEN, { question: 'x' }, controller.signal)
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(AiChatAbortedError);
    expect(create).toHaveBeenCalledTimes(1);
    // O custo já gasto acompanha o erro: cancelar não devolve tokens, e a auditoria os quer.
    expect(readPartialRun(erro)?.toolCalls).toHaveLength(1);
    expect(readPartialRun(erro)?.inputTokens).toBeGreaterThan(0);
  });

  it('repassa o signal à chamada do modelo (aborta o turno EM VOO)', async () => {
    const controller = new AbortController();
    reply(textReply('ok'));

    await runChat(supabase, TOKEN, { question: 'x' }, controller.signal);

    // 2º argumento de `messages.stream(params, options)`.
    expect(create.mock.calls[0][1]).toEqual({ signal: controller.signal });
  });

  it('sem signal, funciona como antes (parâmetro opcional)', async () => {
    reply(textReply('ok'));
    const res = await runChat(supabase, TOKEN, { question: 'x' });
    expect(res.answer).toBe('ok');
    expect(create.mock.calls[0][1]).toEqual({ signal: undefined });
  });
});

describe('runChat — erros do provedor', () => {
  it('erro do SDK é traduzido antes de subir', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    reply(new Anthropic.RateLimitError(429, undefined, 'rate_limit', new Headers()));

    await expect(runChat(supabase, TOKEN, { question: 'x' })).rejects.toBeInstanceOf(AiChatError);
  });

  it('cancelamento NÃO é traduzido como erro do provedor', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const controller = new AbortController();
    // O SDK, ao ser abortado, levanta o seu próprio erro. Se a classificação fosse pelo TIPO do
    // erro, este caso viraria 500 genérico — auditando um cancelamento como falha do assistente.
    reply(new Anthropic.RateLimitError(429, undefined, 'rate_limit', new Headers()));
    controller.abort();

    const erro = await runChat(supabase, TOKEN, { question: 'x' }, controller.signal)
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(AiChatAbortedError);
    expect((erro as AiChatAbortedError).status).toBe(499);
  });

  it('erro na chamada de FECHAMENTO também é traduzido', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    // 6 iterações pedindo tool, e o fechamento falha: se ele ficasse fora do try, um 429 aqui
    // viraria 500 genérico — justamente na pergunta que já custou 6 chamadas.
    for (let i = 0; i < MAX_ITERATIONS; i += 1) {
      reply(toolReply([{ id: `t${i}`, name: 'resumo_situacao', input: {} }]));
    }
    reply(new Anthropic.RateLimitError(429, undefined, 'rate_limit', new Headers()));
    runToolMock.mockResolvedValue([{ x: 1 }]);

    await expect(runChat(supabase, TOKEN, { question: 'x' })).rejects.toBeInstanceOf(AiChatError);
  });
});

/* ──────────────────────────────────────────────────────────────────────────────────────────────
 * PROGRESSO (ChatProgress) — o que a rota SSE observa.
 *
 * 🔴 O que estes casos protegem é a DECISÃO de arquitetura: não existe um segundo `runChat` para
 * streaming. Se alguém um dia duplicar o loop, o teto de iterações, o pareamento
 * tool_use/tool_result e o acumulador de tokens passam a ter duas cópias — e elas divergem na
 * primeira alteração. Aqui o streaming é observação do MESMO loop, e é isso que se verifica.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */
describe('runChat — callbacks de progresso', () => {
  it('sem `events`, o comportamento é o de antes (nada quebra)', async () => {
    reply(textReply('resposta'));
    const res = await runChat(supabase, TOKEN, { question: 'x' });
    expect(res.answer).toBe('resposta');
  });

  it('emite tool → tool_end → texto, na ordem do turno', async () => {
    reply(toolReply([{ id: 't1', name: 'resumo_situacao', input: {} }]));
    reply(textReply('Você tem R$ 1.000,00.'));
    runToolMock.mockResolvedValue([{ a: 1 }, { a: 2 }]);

    const ordem: string[] = [];
    await runChat(supabase, TOKEN, { question: 'x' }, undefined, {
      onToolStart: (c) => ordem.push(`start:${c.name}`),
      onToolEnd: (c) => ordem.push(`end:${c.name}:${c.rows}`),
      onTextStart: () => ordem.push('text_start'),
      onTextDelta: (t) => ordem.push(`delta:${t}`),
    });

    expect(ordem).toEqual([
      'start:resumo_situacao',
      'end:resumo_situacao:2',
      'text_start',
      'delta:Você tem R$ 1.000,00.',
    ]);
  });

  /**
   * O preâmbulo e a resposta final são mensagens DIFERENTES, e cada uma abre seu próprio bloco de
   * texto. É esse sinal que faz o cliente descartar o buffer — sem ele os dois apareceriam grudados
   * e a tela divergiria do `answer`, que é só o texto da última mensagem.
   */
  it('cada mensagem do assistente abre um novo bloco de texto', async () => {
    reply({
      id: 'm1', type: 'message', role: 'assistant', model: 'x', stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Vou verificar isso.' },
        { type: 'tool_use', id: 't1', name: 'resumo_situacao', input: {} },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    reply(textReply('Você tem R$ 1.000,00.'));
    runToolMock.mockResolvedValue([{ a: 1 }]);

    const eventos: string[] = [];
    await runChat(supabase, TOKEN, { question: 'x' }, undefined, {
      onTextStart: () => eventos.push('START'),
      onTextDelta: (t) => eventos.push(t),
    });

    expect(eventos).toEqual(['START', 'Vou verificar isso.', 'START', 'Você tem R$ 1.000,00.']);
  });

  /** Falha de tool fecha o chip com marca — e sem levar a mensagem interna ao cliente. */
  it('tool que falha emite tool_end com erro genérico, não o detalhe interno', async () => {
    reply(toolReply([{ id: 't1', name: 'resumo_situacao', input: {} }]));
    reply(textReply('segue'));
    runToolMock.mockRejectedValue(new Error('column "foo" does not exist'));

    const fins: Array<{ rows: number; error?: string }> = [];
    await runChat(supabase, TOKEN, { question: 'x' }, undefined, {
      onToolEnd: (c) => fins.push({ rows: c.rows, error: c.error }),
    });

    expect(fins).toEqual([{ rows: 0, error: 'falhou' }]);
    expect(JSON.stringify(fins)).not.toContain('foo');
  });

  /**
   * 🔴 O invariante que sustenta a resiliência inteira: `controller.enqueue` LANÇA quando o cliente
   * já fechou a conexão — o caminho normal de "Parar" e de fechar a aba. Se a exceção subisse, ela
   * abortaria o turno de dentro de um callback, num ponto arbitrário do loop, e pularia a auditoria
   * do que já foi gasto.
   */
  it('callback que LANÇA não derruba o turno', async () => {
    reply(toolReply([{ id: 't1', name: 'resumo_situacao', input: {} }]));
    reply(textReply('resposta apesar de tudo'));
    runToolMock.mockResolvedValue([{ a: 1 }]);
    const erroDoConsole = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const explode = () => { throw new Error('cliente desconectou'); };
    const res = await runChat(supabase, TOKEN, { question: 'x' }, undefined, {
      onToolStart: explode,
      onToolEnd: explode,
      onTextStart: explode,
      onTextDelta: explode,
    });

    expect(res.answer).toBe('resposta apesar de tudo');
    expect(res.iterations).toBe(2);
    expect(erroDoConsole).toHaveBeenCalled(); // a falha do observador é registrada, não engolida
    erroDoConsole.mockRestore();
  });

  /**
   * A chamada de FECHAMENTO (teto de iterações) também streama. É a resposta da pergunta MAIS CARA:
   * sem isto, o usuário veria a tela parada exatamente no turno mais longo — que é quando o
   * streaming importa.
   */
  it('a chamada de fechamento por teto de iterações também emite texto', async () => {
    for (let i = 0; i < MAX_ITERATIONS; i += 1) {
      reply(toolReply([{ id: `t${i}`, name: 'resumo_situacao', input: {} }]));
    }
    reply(textReply('resposta parcial do fechamento'));
    runToolMock.mockResolvedValue([{ x: 1 }]);

    const deltas: string[] = [];
    const res = await runChat(supabase, TOKEN, { question: 'x' }, undefined, {
      onTextDelta: (t) => deltas.push(t),
    });

    expect(res.truncated).toBe(true);
    expect(deltas).toContain('resposta parcial do fechamento');
  });
});
