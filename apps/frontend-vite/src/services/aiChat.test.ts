import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocka o cliente HTTP compartilhado: aqui o que interessa é o CONTRATO enviado à rota
// (histórico par/alternado) e a tradução do timeout, não o fetch.
const dataApiCall = vi.fn();
vi.mock('./dataApi', () => ({ dataApiCall: (...a: unknown[]) => dataApiCall(...a) }));

import { AiChatCancelledError, askAiChat, buildHistory, type AiChatMessage, type ChatEntry } from './aiChat';

const u = (content: string): AiChatMessage => ({ role: 'user', content });
const a = (content: string): AiChatMessage => ({ role: 'assistant', content });

describe('buildHistory', () => {
  it('conversa vazia devolve histórico vazio', () => {
    expect(buildHistory([])).toEqual([]);
  });

  it('mantém pares completos na ordem original', () => {
    expect(buildHistory([u('p1'), a('r1'), u('p2'), a('r2')])).toEqual([
      u('p1'), a('r1'), u('p2'), a('r2'),
    ]);
  });

  // A rota rejeita com 422 histórico ímpar ou fora da alternância — a pergunta pendente
  // (ou a que falhou, que nunca ganha resposta) precisa ficar de fora.
  it('descarta a pergunta sem resposta no fim', () => {
    expect(buildHistory([u('p1'), a('r1'), u('pendente')])).toEqual([u('p1'), a('r1')]);
  });

  it('só uma pergunta, sem resposta: histórico vazio', () => {
    expect(buildHistory([u('p1')])).toEqual([]);
  });

  it('corta em 8 mensagens, preservando as trocas mais RECENTES', () => {
    const long = [
      u('p1'), a('r1'), u('p2'), a('r2'), u('p3'), a('r3'), u('p4'), a('r4'), u('p5'), a('r5'),
    ];
    const history = buildHistory(long);
    expect(history).toHaveLength(8);
    expect(history[0]).toEqual(u('p2'));
    expect(history[7]).toEqual(a('r5'));
  });

  it('sempre alterna user/assistant e tem tamanho par', () => {
    const history = buildHistory([a('orfã'), u('p1'), a('r1'), u('p2')]);
    expect(history.length % 2).toBe(0);
    history.forEach((m, i) => expect(m.role).toBe(i % 2 === 0 ? 'user' : 'assistant'));
  });

  // Achado do code review: o widget passa as PRÓPRIAS entradas da conversa, que carregam
  // `toolCalls`/`truncated` nas respostas. Sem normalizar aqui, esses campos viajariam dentro de
  // cada item de `history` no corpo do POST — o Zod da rota os descartaria, mas o payload deve
  // conter exatamente o que o contrato declara.
  it('normaliza as mensagens: só role e content chegam ao histórico', () => {
    // Tipado como ChatEntry (o que o widget realmente passa) — `buildHistory` recebe o supertipo
    // AiChatMessage, e é justamente essa diferença que precisa desaparecer no retorno.
    const conversa: ChatEntry[] = [
      u('p1'),
      {
        role: 'assistant',
        content: 'r1',
        toolCalls: [{ name: 'resumo_situacao', params: {}, rows: 3 }],
        truncated: true,
      },
    ];
    const history = buildHistory(conversa);
    expect(history).toEqual([u('p1'), a('r1')]);
    expect(Object.keys(history[1])).toEqual(['role', 'content']);
  });
});

/** Corpo JSON enviado à rota na chamada `n` (tipado: `RequestInit.body` é união demais). */
function sentBody(n = 0): Record<string, unknown> {
  const [, init] = dataApiCall.mock.calls[n] as [string, { method: string; body: string }];
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe('askAiChat', () => {
  // CORPO EM BLOCO, não `() => mock.mockReset()` (não regredir): `mockReset()` DEVOLVE o próprio
  // mock, e o Vitest interpreta um retorno de função num hook como TEARDOWN — ao fim do teste ele
  // chamaria o mock sem argumentos. Com `mockRejectedValue` ativo, esse chamado gera uma rejeição
  // que ninguém trata, e o teste falha com a mensagem do erro em vez da asserção.
  beforeEach(() => {
    dataApiCall.mockReset();
  });

  it('envia a pergunta e devolve resposta + tools + truncated', async () => {
    dataApiCall.mockResolvedValue({
      success: true,
      data: { answer: 'ok', tool_calls: [{ name: 'resumo_situacao', params: {}, rows: 3 }], truncated: false },
    });

    const res = await askAiChat('como estamos?');

    expect(res).toEqual({
      answer: 'ok',
      tool_calls: [{ name: 'resumo_situacao', params: {}, rows: 3 }],
      truncated: false,
    });
    const [path, init] = dataApiCall.mock.calls[0] as [string, { method: string }];
    expect(path).toBe('/ai-chat');
    expect(init.method).toBe('POST');
    expect(sentBody()).toEqual({ question: 'como estamos?' });
  });

  it('omite o campo history quando não há par completo', async () => {
    dataApiCall.mockResolvedValue({ success: true, data: { answer: 'ok', tool_calls: [], truncated: false } });
    await askAiChat('p2', [u('p1')]);
    expect(sentBody()).not.toHaveProperty('history');
  });

  it('envia o histórico recortado quando há par completo', async () => {
    dataApiCall.mockResolvedValue({ success: true, data: { answer: 'ok', tool_calls: [], truncated: false } });
    await askAiChat('p2', [u('p1'), a('r1')]);
    expect(sentBody().history).toEqual([u('p1'), a('r1')]);
  });

  // Achado do code review: sem esta guarda, uma resposta sem texto utilizável renderizaria um
  // BALÃO EM BRANCO na conversa — o usuário leria "o assistente não respondeu" sem nada explicando.
  // O gateway garante texto de fallback, então cair aqui é contrato quebrado, não resposta legítima.
  it.each([
    ['sem data', { success: true }],
    ['answer ausente', { success: true, data: { tool_calls: [], truncated: false } }],
    ['answer vazio', { success: true, data: { answer: '   ', tool_calls: [], truncated: false } }],
    ['answer não-string', { success: true, data: { answer: 42, tool_calls: [], truncated: false } }],
  ])('resposta inválida (%s) vira erro legível', async (_label, envelope) => {
    dataApiCall.mockResolvedValue(envelope);
    await expect(askAiChat('x')).rejects.toThrow(/vazia/i);
  });

  // Sem esta tradução o usuário veria a mensagem nativa do AbortSignal ("signal is aborted
  // without reason").
  it('timeout do cliente vira mensagem em pt-BR', async () => {
    dataApiCall.mockRejectedValue(new DOMException('signal timed out', 'TimeoutError'));
    await expect(askAiChat('x')).rejects.toThrow(/demorou demais/i);
  });

  it('erro curado do backend sobe intacto', async () => {
    dataApiCall.mockRejectedValue(new Error('Muitas requisições. Aguarde um instante.'));
    await expect(askAiChat('x')).rejects.toThrow('Muitas requisições. Aguarde um instante.');
  });

  // Os DOIS abortos chegam como DOMException e precisam de destinos diferentes: tratá-los juntos
  // fazia o cancelamento do usuário aparecer como "a consulta demorou demais".
  it('abort do usuário vira AiChatCancelledError, não mensagem de timeout', async () => {
    dataApiCall.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const erro = await askAiChat('x').catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(AiChatCancelledError);
    expect((erro as Error).message).not.toMatch(/demorou/i);
  });

  // Prova que o signal externo é COMBINADO ao teto de tempo (AbortSignal.any) e chega ao fetch:
  // se o `signal` recebido fosse ignorado, o abort não teria efeito e a promessa nunca resolveria.
  it('propaga o cancelamento do chamador até a requisição', async () => {
    dataApiCall.mockImplementation(
      (_path: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('a', 'AbortError')));
        }),
    );
    const controller = new AbortController();

    const pendente = askAiChat('x', [], controller.signal);
    controller.abort();

    await expect(pendente).rejects.toBeInstanceOf(AiChatCancelledError);
  });
});
