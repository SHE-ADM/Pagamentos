// lib/api-error.ts
// Base ÚNICA dos erros de service — o contrato que autoriza uma mensagem a chegar ao cliente.
//
// POR QUE ESTA CLASSE EXISTE (não é só deduplicação)
// `failFromError` (lib/response.ts) precisa decidir se ecoa a mensagem do erro ou se responde algo
// genérico. Ele fazia isso por DUCK-TYPING: "tem `.status` numérico < 500? então a mensagem é
// curada, pode ecoar". Essa suposição não é imposta por nada — e é falsa para bibliotecas de
// terceiros, que também carregam `status`:
//
//     AuthError (@supabase/auth-js)      -> status 400, "Invalid login credentials"
//     StorageApiError (@supabase/storage-js) -> status 404, "Object not found"
//
// Ou seja: qualquer erro do Supabase que escapasse até um route handler era ecoado VERBATIM ao
// cliente — texto em inglês do provider, num app cujas mensagens são pt-BR curadas. Hoje os
// services convertem esses erros disciplinadamente (ver `conta-attachments.ts`), mas isso é
// CONVENÇÃO, não contrato: bastava um `catch` novo repassar o erro cru para reabrir o vazamento,
// silenciosamente e sem teste vermelho. É a mesma família do achado §3 M-2 (`fail(e.message, 500)`
// vazando nome de tabela e constraint do Postgres) — que já custou uma correção.
//
// Com a base explícita, a regra deixa de ser uma heurística sobre o SHAPE do erro e passa a ser
// uma afirmação sobre sua ORIGEM: só ecoa o que o NOSSO código construiu deliberadamente para o
// usuário ler. Erro de terceiro não tem como se passar por curado, porque não estende esta classe.
//
// O ganho é maior fora do CRUD: o gateway do chat de IA (Fase 2) vai lidar com erros do
// `@anthropic-ai/sdk`, que carregam `status` 429/401/400 e mensagens do provider — sem esta
// mudança, um limite de organização da Anthropic apareceria em inglês para o pessoal do
// financeiro, e um 401 da NOSSA chave faria o usuário pensar que a sessão dele expirou.
// Ver §17.9 de docs/arquitetura-chat-ia-pagamentos.md.

/**
 * Erro de service com mensagem **curada em pt-BR**, segura para exibir ao usuário final.
 *
 * Estender esta classe é o que autoriza `failFromError` a ecoar a mensagem (quando `status` < 500).
 * Nunca use-a para embrulhar a mensagem crua de uma biblioteca de terceiro: ou traduza para uma
 * mensagem própria, ou deixe o erro subir como está — ele vira 500 genérico + log, que é o
 * comportamento correto para o que não foi escrito para ser lido.
 */
export class ApiServiceError extends Error {
  readonly status: number;

  /**
   * Autoriza o eco da mensagem MESMO com status >= 500. Opt-in explícito, default `false`.
   *
   * POR QUE ISTO PRECISOU EXISTIR (achado de 2026-08-12)
   * A regra "ecoa se `status < 500`" descartava, em silêncio, três mensagens que o
   * `translateAnthropicError` produz DE PROPÓSITO para o usuário: as 503 de timeout, de falha de
   * rede e de 5xx do provedor. Elas mudavam o status e perdiam o texto — quem perguntava "quanto
   * paguei em julho" durante uma instabilidade da Anthropic lia "Erro interno ao processar a
   * solicitação", indistinguível de um bug nosso, e o `errors.ts` documentava exatamente o
   * contrário. O teste de integração que dizia parear tradução e envelope pareava só o 429.
   *
   * A saída NÃO é relaxar o corte em 500 para qualquer erro: 5xx costuma carregar detalhe interno, e
   * essa é a razão de o corte existir. É marcar caso a caso o que foi escrito para ser lido — o
   * mesmo espírito de exigir a herança desta classe em vez de aceitar qualquer objeto com
   * `.status`. Erro sem a marca continua virando mensagem genérica + log.
   */
  readonly clientSafe: boolean;

  /**
   * @param message    Mensagem curada, em pt-BR, endereçada ao usuário final.
   * @param status     HTTP status. `< 500` é ecoado ao cliente; `>= 500` vira mensagem genérica,
   *                   salvo com `clientSafe`.
   * @param name       Nome da subclasse, preservado para logs e asserções de teste.
   * @param clientSafe Ecoa a mensagem mesmo em 5xx. Use só quando o texto for curado por
   *                   construção — nunca para embrulhar mensagem de biblioteca de terceiro.
   */
  constructor(message: string, status: number, name = 'ApiServiceError', clientSafe = false) {
    super(message);
    this.name = name;
    this.status = status;
    this.clientSafe = clientSafe;
  }
}
