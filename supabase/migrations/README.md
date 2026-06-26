# Migrations — Supabase (aplicação MANUAL)

As migrations `001 → 057` são aplicadas **manualmente no SQL Editor do Supabase**, em
**ordem numérica** e **uma única vez cada**. Não há runner automático.

> **`057_revoke_write_supplier_status.sql` (segurança, idempotente)** — `REVOKE` de escrita
> do papel `authenticated` em `supplier`/`status` (defesa em profundidade; o RLS já bloqueia).
> Seguro reaplicar; não altera políticas/dados/SELECT.

> **`056_rls_cadastros_preexistentes.sql` (segurança) é idempotente, MAS exige verificação
> antes de aplicar.** Ela habilita RLS + leitura `authenticated` + REVOKE de escrita nos
> cadastros pré-existentes (`company`, `financial_account`, `financial_bank`, grupos/
> subgrupos) e em `audit_log` se existir. **Antes de rodar**, confirme no SQL Editor o
> estado atual (queries abaixo) — a migration assume que esses cadastros são
> **apenas-leitura** para o papel `authenticated`. Ver `docs/review/seguranca/RELATORIO-SEGURANCA.md` §2.
>
> ```sql
> SELECT relname, relrowsecurity FROM pg_class WHERE relname = '<tabela>';
> SELECT * FROM pg_policies WHERE tablename = '<tabela>';
> -- \dp <tabela>   -- GRANTs do papel authenticated
> ```

## Regras operacionais (não regredir)

1. **Aplicar uma vez, em ordem.** Várias migrations **não são idempotentes** (falham se
   reaplicadas) — isso é **falha segura** (erro, não corrupção de dado), mas evite re-run:
   - `042` — `ADD CONSTRAINT supplier_pkey PRIMARY KEY` / `DROP IDENTITY`.
   - `050`, `051` — `ALTER COLUMN ... ADD GENERATED ALWAYS AS IDENTITY`.
   - `053` — `ADD CONSTRAINT fk_financial_account_status` (sem bloco `DO`/`IF NOT EXISTS`).
   - `039` — `DISABLE/ENABLE TRIGGER trg_fe_supplier_id`: quebra se reaplicada **após** a
     `041` (que dropa esse trigger). Só re-run isolado é afetado.
   - A migration `055` é **idempotente** (só `COMMENT ON`): pode ser reaplicada sem erro.

2. **Pré-requisito de bootstrap (banco vazio NÃO se reconstrói só com estas migrations).**
   As migrations dependem de objetos **pré-existentes** nunca criados por elas:
   - Tabelas de cadastro: `company`, `status`, `supplier`, `financial_account`,
     `financial_bank`, `financial_cost_center`,
     `financial_chart_of_account(_group/_subgroup)`.
   - Função `normalize_search()` (usada já na `007`).
   Em um ambiente novo, aplique o **dump desses cadastros + `normalize_search`** ANTES da
   `001`. (Os cadastros são preservados em qualquer limpeza — ver "Limpeza / reset de dados"
   no `CLAUDE.md`.)

3. **RLS.** Leitura `TO authenticated`, escrita `TO service_role`. Exceções por coluna
   (grant restrito) em `financial_account_control`: `reviewed_at` (030),
   `has_invoice`/`has_bank_slip` (033) e **`status`** (036) — esta última documentada na
   `055`. Toda tabela com RLS habilitado tem ao menos uma policy (default-deny histórico de
   `supplier` e dos cadastros de classificação foi fechado em `029` e `049`).

4. **ON DELETE das FKs de classificação.** As FKs `fk_fac_cost_center`/`fk_fac_chart_account`
   (047) e `fk_supplier_cost_center`/`fk_supplier_chart_account` (052) não declaram `ON DELETE`
   → `NO ACTION`, cujo efeito **equivale a RESTRICT** (sem deferição): bloqueiam excluir um
   cadastro em uso. O backend também valida e devolve `409`. Documentado via `COMMENT ON` na `055`.
