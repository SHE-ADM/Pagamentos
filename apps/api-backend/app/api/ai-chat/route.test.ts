import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: vi.fn(),
  getBearerToken: vi.fn(),
  getAnonClient: vi.fn(() => ({})),
}));
vi.mock('@/lib/ai-chat/gateway', () => ({ runChat: vi.fn() }));
vi.mock('@/lib/ai-chat/log', () => ({ logInteraction: vi.fn(async () => undefined) }));

import { POST } from './route';
import { getAuthenticatedUser, getBearerToken } from '@/lib/auth';
import { runChat } from '@/lib/ai-chat/gateway';
import { logInteraction } from '@/lib/ai-chat/log';
import { AiChatError, attachPartialRun } from '@/lib/ai-chat/errors';

const getUser = vi.mocked(getAuthenticatedUser);
const getToken = vi.mocked(getBearerToken);
const chat = vi.mocked(runChat);
const log = vi.mocked(logInteraction);

const USER = { id: '11111111-1111-1111-1111-111111111111' };
const req = (body: unknown) =>
  ({ json: async () => body }) as unknown as NextRequest;

const okResult = {
  answer: 'Você tem R$ 1.000,00 em aberto.',
  toolCalls: [{ name: 'resumo_situacao', params: {}, rows: 3, ms: 42 }],
  rowCount: 3,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 4000,
  cacheCreationTokens: 0,
  truncated: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue(USER as never);
  getToken.mockReturnValue('jwt-do-usuario');
});

describe('POST /api/ai-chat — autenticação', () => {
  it('401 sem sessão', async () => {
    getUser.mockResolvedValue(null);
    const res = await POST(req({ question: 'quanto devo?' }));
    expect(res.status).toBe(401);
    expect(chat).not.toHaveBeenCalled();
  });

  it('401 quando há usuário mas não há token (a RLS depende dele)', async () => {
    getToken.mockReturnValue(null);
    const res = await POST(req({ question: 'quanto devo?' }));
    expect(res.status).toBe(401);
    expect(chat).not.toHaveBeenCalled();
  });
});

describe('POST /api/ai-chat — validação', () => {
  it('400 para corpo que não é JSON', async () => {
    const bad = {
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    } as unknown as NextRequest;
    expect((await POST(bad)).status).toBe(400);
  });

  it('422 para pergunta curta demais', async () => {
    const res = await POST(req({ question: 'oi' }));
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ success: false });
  });

  it('422 para pergunta ausente', async () => {
    expect((await POST(req({}))).status).toBe(422);
  });

  it('422 para histórico longo demais', async () => {
    const history = Array.from({ length: 21 }, () => ({ role: 'user' as const, content: 'x' }));
    expect((await POST(req({ question: 'quanto devo?', history }))).status).toBe(422);
  });

  it('aceita histórico que alterna e termina no assistente', async () => {
    chat.mockResolvedValue(okResult);
    const history = [
      { role: 'user', content: 'quanto devo?' },
      { role: 'assistant', content: 'R$ 100,00' },
    ];
    expect((await POST(req({ question: 'e no mês passado?', history }))).status).toBe(200);
  });

  it('422 para histórico ímpar — colaria dois `user` e viraria 400 do provedor', async () => {
    const history = [{ role: 'user', content: 'quanto devo?' }];
    const res = await POST(req({ question: 'e agora?', history }));
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringMatching(/alternar/i) });
    expect(chat).not.toHaveBeenCalled();
  });

  it('422 para histórico fora de ordem (assistant primeiro)', async () => {
    const history = [
      { role: 'assistant', content: 'oi' },
      { role: 'user', content: 'quanto devo?' },
    ];
    expect((await POST(req({ question: 'e agora?', history }))).status).toBe(422);
  });
});

describe('POST /api/ai-chat — caminho feliz', () => {
  it('200 com envelope { success, data } e o token repassado ao gateway', async () => {
    chat.mockResolvedValue(okResult);

    const res = await POST(req({ question: 'quanto tenho em aberto?' }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: true,
      data: {
        answer: 'Você tem R$ 1.000,00 em aberto.',
        tool_calls: [{ name: 'resumo_situacao', params: {}, rows: 3 }],
        truncated: false,
      },
    });
    // O JWT do usuário chega ao gateway — é o que faz a RLS valer.
    expect(chat).toHaveBeenCalledWith(expect.anything(), 'jwt-do-usuario', {
      question: 'quanto tenho em aberto?',
    });
  });

  it('não expõe ms nem o erro interno das tools na resposta', async () => {
    chat.mockResolvedValue({
      ...okResult,
      toolCalls: [{ name: 'x', params: {}, rows: 0, ms: 9, error: 'relation "y" does not exist' }],
    });

    const body = await (await POST(req({ question: 'pergunta válida' }))).json();
    expect(JSON.stringify(body)).not.toContain('does not exist');
    expect(JSON.stringify(body)).not.toContain('"ms"');
  });
});

describe('POST /api/ai-chat — auditoria (§17.3)', () => {
  it('grava o log ANTES de responder, e aguarda (em serverless o fire-and-forget se perde)', async () => {
    chat.mockResolvedValue(okResult);
    await POST(req({ question: 'quanto tenho em aberto?' }));

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER.id,
        question: 'quanto tenho em aberto?',
        rowCount: 3,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 4000,
      }),
    );
    // Aguardado: a promise já resolveu quando a resposta saiu.
    expect(log.mock.results[0].value).resolves.toBeUndefined();
  });

  it('audita TAMBÉM a pergunta que falhou — é dela que sai "quais tools faltam"', async () => {
    chat.mockRejectedValue(new AiChatError('O assistente está sobrecarregado.', 429));

    const res = await POST(req({ question: 'pergunta que falha' }));

    expect(res.status).toBe(429);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'pergunta que falha', error: expect.any(String) }),
    );
  });

  it('registra o que a falha JÁ havia gasto, não zeros', async () => {
    // O gateway anexa o estado parcial ao erro. Zerar aqui faria a falha de uma pergunta cara
    // (5 iterações antes do 429) ser auditada como se nada tivesse sido consumido.
    const erro = attachPartialRun(new AiChatError('sobrecarregado', 429), {
      inputTokens: 900,
      outputTokens: 120,
      cacheReadTokens: 4000,
      cacheCreationTokens: 0,
      toolCalls: [{ name: 'resumo_situacao', params: {}, rows: 3, ms: 12 }],
      rowCount: 3,
    });
    chat.mockRejectedValue(erro);

    await POST(req({ question: 'pergunta cara que falhou' }));

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 900,
        outputTokens: 120,
        cacheReadTokens: 4000,
        rowCount: 3,
        toolCalls: [expect.objectContaining({ name: 'resumo_situacao' })],
      }),
    );
  });

  it('erro não curado vira 500 genérico, sem vazar detalhe', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    chat.mockRejectedValue(new Error('ANTHROPIC_API_KEY inválida: sk-ant-abc'));

    const res = await POST(req({ question: 'pergunta válida' }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe('Erro interno ao processar a solicitação');
    expect(JSON.stringify(body)).not.toContain('sk-ant');
  });
});
