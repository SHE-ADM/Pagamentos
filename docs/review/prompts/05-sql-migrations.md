# Prompt de correção — SQL / migrations (RLS, idempotência, doc de grants)

> Gerado pela revisão pré-produção de 2026-07-08. Aplicar na branch `Features`.
> Origem: `docs/review/RELATORIO-CODE-REVIEW.md` §5. Migration nova, se criada, numera a partir de 072
> (COORDENAR com a migration 072 de segurança — ver docs/review/seguranca/prompts/S2-rls-banco.md).

```xml
<objetivo>
  Alinhar a documentação de idempotência da migration 055 ao estado pós-069 (coluna status dropada) e tornar
  explícito o seed do grupo Administrador (group_id = 1) que a migration 065 pressupõe.
</objetivo>

<read_first>
  - supabase/migrations/055_doc_idempotency_guards.sql (:31 COMMENT ON COLUMN ...status; cabeçalho)
  - supabase/migrations/069_drop_status_text.sql:48-49 (DROP COLUMN status)
  - supabase/migrations/063_create_user_group.sql:34-36 (seed do sentinela id 0)
  - supabase/migrations/065_create_user_profile.sql:80-86 (UPDATE ... SET group_id = 1)
  - supabase/migrations/README.md (seção de regras operacionais / idempotência)
</read_first>

<achados>
  - [BAIXO] A5-1 — 055:31 COMMENT ON COLUMN financial_account_control.status deixa de ser re-executável após a
    069 dropar a coluna. A 055 e o README afirmam "idempotente/re-executável" — estale.
  - [BAIXO] A5-2 — 065:80-86 faz UPDATE user_profile SET group_id = 1, mas nenhum migration semeia o grupo 1;
    a 063 só cria o sentinela id 0. Em aplicação limpa e em ordem, se o grupo 1 não existir, a FK viola e a
    065 aborta.
</achados>

<mudancas_exigidas>
  1. A5-1 (SÓ documentação, sem alterar SQL aplicado): atualizar o comentário-cabeçalho da 055 e a nota do
     README para: "idempotente ATÉ a 069; após o DROP COLUMN status (069), o COMMENT ON COLUMN ...status falha
     — NÃO reaplicar a 055". As demais instruções da 055 (COMMENT ON CONSTRAINT) seguem válidas.
  2. A5-2: garantir o seed do grupo 1 ANTES da Seção 5 da 065. Opção preferida (não reescrever migration
     aplicada): criar migration 072_seed_admin_user_group.sql com
     `INSERT INTO public.user_group (group_id, group_name) OVERRIDING SYSTEM VALUE VALUES (1,'Administrador')
      ON CONFLICT (group_id) DO NOTHING;` e ajustar o `setval` da identity se necessário. Documentar no README
     que a 065, em ambiente limpo, exige a 072 (ou o grupo 1 pré-criado). Se preferir corrigir na origem para
     um bootstrap futuro, adicionar o mesmo INSERT idempotente no topo da Seção 5 da 065 (mas migrations já
     aplicadas não devem ser reescritas em produção — a 072 é o caminho seguro).
</mudancas_exigidas>

<restricoes>
  - NÃO reescrever migrations já aplicadas em produção (042/050/051/053/039/069 etc.) — usar migration nova.
  - COORDENAR a numeração 072 com a migration 072 de segurança (S2). Se ambas forem criadas, numerar em
    sequência (072, 073) e registrar as duas no README, mantendo a ordem de aplicação.
  - Não alterar a semântica de status_id como fonte única (069) nem o sentinela id 0.
</restricoes>

<validacao>
  - Aplicar a nova migration no SQL Editor de um ambiente limpo/staging e confirmar que a 065 não aborta.
  - Reaplicar mentalmente a 055 pós-069: a doc deve avisar para não reexecutar.
  - npm run typecheck (schemas do shared não mudam) para garantir que nada quebrou.
</validacao>

<criterio_de_aceite>
  Doc da 055 e README refletem "idempotente até a 069". O grupo 1 (Administrador) é semeado de forma explícita
  e idempotente (migration 072), de modo que a 065 nunca aborta por FK em ambiente limpo. Nenhuma migration
  aplicada foi reescrita.
</criterio_de_aceite>
```
