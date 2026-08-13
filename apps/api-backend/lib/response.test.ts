import { describe, it, expect, vi, afterEach } from 'vitest';
import { ok, fail, failFromError } from './response';
import { ApiServiceError } from './api-error';
import { ContaServiceError } from './contas';
import { PythonBridgeError } from './python-bridge';

describe('response envelope', () => {
  it('ok() envelopa data com success=true e meta opcional', async () => {
    const res = ok({ a: 1 }, { total: 10 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, data: { a: 1 }, meta: { total: 10 } });
  });

  it('ok() sem meta omite a chave', async () => {
    const res = ok({ a: 1 });
    const body = await res.json();
    expect(body).toEqual({ success: true, data: { a: 1 } });
  });

  it('fail() retorna success=false com o status informado', async () => {
    const res = fail('boom', 422);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: 'boom' });
  });

  it('fail() usa status 400 por padrão', () => {
    expect(fail('x').status).toBe(400);
  });
});

// A regra central: a mensagem só chega ao cliente quando o erro é NOSSO (ApiServiceError) e o
// status é < 500. Qualquer outra coisa vira genérico + log. Ver o cabeçalho de lib/api-error.ts.
describe('failFromError', () => {
  const GENERIC = 'Erro interno ao processar a solicitação';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function silenceConsole() {
    return vi.spyOn(console, 'error').mockImplementation(() => {});
  }

  it('ecoa a mensagem curada de um ApiServiceError 4xx', async () => {
    const res = failFromError(new ContaServiceError('Conta não encontrada', 404), 'contas');
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: 'Conta não encontrada',
    });
  });

  it('preserva o status 4xx exato (409 de UNIQUE, 422 de Zod)', async () => {
    expect(failFromError(new ContaServiceError('CNPJ já cadastrado', 409)).status).toBe(409);
    expect(failFromError(new ContaServiceError('Informe o centro de custo', 422)).status).toBe(422);
  });

  it('NÃO ecoa a mensagem de um ApiServiceError 5xx — vai só para o log', async () => {
    const spy = silenceConsole();
    const res = failFromError(new ContaServiceError('relation "x" does not exist', 500), 'contas');
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ success: false, error: GENERIC });
    expect(spy).toHaveBeenCalledWith('[contas] 500:', 'relation "x" does not exist');
  });

  // --- `clientSafe`: o eco em 5xx é opt-in, e NÃO desliga o log ---

  it('5xx marcado clientSafe ecoa a mensagem E continua sendo logado', async () => {
    const spy = silenceConsole();
    // A marca resolve o que o USUÁRIO lê. O operador continua precisando ver que houve uma falha
    // de servidor: sem o log, uma indisponibilidade do provedor atinge todo mundo em silêncio —
    // hoje só o chat de IA usa a marca, e ele grava a própria trilha, mas isso é acidente do
    // consumidor, não garantia deste helper.
    const res = failFromError(
      new ApiServiceError('O assistente está indisponível no momento.', 503, 'AiChatError', true),
      'ai-chat',
    );

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: 'O assistente está indisponível no momento.',
    });
    expect(spy).toHaveBeenCalledWith(
      '[ai-chat] 503 (curado, ecoado):',
      'O assistente está indisponível no momento.',
    );
  });

  it('4xx curado NÃO é logado — ali o erro é do pedido, não do servidor', async () => {
    const spy = silenceConsole();
    failFromError(new ContaServiceError('Conta não encontrada', 404), 'contas');
    expect(spy).not.toHaveBeenCalled();
  });

  it('preserva os status 502/504 da ponte Python, sem ecoar a mensagem', async () => {
    silenceConsole();
    const res = failFromError(new PythonBridgeError('ECONNREFUSED 127.0.0.1:8000', 502), 'emails');
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ success: false, error: GENERIC });
  });

  // --- O ponto da mudança: erro de TERCEIRO nunca vaza, mesmo carregando status 4xx ---

  it('não vaza a mensagem de um erro de terceiro com status 4xx (formato de AuthError)', async () => {
    const spy = silenceConsole();
    // Mesmo shape do AuthError do @supabase/auth-js: Error com `status` numérico < 500.
    class AuthErrorLike extends Error {
      status = 400;
      constructor(msg: string) {
        super(msg);
        this.name = 'AuthApiError';
      }
    }

    const res = failFromError(new AuthErrorLike('Invalid login credentials'), 'auth');

    // Antes da base explícita, isto respondia 400 com a mensagem em inglês do provider.
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ success: false, error: GENERIC });
    expect(spy).toHaveBeenCalledWith(
      '[auth] 500 (erro não curado):',
      'AuthApiError: Invalid login credentials',
    );
  });

  it('não vaza a mensagem de um erro de terceiro com status 404 (formato de StorageApiError)', async () => {
    silenceConsole();
    class StorageErrorLike extends Error {
      status = 404;
    }
    const res = failFromError(new StorageErrorLike('Object not found'), 'attachments');
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ success: false, error: GENERIC });
  });

  it('não vaza a mensagem de um Error comum (bug nosso)', async () => {
    silenceConsole();
    const res = failFromError(new TypeError("Cannot read properties of undefined (reading 'id')"));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ success: false, error: GENERIC });
  });

  it('trata valor lançado que não é Error', async () => {
    const spy = silenceConsole();
    const res = failFromError('string solta');
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ success: false, error: GENERIC });
    expect(spy).toHaveBeenCalledWith('[api] 500 (erro não curado):', 'string solta');
  });

  it('subclasses de service herdam o contrato e mantêm o name para o log', () => {
    const err = new ContaServiceError('x', 404);
    expect(err).toBeInstanceOf(ApiServiceError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ContaServiceError');
    expect(err.status).toBe(404);
  });
});
