# S2 — RLS e privilégio no banco (BLOQUEADOR de produção)

> Gerado pela auditoria de segurança de 2026-07-08. Aplicar na branch `Features`.
> Origem: `docs/review/seguranca/RELATORIO-SEGURANCA.md` §2. Contém o ÚNICO bloqueador de go-live.

```xml
<objetivo>
  Fechar o escalonamento de privilégio: revogar EXECUTE das RPCs SECURITY DEFINER de resolução/enriquecimento
  de fornecedor de PUBLIC/anon/authenticated (mantendo service_role), tornar explícita a proteção de DELETE do
  bucket attachments e (defesa em profundidade) versionar normalize_search com search_path fixo.
</objetivo>

<read_first>
  - supabase/migrations/042_supplier_sk_surrogate_key.sql:221,335,119,161,182 (definições SECURITY DEFINER)
  - supabase/migrations/040_resolve_supplier_rpc.sql:15,34
  - supabase/migrations/010_guard_blank_cnpj_cpf.sql:59 (resolve_supplier_id / resolve_company_id)
  - supabase/migrations/056_rls_cadastros_preexistentes.sql, 057_revoke_write_supplier_status.sql (lockdown a estender)
  - supabase/migrations/021_create_attachments_bucket.sql:21-26
  - supabase/migrations/README.md (regras operacionais / ordem)
  - CLAUDE.md:436-439,1349,2425 (desenho: escrita só service_role; protect_delete)
</read_first>

<achados>
  - [ALTO] S2-1 — resolve_supplier_id, resolve_supplier_for_account, resolve_company_id, _enrich_supplier,
    _enrich_supplier_name, _add_supplier_email são SECURITY DEFINER em public, expostas como RPC pelo PostgREST,
    com EXECUTE default para PUBLIC (nunca revogado). authenticated/anon escrevem em supplier via
    POST /rest/v1/rpc/..., contornando o REVOKE das 056/057. BLOQUEADOR.
  - [BAIXO] S2-2 — protect_delete documentado (CLAUDE.md:2425) não existe; DELETE de attachments só é barrado
    por default-deny implícito (021 só cria SELECT).
  - [INFO] normalize_search não versionada (bootstrap manual) — confirmar SET search_path.
</achados>

<correcao>
  Criar migration 072_revoke_execute_supplier_rpcs.sql (COORDENAR numeração com o prompt de code review
  05-sql-migrations, que também sugere uma 072 — se ambas existirem, usar 072 e 073 em sequência e registrar
  no README):
  1. S2-1: para CADA assinatura, `REVOKE EXECUTE ON FUNCTION public.<fn>(<args>) FROM PUBLIC, anon, authenticated;`
     e garantir `GRANT EXECUTE ON FUNCTION public.<fn>(<args>) TO service_role;`. Cobrir:
     - resolve_supplier_id(text,text,text,text)
     - resolve_supplier_for_account(...)  (conferir assinatura em 040/042)
     - resolve_company_id(...)
     - _enrich_supplier(bigint,text,text)
     - _enrich_supplier_name(bigint,text)
     - _add_supplier_email(bigint,text)
     Idempotente (REVOKE/GRANT são seguros para re-run).
  2. S2-2: adicionar policy explícita
     `CREATE POLICY "attachments_no_delete_authenticated" ON storage.objects FOR DELETE TO authenticated USING (false);`
     (checar se já existe antes) e alinhar o texto do CLAUDE.md ("protect_delete") ao nome real.
  3. INFO normalize_search: se possível, versionar a definição com SECURITY INVOKER + SET search_path=public na 072.
  Verificar antes no SQL Editor (o README exige verificação): as funções ainda são as mesmas assinaturas.
</correcao>

<restricoes>
  - NÃO revogar EXECUTE das funções de TRIGGER (fn_set_status_from_due_date, handle_new_user, mirror_id,
    no_funcionario) — triggers rodam como owner independentemente de GRANT; revogar não afeta e polui.
  - NÃO reescrever migrations já aplicadas — só migration nova.
  - Manter service_role com EXECUTE (o pipeline Python depende das RPCs).
  - Não alterar as policies de leitura existentes.
</restricoes>

<validacao>
  - Aplicar a 072 no SQL Editor de staging.
  - Teste de vetor (NÃO contra produção): com a anon key + token de usuário comum, `POST /rest/v1/rpc/resolve_supplier_id`
    com um nome arbitrário → ANTES: cria/retorna fornecedor (403 esperado DEPOIS). Repetir para _add_supplier_email
    (deve falhar 403). Confirmar que o pipeline Python (service_role) continua resolvendo fornecedor (rodar
    `read_emails.py --dry-run` / um reprocesso em staging).
  - py -3 -m pytest tests/ -q  (o pipeline usa service_role — não deve regredir).
</validacao>

<criterio_de_aceite>
  authenticated/anon recebem 403 ao chamar as RPCs de fornecedor via /rpc; service_role segue funcionando
  (extração/reprocesso ok). DELETE de attachments barrado por policy explícita. Doc do CLAUDE.md alinhada.
  Este é o item que muda o veredito de segurança de NÃO PASSA para PASSA.
</criterio_de_aceite>
```
