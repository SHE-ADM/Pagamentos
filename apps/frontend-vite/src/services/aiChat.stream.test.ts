import { describe, it, expect, vi, beforeEach } from 'vitest';

// `dataApiFetch` devolve a Response CRUA (é o que o SSE precisa); `dataApiCall` é o caminho JSON,
// usado aqui para provar quando o fallback dispara — e, principalmente, quando NÃO dispara.
const dataApiFetch = vi.fn();
const dataApiCall = vi.fn();
vi.mock('./dataApi', () => ({
  dataApiFetch: (...a: unknown[]) => dataApiFetch(...a),
  dataApiCall: (...a: unknown[]) => dataApiCall(...a),
}));

import { AiChatCancelledError, askAiChatStream } from './aiChat';

// `.at(-1)` exige lib es2022; o tsconfig deste app e anterior e o typecheck reprovaria (TS2550).
const ultimo = (a: readonly string[]): string | undefined => a[a.length - 1];

/**
 * Resposta SSE falsa a partir de PEDAÇOS ARBITRÁRIOS de texto.
 *
 * Os pedaços são enfileirados como chegariam da rede — e é essa a graça: um chunk de TCP não
 * respeita a fronteira do frame, então o parser tem de remontar. Passar frames inteiros esconderia
 * exatamente o bug que este helper existe para expor.
 */
function sseResponse(pedacos: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const p of pedacos) c.enqueue(enc.encode(p));
      c.close();
    },
  });
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });
}

const frame = (evento: unknown): string => `data: ${JSON.stringify(evento)}\n\n`;

const DONE = frame({ type: 'done', answer: 'resposta final', tool_calls: [], truncated: false });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('askAiChatStream — consumo do stream', () => {
  it('devolve a resposta canônica do evento `done`', async () => {
    dataApiFetch.mockResolvedValue(sseResponse([frame({ type: 'open' }), DONE]));

    const res = await askAiChatStream('quanto devo?', []);

    expect(res).toEqual({ answer: 'resposta final', tool_calls: [], truncated: false });
  });

  it('alimenta os handlers de texto, ferramenta e conclusão', async () => {
    dataApiFetch.mockResolvedValue(sseResponse([
      frame({ type: 'open' }),
      frame({ type: 'tool', name: 'resumo_situacao', params: { mes: 8 } }),
      frame({ type: 'tool_end', name: 'resumo_situacao', rows: 3, ms: 12 }),
      frame({ type: 'text_start' }),
      frame({ type: 'delta', text: 'Você tem ' }),
      frame({ type: 'delta', text: 'R$ 1.000,00.' }),
      DONE,
    ]));

    const textos: string[] = [];
    const tools: string[] = [];
    const fins: Array<[string, number]> = [];

    await askAiChatStream('quanto devo?', [], {
      onText: (t) => textos.push(t),
      onTool: (n) => tools.push(n),
      onToolEnd: (n, rows) => fins.push([n, rows]),
    });

    // O texto chega ACUMULADO — o consumidor renderiza o buffer, não concatena por conta própria.
    expect(textos).toEqual(['', 'Você tem ', 'Você tem R$ 1.000,00.']);
    expect(tools).toEqual(['resumo_situacao']);
    expect(fins).toEqual([['resumo_situacao', 3]]);
  });

  /**
   * 🔴 O motivo de `text_start` existir. O modelo escreve um preâmbulo ("vou verificar isso"), pede
   * a ferramenta e só então redige a resposta. Sem o reinício, os dois apareceriam grudados e a
   * tela divergiria do `answer` final — que é apenas o texto da ÚLTIMA mensagem.
   */
  it('`text_start` DESCARTA o texto anterior em vez de concatenar', async () => {
    dataApiFetch.mockResolvedValue(sseResponse([
      frame({ type: 'text_start' }),
      frame({ type: 'delta', text: 'Vou verificar isso.' }),
      frame({ type: 'tool', name: 'resumo_situacao', params: {} }),
      frame({ type: 'text_start' }),
      frame({ type: 'delta', text: 'Você tem R$ 1.000,00.' }),
      DONE,
    ]));

    const textos: string[] = [];
    await askAiChatStream('quanto devo?', [], { onText: (t) => textos.push(t) });

    expect(ultimo(textos)).toBe('Você tem R$ 1.000,00.');
    expect(ultimo(textos)).not.toContain('Vou verificar');
  });

  /**
   * 🔴 O caso que um teste com frames inteiros NUNCA pegaria: a rede parte o payload onde quiser,
   * inclusive no meio de um JSON ou entre os dois `\n` do separador.
   */
  it('remonta frames partidos entre chunks da rede', async () => {
    const inteiro = frame({ type: 'delta', text: 'texto completo' }) + DONE;
    // Corta em pedaços de 7 bytes — garante corte no meio do JSON e no meio do separador.
    const pedacos: string[] = [];
    for (let i = 0; i < inteiro.length; i += 7) pedacos.push(inteiro.slice(i, i + 7));
    dataApiFetch.mockResolvedValue(sseResponse(pedacos));

    const textos: string[] = [];
    const res = await askAiChatStream('q', [], { onText: (t) => textos.push(t) });

    expect(ultimo(textos)).toBe('texto completo');
    expect(res.answer).toBe('resposta final');
  });

  it('aceita CRLF como separador', async () => {
    dataApiFetch.mockResolvedValue(sseResponse([
      'data: {"type":"delta","text":"com crlf"}\r\n\r\n',
      `data: ${JSON.stringify({ type: 'done', answer: 'ok', tool_calls: [], truncated: false })}\r\n\r\n`,
    ]));

    const textos: string[] = [];
    const res = await askAiChatStream('q', [], { onText: (t) => textos.push(t) });

    expect(ultimo(textos)).toBe('com crlf');
    expect(res.answer).toBe('ok');
  });

  it('ignora heartbeat, frame corrompido e evento desconhecido — sem derrubar a conversa', async () => {
    dataApiFetch.mockResolvedValue(sseResponse([
      ': keep-alive\n\n',
      'data: {isso não é json}\n\n',
      frame({ type: 'inventado_no_futuro', o: 1 }),
      frame({ type: 'delta', text: 'sobrevivi' }),
      DONE,
    ]));

    const textos: string[] = [];
    const res = await askAiChatStream('q', [], { onText: (t) => textos.push(t) });

    expect(ultimo(textos)).toBe('sobrevivi');
    expect(res.answer).toBe('resposta final');
  });
});

describe('askAiChatStream — falhas', () => {
  it('evento `error` vira Error com a mensagem curada do servidor', async () => {
    dataApiFetch.mockResolvedValue(sseResponse([
      frame({ type: 'open' }),
      frame({ type: 'error', message: 'Muitas requisições. Aguarde um instante.', status: 429 }),
    ]));

    await expect(askAiChatStream('q', [])).rejects.toThrow('Muitas requisições. Aguarde um instante.');
  });

  /**
   * 🔴 Stream que acaba sem `done` nem `error` = conexão cortada no meio. O texto parcial NÃO é
   * promovido a resposta: o `answer` do `done` é o que vai para o histórico enviado ao modelo na
   * próxima pergunta, e um texto truncado ali envenenaria a conversa seguinte em silêncio.
   */
  it('stream interrompido antes do `done` falha, sem promover o texto parcial', async () => {
    dataApiFetch.mockResolvedValue(sseResponse([
      frame({ type: 'text_start' }),
      frame({ type: 'delta', text: 'metade da resp' }),
    ]));

    await expect(askAiChatStream('q', [])).rejects.toThrow(/interrompida/i);
  });

  it('cancelamento vira AiChatCancelledError, não erro genérico', async () => {
    dataApiFetch.mockRejectedValue(new DOMException('abortado', 'AbortError'));

    await expect(askAiChatStream('q', [])).rejects.toBeInstanceOf(AiChatCancelledError);
  });
});

describe('askAiChatStream — política de fallback', () => {
  const respostaJson = { answer: 'veio pelo JSON', tool_calls: [], truncated: false };

  it('404 (rota inexistente no deploy) cai para a rota JSON', async () => {
    dataApiFetch.mockResolvedValue(new Response('não achei', { status: 404 }));
    dataApiCall.mockResolvedValue({ success: true, data: respostaJson });

    const res = await askAiChatStream('q', []);

    expect(res.answer).toBe('veio pelo JSON');
    expect(dataApiCall).toHaveBeenCalledTimes(1);
  });

  it('200 sem content-type de streaming (proxy transformou o corpo) cai para a rota JSON', async () => {
    dataApiFetch.mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    dataApiCall.mockResolvedValue({ success: true, data: respostaJson });

    const res = await askAiChatStream('q', []);

    expect(res.answer).toBe('veio pelo JSON');
    expect(dataApiCall).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 O invariante mais importante desta seção, e o que torna a política ESTREITA de propósito.
   * Reenviar um 403 pela rota JSON faria a MESMA pergunta rodar duas vezes: o usuário pagaria dois
   * turnos e o `ai_chat_log` registraria duas tentativas — sendo que a segunda vai reencontrar
   * exatamente o motivo que barrou a primeira.
   */
  it.each([
    [403, 'Seu grupo não tem acesso ao assistente.'],
    [429, 'Limite de 30 perguntas por hora.'],
    [500, 'Erro interno ao processar a solicitação'],
  ])('status %i NÃO cai para o JSON — sobe como erro', async (status, mensagem) => {
    dataApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: mensagem }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(askAiChatStream('q', [])).rejects.toThrow(mensagem);
    expect(dataApiCall).not.toHaveBeenCalled();
  });
});
