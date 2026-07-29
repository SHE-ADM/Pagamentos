// lib/ai-chat/errors.ts
// Traduz erros do @anthropic-ai/sdk para mensagens que o usuário do financeiro possa agir.
//
// POR QUE ISTO EXISTE (§17.9 do doc de arquitetura)
// `failFromError` só ecoa a mensagem de um `ApiServiceError`; qualquer outro erro vira 500
// genérico + log. Isso já protege — os erros do SDK NÃO vazam mais para o cliente. Mas 500
// genérico é seguro e pouco informativo: quem perguntou "quanto paguei em julho" e esbarrou num
// limite de taxa merece saber que é temporário, não um "erro interno" indistinguível de um bug.
//
// A REGRA: só traduzir o que o usuário pode AGIR a respeito.
// - 429 → ele pode tentar de novo em instantes.
// - 401/403 → é a NOSSA chave que está errada; dizer "sessão expirada" mandaria o usuário
//   deslogar e logar de novo sem efeito nenhum, e esconderia de nós um erro de configuração.
//   Vira 500 (com log), que é a verdade: falha do servidor.
// - 400 → bug nosso de payload. Idem.
// Traduzir demais é tão ruim quanto de menos: transforma erro nosso em "culpa" do usuário.

import Anthropic from '@anthropic-ai/sdk';
import { ApiServiceError } from '../api-error';
import type { LoggedToolCall } from './log';

/** Erro do chat com mensagem curada — `failFromError` ecoa (status < 500). */
export class AiChatError extends ApiServiceError {
  constructor(message: string, status: number) {
    super(message, status, 'AiChatError');
  }
}

/**
 * Converte um erro do SDK em `AiChatError` quando há algo útil a dizer; devolve o erro original
 * quando não há (aí `failFromError` faz o 500 genérico + log, que é o comportamento correto).
 *
 * Usa as classes TIPADAS do SDK, não string matching na mensagem — o texto muda entre versões,
 * a classe não.
 */
export function translateAnthropicError(e: unknown): unknown {
  if (e instanceof Anthropic.RateLimitError) {
    return new AiChatError(
      'O assistente está sobrecarregado no momento. Tente novamente em alguns instantes.',
      429,
    );
  }

  // Timeout do nosso lado ou falha de rede até a API: o usuário pode tentar de novo, e não há
  // nada que ele tenha feito de errado. 503 comunica "indisponível agora", não "quebrado".
  if (e instanceof Anthropic.APIConnectionTimeoutError) {
    return new AiChatError(
      'A consulta demorou mais do que o esperado e foi interrompida. '
        + 'Tente reformular a pergunta de forma mais específica.',
      503,
    );
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new AiChatError('Não foi possível falar com o assistente agora. Tente novamente.', 503);
  }

  // Qualquer 5xx do PROVEDOR (500, 502, 503 e o 529 "overloaded") é transitório e do lado dele —
  // o usuário pode agir: tentar de novo. Tratar só o 529 seria inconsistente com a regra acima e
  // faria uma indisponibilidade da Anthropic parecer um bug nosso.
  if (e instanceof Anthropic.APIError && typeof e.status === 'number' && e.status >= 500) {
    return new AiChatError(
      'O assistente está indisponível no momento. Tente novamente em alguns instantes.',
      503,
    );
  }

  // 401/403/400 e demais: NÃO traduzir. São falhas de configuração ou bugs nossos; viram 500
  // genérico + console.error via failFromError, e é assim que devem aparecer.
  return e;
}

/** O que já foi gasto/apurado quando a requisição falhou no meio do loop. */
// Contrato de attachPartialRun/readPartialRun — consumido pela rota via inferência.
// ts-prune-ignore-next
export interface PartialRun {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  toolCalls: LoggedToolCall[];
  rowCount: number;
}

// Símbolo, não propriedade nomeada: não colide com nada do SDK e não aparece em `JSON.stringify`
// de um erro logado por outra camada.
const PARTIAL_RUN = Symbol.for('ai-chat.partialRun');

/**
 * Anexa o estado parcial ao erro que sobe, para a rota auditá-lo. Devolve o MESMO erro.
 *
 * O `try` não é decorativo: `Object.defineProperty` **lança** num objeto não-extensível (erro
 * congelado por alguma camada). Como esta função é chamada dentro do `catch` do gateway, na
 * própria expressão do `throw`, essa exceção SUBSTITUIRIA o erro traduzido — um 429 viraria um
 * `TypeError` genérico e a causa real sumiria do log. Ou seja: a melhoria de auditoria destruiria
 * a informação de erro que ela existe para preservar. Na dúvida, perde-se a auditoria parcial e
 * preserva-se o erro, nunca o contrário.
 */
export function attachPartialRun<T>(e: T, run: PartialRun): T {
  if (typeof e === 'object' && e !== null) {
    try {
      Object.defineProperty(e, PARTIAL_RUN, { value: run, enumerable: false, configurable: true });
    } catch {
      console.error('[ai-chat] erro não-extensível: auditoria parcial perdida', run);
    }
  }
  return e;
}

// ts-prune-ignore-next — consumido pela rota.
export function readPartialRun(e: unknown): PartialRun | null {
  if (typeof e !== 'object' || e === null) return null;
  return (e as Record<symbol, PartialRun | undefined>)[PARTIAL_RUN] ?? null;
}
