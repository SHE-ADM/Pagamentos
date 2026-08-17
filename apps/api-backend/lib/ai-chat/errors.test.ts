import { describe, it, expect, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { translateAnthropicError, AiChatError, attachPartialRun, readPartialRun, type PartialRun } from './errors';
import { ApiServiceError } from '../api-error';
import { failFromError } from '../response';

// Constrói os erros tipados do SDK sem chamar a API.
const httpError = (status: number, message: string) =>
  new Anthropic.APIError(status, { type: 'error', error: { type: 'x', message } }, message, undefined);

describe('translateAnthropicError', () => {
  it('429 vira mensagem acionável em pt-BR', () => {
    const out = translateAnthropicError(
      new Anthropic.RateLimitError(429, undefined, 'rate_limit_error', new Headers()),
    );
    expect(out).toBeInstanceOf(AiChatError);
    expect((out as AiChatError).status).toBe(429);
    expect((out as AiChatError).message).toMatch(/sobrecarregado/i);
  });

  // 5xx do PROVEDOR é transitório e do lado dele — o usuário pode agir (tentar de novo), então
  // cai na regra de tradução. 503 (indisponível), não 429: 429 significa "você excedeu um limite",
  // e uma indisponibilidade da Anthropic não é culpa de quem perguntou. O `RateLimitError` real
  // continua 429, testado acima.
  it.each([
    [529, 'Overloaded'],
    [500, 'Internal server error'],
    [503, 'Service unavailable'],
  ])('%i do provedor vira 503 "indisponível"', (status, msg) => {
    const out = translateAnthropicError(httpError(status, msg));
    expect(out).toBeInstanceOf(AiChatError);
    expect((out as AiChatError).status).toBe(503);
    expect((out as AiChatError).message).toMatch(/indisponível/i);
  });

  it('timeout sugere reformular, em vez de "erro interno"', () => {
    const out = translateAnthropicError(new Anthropic.APIConnectionTimeoutError({ message: 'timeout' }));
    expect(out).toBeInstanceOf(AiChatError);
    expect((out as AiChatError).status).toBe(503);
    expect((out as AiChatError).message).toMatch(/reformular/i);
  });

  // --- O outro lado da regra: o que NÃO deve ser traduzido ---

  it('401 NÃO é traduzido — é a nossa chave, não a sessão do usuário', () => {
    const original = httpError(401, 'invalid x-api-key');
    const out = translateAnthropicError(original);
    expect(out).toBe(original);
    expect(out).not.toBeInstanceOf(ApiServiceError);
  });

  it('400 NÃO é traduzido — é bug nosso de payload', () => {
    const original = httpError(400, 'max_tokens: must be <= 8192');
    expect(translateAnthropicError(original)).toBe(original);
  });

  it('erro desconhecido passa intacto', () => {
    const original = new TypeError('boom');
    expect(translateAnthropicError(original)).toBe(original);
  });
});

describe('attachPartialRun / readPartialRun', () => {
  // Tipado: `PartialRun` ganhou `iterations` na migration 102, e um literal solto deixaria de
  // acusar o próximo campo novo — que é justamente o valor de exigir o tipo aqui.
  const run: PartialRun = {
    inputTokens: 900,
    outputTokens: 12,
    cacheReadTokens: 4000,
    cacheCreationTokens: 0,
    toolCalls: [],
    rowCount: 0,
    iterations: 3,
    model: 'claude-sonnet-5',
  };

  it('anexa sem aparecer em JSON.stringify (não polui log de outra camada)', () => {
    const e = attachPartialRun(new Error('falhou'), run);
    expect(readPartialRun(e)).toEqual(run);
    expect(JSON.stringify(e)).not.toContain('900');
  });

  it('erro CONGELADO não derruba a propagação — preserva o erro, perde só a auditoria', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = Object.freeze(new AiChatError('sobrecarregado', 429));

    // Sem o try interno, `Object.defineProperty` lançaria TypeError DENTRO do `throw` do gateway:
    // o 429 traduzido viraria 500 genérico e a causa real sumiria.
    const out = attachPartialRun(original, run);

    expect(out).toBe(original);
    expect((out as AiChatError).status).toBe(429);
    expect(readPartialRun(out)).toBeNull();
    expect(spy).toHaveBeenCalled();
  });

  it('tolera valores que não são objeto', () => {
    expect(attachPartialRun('texto', run)).toBe('texto');
    expect(attachPartialRun(null, run)).toBeNull();
  });
});

// A tradução só tem valor se casar com o contrato do failFromError — daí testar o par.
describe('integração com failFromError', () => {
  it('erro traduzido chega ao usuário com a mensagem curada', async () => {
    const out = translateAnthropicError(
      new Anthropic.RateLimitError(429, undefined, 'rate_limit_error', new Headers()),
    );
    const res = failFromError(out, 'ai-chat');
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: 'O assistente está sobrecarregado no momento. Tente novamente em alguns instantes.',
    });
  });

  /**
   * 🔴 A guarda que faltava (achado de 2026-08-12).
   *
   * Este describe dizia que "a tradução só tem valor se casar com o contrato do failFromError" e
   * pareava APENAS o 429. Os outros três ramos são 503, e a regra padrão do envelope ("ecoa só
   * abaixo de 500") descartava o texto deles: o usuário lia "Erro interno ao processar a
   * solicitação" exatamente quando a causa era temporária e havia o que fazer. Um teste que
   * promete uma garantia precisa observá-la em todos os ramos, não num representante.
   */
  it.each([
    ['timeout de conexão', new Anthropic.APIConnectionTimeoutError({ message: 'timeout' }), 503],
    ['falha de rede', new Anthropic.APIConnectionError({ message: 'network' }), 503],
    ['5xx do provedor', httpError(529, 'overloaded'), 503],
  ])('%s: a mensagem curada CHEGA ao cliente (não vira genérica)', async (_rotulo, erro, status) => {
    const out = translateAnthropicError(erro);
    const res = failFromError(out, 'ai-chat');

    expect(res.status).toBe(status);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe((out as AiChatError).message);
    expect(body.error).not.toBe('Erro interno ao processar a solicitação');
  });

  it('o eco em 5xx é OPT-IN: ApiServiceError sem a marca continua genérico', async () => {
    // Sem esta contraprova, `clientSafe` poderia ter sido implementado como "ecoa sempre" e o
    // invariante "5xx não vaza detalhe interno" estaria desligado para o projeto inteiro.
    const res = failFromError(new ApiServiceError('detalhe interno com nome de tabela', 503), 'x');
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: 'Erro interno ao processar a solicitação',
    });
  });

  it('erro NÃO traduzido vira 500 genérico — a mensagem do provider não vaza', async () => {
    const out = translateAnthropicError(httpError(401, 'invalid x-api-key sk-ant-abc123'));
    const res = failFromError(out, 'ai-chat');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Erro interno ao processar a solicitação');
    expect(JSON.stringify(body)).not.toContain('sk-ant');
  });
});
