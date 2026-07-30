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
    messages = {
      stream: (...a: unknown[]) => {
        const p = create(...a);
        return { finalMessage: () => p };
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

const textReply = (text: string) => ({
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
});

const toolReply = (calls: { id: string; name: string; input: unknown }[]) => ({
  content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
  stop_reason: 'tool_use',
  usage: { input_tokens: 20, output_tokens: 8 },
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
      usage: { input_tokens: 10, output_tokens: 8192 },
    });

    const r = await runChat(supabase, TOKEN, { question: 'x' });
    // Sem isso, uma frase pela metade chegaria ao usuário como resposta completa.
    expect(r.truncated).toBe(true);
    expect(r.answer).toContain('8.33');
  });

  it('turno sem bloco de texto devolve aviso, não string vazia', async () => {
    reply({ content: [], stop_reason: 'max_tokens', usage: { input_tokens: 10, output_tokens: 1 } });
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
    reply(textReply('ok'));
    const r = await runChat(supabase, TOKEN, { question: 'x' });
    expect(r.cacheReadTokens).toBe(0);
    expect(r.cacheCreationTokens).toBe(0);
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
