# S2 — RLS e privilégio no banco (verificação de go-live + migration 056)

> Base: `docs/review/seguranca/RELATORIO-SEGURANCA.md` §2. Migrations aplicadas MANUALMENTE; nova = `056+`.

```xml
<objetivo>
  Garantir que TODA tabela com dado sensível tenha RLS habilitado + policy correta (leitura
  authenticated, escrita service_role), fechando o ponto cego dos cadastros pré-existentes e do
  audit_log, e adicionando o REVOKE de escrita como defesa em profundidade. NÃO editar migrations já aplicadas.
</objetivo>

<read_first>
  - CLAUDE.md ("Banco de dados (Supabase)"; "Limpeza / reset de dados"; "Duas chaves Supabase")
  - supabase/migrations/049_authenticated_read_classification_lookups.sql (padrão de SELECT TO authenticated)
  - supabase/migrations/030/033/036 (padrão REVOKE-then-GRANT por coluna)
  - supabase/migrations/051/052/053 (tocam os cadastros pré-existentes SEM RLS)
  - supabase/migrations/README.md
</read_first>

<achados>
  - MÉDIO M1 (go-live): RLS de company, financial_account, financial_bank, financial_chart_of_account_group,
    financial_chart_of_account_subgroup é INVERIFICÁVEL pelas migrations (tabelas pré-existentes). A 049 prova que
    cadastros já estiveram em estado RLS-sem-policy / configurado à mão.
  - MÉDIO M2: audit_log não é criado por nenhuma migration (exigido pelo padrão Sheild) — estado de RLS desconhecido.
  - BAIXO B1: 049 dá GRANT SELECT sem REVOKE INSERT/UPDATE/DELETE em financial_cost_center/financial_chart_of_account.
</achados>

<correcao>
  1. VERIFICAÇÃO (read-only no banco, via MCP Supabase se disponível ou SQL Editor — registrar a saída no PR):
     para cada tabela {company, financial_account, financial_bank, financial_chart_of_account_group,
     financial_chart_of_account_subgroup, financial_cost_center, financial_chart_of_account, audit_log}:
       SELECT relname, relrowsecurity FROM pg_class WHERE relname='<t>';
       SELECT * FROM pg_policies WHERE tablename='<t>';
       -- e \dp <t> para os GRANTs do role authenticated.
  2. Criar `supabase/migrations/056_rls_cadastros_preexistentes.sql` (idempotente — usar IF NOT EXISTS / DO):
     - Para cada cadastro acima que NÃO tiver RLS: `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;`
     - Garantir UMA policy de SELECT `TO authenticated` (se ainda não existir) e NENHUMA policy de escrita p/ authenticated.
     - `REVOKE INSERT, UPDATE, DELETE ON <t> FROM authenticated;` (defesa em profundidade, fecha B1) — escrita só service_role.
     - audit_log: se não existir, criar com colunas mínimas + RLS (SELECT authenticated, ALL service_role); se existir, só habilitar RLS/policy.
     - Usar guardas idempotentes (`DO $$ ... IF NOT EXISTS (SELECT FROM pg_policies ...) ...`).
  3. NÃO aplicar no banco automaticamente sem o usuário (migrations são manuais); deixar o arquivo pronto + o resultado da verificação no PR.
  4. Atualizar supabase/migrations/README.md e CLAUDE.md (lista de migrations → 056; tabela RLS).
</correcao>

<restricoes>
  - NÃO editar migrations 001→055. NÃO truncar/alterar dados dos cadastros (preservados — ver "Limpeza / reset").
  - NÃO conceder GRANT table-wide UPDATE/INSERT/DELETE a authenticated em lugar nenhum.
  - Manter o GRANT por coluna existente (reviewed_at; has_invoice/has_bank_slip; status) intacto.
</restricoes>

<validacao>
  - Aplicar 056 num ambiente de teste (NÃO produção) e reexecutar para confirmar idempotência. Registrar no PR.
  - Vetor de prova (NÃO executar contra prod): PATCH REST direto em financial_bank com Bearer de usuário → deve falhar (RLS/REVOKE).
  - npm run lint && npm run typecheck && npm test (schemas não mudam — confirmar verde); py -3 -m pytest tests/ -q.
</validacao>

<criterio_de_aceite>
  - Todo cadastro com dado sensível: relrowsecurity=true + SELECT authenticated + sem escrita authenticated (verificado).
  - audit_log existe com RLS. 056 idempotente. Documentação atualizada.
</criterio_de_aceite>
```
