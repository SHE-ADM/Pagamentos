import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import type { AiChatStreamEvent } from '@sheild/shared';

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
  getBearerToken: vi.fn(),
  getAnonClient: vi.fn(() => ({})),
}));
vi.mock('@/lib/ai-chat/gateway', () => ({ runChat: vi.fn() }));
vi.mock('@/lib/ai-chat/log', () => ({ logInteraction: vi.fn(async () => undefined) }));
vi.mock('@/lib/ai-chat/rate-limit', () => ({ assertWithinRateLimit: vi.fn(async () => undefined) }));
// Mesmo motivo da suíte da rota irmã: sem mockar, o gate real chama getSupabaseAdmin() e a suíte
// inteira fica vermelha por env ausente — falha que aparece longe da causa.
vi.mock('@/lib/ai-chat/gate', async (original) => ({
  ...(await original<typeof import('@/lib/ai-chat/gate')>()),
  assertAiChatAllowed: vi.fn(),
}));

import { POST } from './route';
import { getAuthenticatedUser, getBearerToken } from '@/lib/auth';
import { runChat } from '@/lib/ai-chat/gateway';
import { logInteraction } from '@/lib/ai-chat/log';
import { assertAiChatAllowed, MENSAGEM_SEM_ACESSO } from '@/lib/ai-chat/gate';
import { assertWithinRateLimit } from '@/lib/ai-chat/rate-limit';
import { AiChatError, attachPartialRun } from '@/lib/ai-chat/errors';

const getUser = vi.mocked(getAuthenticatedUser);
const getToken = vi.mocked(getBearerToken);
const chat = vi.mocked(runChat);
const log = vi.mocked(logInteraction);
const gate = vi.mocked(assertAiChatAllowed);
const rateLimit = vi.mocked(assertWithinRateLimit);

const USER = { id: '11111111-1111-1111-1111-111111111111' };

const req = (body: unknown, signal: AbortSignal = new AbortController().signal) =>
  ({ json: async () => body, signal }) as unknown as NextRequest;

const okResult = {
  answer: 'Você tem R$ 1.000,00 em aberto.',
  toolCalls: [{ name: 'resumo_situacao', params: { x: 1 }, rows: 3, ms: 42 }],
  rowCount: 3,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 4000,
  cacheCreationTokens: 0,
  truncated: false,
  iterations: 2,
  model: 'claude-sonnet-5',
};

/** Lê o corpo SSE inteiro e devolve os eventos já parseados. */
async function eventos(res: Response): Promise<AiChatStreamEvent[]> {
  const texto = await res.text();
  return texto
    .split(/\r?\n\r?\n/)
    .filter((f) => f.startsWith('data:'))
    .map((f) => JSON.parse(f.slice(5).trim()) as AiChatStreamEvent);
}

beforeEach(() => {
  vi.clearAllMocks();
  rateLimit.mockResolvedValue(undefined);
  gate.mockResolvedValue({ perHour: null, perDay: null });
  getUser.mockResolvedValue(USER as never);
  getToken.mockReturnValue('jwt-do-usuario');
  chat.mockResolvedValue(okResult);
});

describe('POST /api/ai-chat/stream — a fronteira do status HTTP', () => {
  /**
   * 🔴 Enquanto não houver corpo, o status ainda é utilizável — e é por isso que a sessão, o gate e
   * a cota ficam FORA do ReadableStream. Um 403 de acesso negado precisa chegar como 403, não como
   * um stream de sucesso que por dentro diz que falhou: o cliente decide o fallback pelo
   * content-type, e um "200 + evento de erro" o faria reenviar a pergunta pela rota JSON, cobrando
   * duas vezes por uma recusa.
   */
  it('401 em JSON quando não há sessão — nunca abre o stream', async () => {
    getUser.mockResolvedValue(null as never);
    const res = await POST(req({ question: 'oi tudo bem' }));

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(chat).not.toHaveBeenCalled();
  });

  it('422 em JSON para pergunta inválida', async () => {
    const res = await POST(req({ question: 'ab' }));

    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('403 em JSON quando o grupo não tem acesso, e a tentativa é auditada', async () => {
    gate.mockRejectedValue(new AiChatError(MENSAGEM_SEM_ACESSO, 403));
    const res = await POST(req({ question: 'quanto devo?' }));

    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toMatchObject({ success: false, error: MENSAGEM_SEM_ACESSO });
    // Nada foi gasto...
    expect(chat).not.toHaveBeenCalled();
    // ...mas a tentativa é sinal de uso: é o "quem está pedindo acesso".
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ userId: USER.id }));
  });

  it('429 em JSON quando a cota estourou', async () => {
    rateLimit.mockRejectedValue(new AiChatError('Limite de 30 perguntas por hora.', 429));
    const res = await POST(req({ question: 'quanto devo?' }));

    expect(res.status).toBe(429);
    expect(chat).not.toHaveBeenCalled();
  });

  /** A ordem é a mesma da rota irmã, e por dependência de dados (o rate limit consome o gate). */
  it('o gate roda ANTES do rate limit', async () => {
    const ordem: string[] = [];
    gate.mockImplementation(async () => { ordem.push('gate'); return { perHour: null, perDay: null }; });
    rateLimit.mockImplementation(async () => { ordem.push('rate'); });

    await POST(req({ question: 'quanto devo?' }));

    expect(ordem).toEqual(['gate', 'rate']);
  });
});

describe('POST /api/ai-chat/stream — caminho feliz', () => {
  it('responde 200 com headers de streaming', async () => {
    const res = await POST(req({ question: 'quanto devo?' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
  });

  it('abre com `open` e fecha com `done` trazendo a resposta canônica', async () => {
    const evts = await eventos(await POST(req({ question: 'quanto devo?' })));

    expect(evts[0]).toEqual({ type: 'open' });
    expect(evts.at(-1)).toEqual({
      type: 'done',
      answer: okResult.answer,
      tool_calls: [{ name: 'resumo_situacao', params: { x: 1 }, rows: 3 }],
      truncated: false,
    });
  });

  /** O `ms` e o erro interno das tools não saem daqui — mesma regra da rota JSON. */
  it('o `done` não expõe ms nem erro interno das tools', async () => {
    chat.mockResolvedValue({
      ...okResult,
      toolCalls: [{ name: 'x', params: {}, rows: 0, ms: 10, error: 'SELECT falhou: coluna foo' }],
    });
    const evts = await eventos(await POST(req({ question: 'quanto devo?' })));
    const done = evts.at(-1) as Extract<AiChatStreamEvent, { type: 'done' }>;

    expect(JSON.stringify(done)).not.toContain('coluna foo');
    expect(done.tool_calls[0]).toEqual({ name: 'x', params: {}, rows: 0 });
  });

  /** Repassa o progresso do gateway ao fio, na ordem em que ele acontece. */
  it('emite tool / tool_end / text_start / delta conforme o gateway avança', async () => {
    chat.mockImplementation(async (_s, _t, _r, _sig, events) => {
      events?.onToolStart?.({ name: 'resumo_situacao', params: { mes: 8 } });
      events?.onToolEnd?.({ name: 'resumo_situacao', rows: 3, ms: 12 });
      events?.onTextStart?.();
      events?.onTextDelta?.('Você tem ');
      events?.onTextDelta?.('R$ 1.000,00.');
      return okResult;
    });

    const evts = await eventos(await POST(req({ question: 'quanto devo?' })));

    expect(evts.map((e) => e.type)).toEqual([
      'open', 'tool', 'tool_end', 'text_start', 'delta', 'delta', 'done',
    ]);
    expect(evts[1]).toEqual({ type: 'tool', name: 'resumo_situacao', params: { mes: 8 } });
    expect(evts[2]).toMatchObject({ type: 'tool_end', name: 'resumo_situacao', rows: 3 });
  });

  it('repassa o signal da request ao gateway', async () => {
    const ctrl = new AbortController();
    await POST(req({ question: 'quanto devo?' }, ctrl.signal));

    expect(chat).toHaveBeenCalledWith(
      expect.anything(), 'jwt-do-usuario', expect.anything(), ctrl.signal, expect.anything(),
    );
  });
});

describe('POST /api/ai-chat/stream — auditoria', () => {
  /**
   * 🔴 O invariante §17.3 traduzido para streaming. Em serverless a function é congelada quando o
   * corpo termina; gravar depois de `close()` é gravar em nada. Na rota JSON o marco é o `return`,
   * aqui é o fechamento do stream — e a única forma de provar é observar que, quando o corpo
   * terminou de ser lido, o log JÁ havia sido gravado.
   */
  it('grava a auditoria ANTES de fechar o stream', async () => {
    let logadoAoFechar = false;
    log.mockImplementation(async () => { await Promise.resolve(); });

    const res = await POST(req({ question: 'quanto devo?' }));
    // Consumir o corpo inteiro simula a function chegando ao fim.
    await res.text();
    logadoAoFechar = log.mock.calls.length > 0;

    expect(logadoAoFechar).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER.id,
      question: 'quanto devo?',
      inputTokens: 100,
      cacheReadTokens: 4000,
      truncated: false,
      iterations: 2,
    }));
  });

  it('leva truncated e iterações do gateway, não valores fixos', async () => {
    chat.mockResolvedValue({ ...okResult, truncated: true, iterations: 6 });
    await (await POST(req({ question: 'quanto devo?' }))).text();

    expect(log).toHaveBeenCalledWith(expect.objectContaining({ truncated: true, iterations: 6 }));
  });
});

describe('POST /api/ai-chat/stream — falha DEPOIS de abrir', () => {
  /**
   * 🔴 O motivo de o evento `error` existir. Uma vez enviado o 200 com os headers do SSE, o status
   * HTTP não pode mais comunicar erro nenhum — e o gateway falha justamente no meio do trabalho
   * (429 do provedor, 503, timeout). Sem este evento, a falha chegaria como um stream que
   * simplesmente termina: tela vazia, sem explicação e sem nada a tentar.
   */
  it('vira evento `error` com a mensagem curada e o status', async () => {
    chat.mockRejectedValue(new AiChatError('O assistente está indisponível. Tente em instantes.', 503));

    const res = await POST(req({ question: 'quanto devo?' }));
    expect(res.status).toBe(200); // já foi enviado — é justamente o ponto

    const evts = await eventos(res);
    expect(evts.at(-1)).toEqual({
      type: 'error',
      message: 'O assistente está indisponível. Tente em instantes.',
      status: 503,
    });
  });

  /** Mesma regra de eco da rota JSON, pelo MESMO helper: 5xx não-curado não vaza detalhe. */
  it('erro não curado vira mensagem genérica, sem vazar detalhe interno', async () => {
    chat.mockRejectedValue(new Error('column "foo" does not exist'));

    const evts = await eventos(await POST(req({ question: 'quanto devo?' })));
    const erro = evts.at(-1) as Extract<AiChatStreamEvent, { type: 'error' }>;

    expect(erro.type).toBe('error');
    expect(erro.status).toBe(500);
    expect(erro.message).toBe('Erro interno ao processar a solicitação');
    expect(JSON.stringify(evts)).not.toContain('foo');
  });

  it('a falha é auditada com o que JÁ havia sido gasto, não com zeros', async () => {
    chat.mockRejectedValue(attachPartialRun(new AiChatError('Muitas requisições.', 429), {
      inputTokens: 900, outputTokens: 120, cacheReadTokens: 7000, cacheCreationTokens: 0,
      toolCalls: [{ name: 'resumo_situacao', params: {}, rows: 3, ms: 20 }], rowCount: 3, iterations: 5, model: 'claude-sonnet-5',
    }));

    await (await POST(req({ question: 'pergunta cara' }))).text();

    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      inputTokens: 900,
      cacheReadTokens: 7000,
      iterations: 5,
      error: 'Muitas requisições.',
    }));
  });

  /** Não pode ficar preso: mesmo com erro, o corpo termina. */
  it('o stream é fechado depois do erro', async () => {
    chat.mockRejectedValue(new Error('qualquer coisa'));
    const res = await POST(req({ question: 'quanto devo?' }));

    // `text()` só resolve se o corpo tiver sido fechado — um stream aberto penduraria aqui.
    await expect(res.text()).resolves.toContain('"type":"error"');
  });
});
