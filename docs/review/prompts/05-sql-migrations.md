# Prompt de correção — SQL / migrations (RLS, idempotência, doc de grants)

> Rodar na raiz do monorepo `pagamentos`, branch `Features`. Base: `docs/review/RELATORIO-CODE-REVIEW.md` §5.
> Escopo: `supabase/migrations/`, doc CLAUDE.md. Migration nova, se necessária, numerar a partir de **055**.
> ATENÇÃO: migrations são aplicadas MANUALMENTE no SQL Editor, uma vez, em ordem — não há runner automático.

```xml
<objetivo>
  Endurecer a idempotência das migrations que falham em re-run acidental, corrigir o comentário ON DELETE,
  atualizar a documentação de grants por coluna e registrar/validar o pré-requisito de bootstrap. NÃO reescrever
  migrations já aplicadas — usar 055+ para qualquer DDL novo. Os enums já batem 1:1 com os CHECK (nada a alterar lá).
</objetivo>

<read_first>
  - CLAUDE.md (seção "Banco de dados (Supabase)"; "Limpeza / reset de dados"; grants por coluna)
  - supabase/migrations/050_*.sql, 051_*.sql, 042_*.sql, 053_*.sql (DDL não idempotente)
  - supabase/migrations/035_*.sql (referência: FK via bloco DO/pg_constraint — padrão idempotente correto)
  - supabase/migrations/036_*.sql (GRANT UPDATE (status):19), 033_*.sql, 030_*.sql (grants por coluna)
  - supabase/migrations/039_*.sql (DISABLE/ENABLE TRIGGER trg_fe_supplier_id:32,47 — quebra se re-run após 041)
  - supabase/migrations/047_*.sql (comentário "ON DELETE RESTRICT":18 vs DDL sem ON DELETE:28-39)
</read_first>

<achados>
  - ALTO   Migrations não re-executáveis — 050:25, 051:28-58 (ADD GENERATED ALWAYS AS IDENTITY), 042:64 (ADD PRIMARY KEY),
            053:11-13 (ADD CONSTRAINT fk sem bloco DO). Falham em re-run; falha SEGURA (erro, não corrupção).
  - MÉDIO  RLS-1: authenticated tem GRANT UPDATE (status) além das 3 colunas documentadas — 036:19 (doc desatualizada).
  - MÉDIO  TRG-1: 039:32,47 quebra se re-executada após 041 (trigger já dropado).
  - MÉDIO  ORD-2: migrations não bootstrapam banco vazio (dependem de cadastros pré-existentes + normalize_search).
  - BAIXO  FK-1: comentário "ON DELETE RESTRICT" vs DDL NO ACTION — 047:18 (efeito equivalente; só divergência textual).
</achados>

<mudancas_exigidas>
  1. NÃO editar as migrations 001→054 já aplicadas. Em vez disso:
     - Criar `supabase/migrations/055__doc_and_guards.sql` (ou nome equivalente) com APENAS operações idempotentes e seguras
       que documentem/reforcem o estado atual quando fizer sentido — ex.: comentários SQL (COMMENT ON) registrando o
       ON DELETE efetivo, e quaisquer GRANTs/policies que precisem ser reafirmados de forma `IF NOT EXISTS`/`DO`.
       NÃO recriar identity/PK já existentes.
  2. Documentação (CLAUDE.md + cabeçalho do RELATORIO): atualizar a contagem de colunas graváveis por `authenticated` em
     financial_account_control para "has_invoice + has_bank_slip + status" (3 → reconhecer a 4ª, `status`, da migration 036).
  3. Guia de idempotência: adicionar uma nota curta (em CLAUDE.md, seção do banco, ou em supabase/migrations/README) avisando
     que 050/051/042/053/039 NÃO são re-executáveis e que a aplicação é estritamente uma-vez-por-migration, em ordem.
  4. Bootstrap (ORD-2): documentar o pré-requisito de que um banco novo precisa dos cadastros pré-existentes
     (company, status, supplier, financial_account, financial_bank, financial_cost_center, financial_chart_of_account(_group/_subgroup))
     + a função normalize_search ANTES da 001. Se desejarem reprodutibilidade total, propor (sem aplicar) um V000__bootstrap.sql.
  5. VERIFICAÇÃO em banco (read-only, via MCP Supabase se disponível ou SQL Editor): confirmar que `company`, `financial_account`
     e os cadastros de Tabelas NÃO estão em RLS default-deny silencioso (mesma classe pré-029/pré-049) e que a linha id 0 existe
     em financial_cost_center e financial_chart_of_account. Registrar o resultado no PR. Se faltar policy, criar em 055+ uma
     policy de SELECT `TO authenticated` análoga à 049.
</mudancas_exigidas>

<restricoes>
  - NUNCA truncar/alterar os cadastros preservados (supplier, company, status, financial_* de Tabelas) — ver "Limpeza / reset".
  - NÃO mexer nos CHECK ↔ z.enum: os 5 domínios já batem 1:1 (document_type 28, payment_method 15, status 10, email_control 6, extraction_source 4).
  - NÃO alterar o trigger fn_set_status_from_due_date (guard de status correto) nem o trg_supplier_mirror_id.
  - Falsos positivos: FK NO ACTION ≡ RESTRICT aqui (sem deferição); barrel do shared no ts-prune; rotas Flask no vulture.
</restricoes>

<validacao>
  - Se criar 055+, validar a sintaxe aplicando no SQL Editor de um ambiente de teste (NÃO em produção) — registrar no PR.
  - npm run lint / typecheck / test / prune   (schemas Zod não mudam; confirmar verde).
  - py -3 -m pytest tests/ -q                  (pipeline intocado; confirmar verde).
</validacao>

<criterio_de_aceite>
  - Nenhuma migration 001→054 foi editada.
  - DDL novo (se houver) numerado 055+ e idempotente.
  - Doc atualizada: 4 colunas graváveis por authenticated; nota de idempotência; pré-requisito de bootstrap.
  - Verificação de RLS/sentinela no banco registrada (e policy criada em 055+ se faltava).
</criterio_de_aceite>
```
