// lib/audit-actor.ts
// Propaga o ATOR (usuário logado) para a trilha de auditoria da migration 117.
//
// POR QUE UM HEADER, E NÃO UMA COLUNA
// A trigger `public.fn_audit_row` resolve o autor nesta ordem: `auth.uid()` → header
// `x-audit-actor` → GUC `app.audit_actor` → NULL. A Next API escreve com **service_role**, que não
// tem JWT de usuário, então `auth.uid()` é NULL em todo PATCH/DELETE que passa por aqui — sem este
// header, o hard delete de uma conta (irreversível, exceção do grupo Administrador) e toda edição
// de fornecedor seriam auditados com autor DESCONHECIDO. Era o achado 4 do levantamento da Onda 7.
//
// A alternativa considerada era deduzir o ator da coluna `updated_by`. Foi DESCARTADA: quando o
// valor não muda (mesmo usuário editando duas vezes, ou um batch que herda o valor antigo), ela
// aponta o editor ANTERIOR — atribuir a ele uma alteração que não fez é acusação falsa, pior que
// ausência de dado. `supplier` sequer tem essa coluna.
//
// 🔴 NÃO É SUPERFÍCIE DE ATAQUE NOVA. A trigger só consulta o header quando NÃO há `auth.uid()`,
// isto é, quando quem escreve é `service_role`. Um usuário logado que forjasse o header seria
// ignorado, porque o JWT tem precedência; e quem detém a service_role key já pode escrever
// qualquer coisa diretamente. A ordem na trigger é invariante de segurança, não preferência.
//
// Mecanismo verificado empiricamente contra esta instância (2026-08-11): o PostgREST expõe os
// headers da requisição em `current_setting('request.headers')`, e um UPDATE enviado COM o header
// gravou `ator_via='header'` com o uuid exato; SEM o header, gravou `ator_via='servico'` e autor
// nulo — subatribuição honesta, nunca atribuição errada.

/**
 * Header lido por `public.fn_audit_row` (migration 117).
 *
 * NÃO é exportado de propósito: ninguém em TypeScript o consome — quem precisa dele é a TRIGGER,
 * do outro lado da fronteira. Exportá-lo criaria uma API pública sem consumidor (o `ts-prune` do
 * projeto acusa exatamente isso). A coerência entre este nome e o que o SQL lê é travada pela
 * guarda cross-layer `G6WiringDoAtorTest` (tests/test_onda7_auditoria.py), que compara os dois
 * arquivos — divergir aqui não quebraria nada visivelmente: a escrita continuaria funcionando e a
 * trilha passaria a registrar 'servico' para toda edição humana da Next API, em silêncio.
 */
const AUDIT_ACTOR_HEADER = 'x-audit-actor';

/**
 * Aplica o header do ator a um query builder do postgrest-js, quando há usuário conhecido.
 *
 * `setHeader` vive em `PostgrestBuilder`, a base abstrata — logo está disponível em `update()`,
 * `delete()` e `rpc()` igualmente. O tipo é estrutural (e não o do SDK) para não amarrar o helper
 * às genéricas do builder, que mudam conforme a tabela.
 *
 * @param query   builder já montado (`.from(T).update(...)`, `.delete()`, …)
 * @param actorId UUID do usuário logado; `undefined` deixa a requisição intacta, e a trigger
 *                registra `ator_via='servico'` — o comportamento honesto para escrita automática.
 *
 * @example
 * ```ts
 * withAuditActor(getSupabaseAdmin().from('supplier').update(payload).eq('sk_supplier', sk), userId)
 * ```
 */
export function withAuditActor<T extends { setHeader(name: string, value: string): T }>(
  query: T,
  actorId?: string,
): T {
  return actorId ? query.setHeader(AUDIT_ACTOR_HEADER, actorId) : query;
}
