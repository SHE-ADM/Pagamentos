import { describe, it, expect } from 'vitest';
import { isAiChatStreamEvent, AI_CHAT_STREAM_MIME } from './ai-chat-stream';

describe('AI_CHAT_STREAM_MIME', () => {
  /**
   * O cliente decide entre "consumir como stream" e "cair para a rota JSON" comparando o
   * content-type com esta constante. Se ela divergisse do que o servidor envia, todo turno cairia
   * no fallback — funcionando, mas sem streaming nenhum, e sem nada acusando.
   */
  it('é o MIME que o servidor declara nos headers', () => {
    expect(AI_CHAT_STREAM_MIME).toBe('text/event-stream');
  });
});

describe('isAiChatStreamEvent', () => {
  it.each([
    { type: 'open' },
    { type: 'text_start' },
    { type: 'tool', name: 'resumo_situacao', params: {} },
    { type: 'tool_end', name: 'resumo_situacao', rows: 3, ms: 12 },
    { type: 'tool_end', name: 'x', rows: 0, ms: 1, error: 'falhou' },
    { type: 'delta', text: 'algum texto' },
    { type: 'done', answer: 'resposta', tool_calls: [], truncated: false },
    { type: 'error', message: 'deu ruim', status: 500 },
  ])('aceita o evento %j', (evento) => {
    expect(isAiChatStreamEvent(evento)).toBe(true);
  });

  it.each([
    ['null', null],
    ['string', 'delta'],
    ['número', 42],
    ['objeto sem type', { text: 'oi' }],
    ['type não-string', { type: 7 }],
    ['delta sem text', { type: 'delta' }],
    ['delta com text numérico', { type: 'delta', text: 12 }],
    ['tool sem name', { type: 'tool', params: {} }],
    ['tool_end sem rows', { type: 'tool_end', name: 'x' }],
    ['done sem answer', { type: 'done', tool_calls: [] }],
    ['error sem message', { type: 'error', status: 500 }],
  ])('recusa %s', (_rotulo, valor) => {
    expect(isAiChatStreamEvent(valor)).toBe(false);
  });

  /**
   * Um servidor mais novo que o cliente (deploy em andamento, aba aberta há horas) pode emitir um
   * evento que este código ainda não conhece. Descartar o frame e seguir lendo é o comportamento
   * correto — lançar derrubaria a conversa inteira por causa de um evento que nem era necessário.
   */
  it('recusa evento desconhecido em vez de lançar', () => {
    expect(() => isAiChatStreamEvent({ type: 'inventado_no_futuro' })).not.toThrow();
    expect(isAiChatStreamEvent({ type: 'inventado_no_futuro' })).toBe(false);
  });
});
