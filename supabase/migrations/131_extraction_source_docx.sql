-- 131_extraction_source_docx.sql
--
-- Dominio de `financial_account_control.extraction_source` ganha 'docx_text' e 'docx_vision':
-- o pipeline passou a aceitar anexo .docx (Word) com boleto, hoje descartado em silencio por
-- `save_attachments` (caso de origem: e-mail 1516, "BOLETO: 0003150-04.2023.8.26.0577").
--
-- POR QUE VALOR NOVO, E NAO REUSAR 'pdf_text'/'image_vision' (decisao do dono do produto)
--   Reusar nao custaria migration nenhuma, e foi por isso que a opcao esteve na mesa. O preco
--   seria no DADO, e permanente:
--     * `extraction_confidence` diria 'alta — texto digital do PDF, deterministico (pdfplumber)'
--       para um arquivo que nunca viu pdfplumber. E mentira na coluna cuja razao declarada de
--       existir e PROVENIENCIA (migration 112).
--     * a mesma linha teria `source_file` terminando em .docx e badge dizendo "pdf anexado" —
--       o grid se contradiria sozinho.
--     * e o tripwire 'desconhecida' da 112 ("se aparecer, o dominio mudou e este CASE nao
--       acompanhou") NUNCA dispararia, porque o dominio de fato nao teria mudado. A mentira
--       seria indetectavel por construcao — o pior desfecho possivel para uma guarda.
--
-- CONFIANCA ATRIBUIDA, pela regua ja declarada na 112 (o eixo e proveniencia, nao probabilidade):
--   docx_text   -> 'alta'   parsing deterministico (zipfile + regex), SEM OCR no caminho. E mais
--                           forte que o pdf_text: o texto do .docx so e ACEITO quando traz um
--                           instrumento de pagamento com DV valido (`_page_has_payable`), enquanto
--                           o do PDF e aceito por volume de texto.
--   docx_vision -> 'baixa'  leitura VISUAL da imagem embutida — mesma natureza de image_vision.
--
-- 🔴 AS DUAS VIEWS DE analytics PRECISAM SAIR DA FRENTE E VOLTAR NA MESMA TRANSACAO.
--   `extraction_confidence` e coluna GERADA, e corrigir a regra dela exige DROP+ADD (substituir a
--   expressao NAO recalcula os valores STORED). Mas a 115 poe `f.extraction_confidence` na
--   `analytics.vw_payables`, entao o DROP COLUMN falha com dependencia.
--
--   ⚠️ SAO DUAS VIEWS, NAO UMA — e a primeira tentativa desta migration falhou exatamente aqui.
--   A consulta que fiz em `pg_depend` perguntava quem depende da COLUNA `extraction_confidence`,
--   e a resposta ("so vw_payables") estava certa para a pergunta errada: `vw_aging_vencidos`
--   depende da VIEW, nao da coluna, e por isso nao aparecia. Ao dropar view, a pergunta certa e
--   `pg_depend` sobre a VIEW (ou simplesmente ler o erro do primeiro DROP, que nomeia a
--   dependente). As duas sao recriadas abaixo, na ordem inversa do DROP.
--
--   * NUNCA usar `DROP ... CASCADE`: ele derrubaria as dependentes em silencio, e o chat de IA
--     ficaria sem as tools que as leem — sem erro nenhum nesta migration.
--   * As funcoes de `analytics` que leem as views (`fornecedores_recorrentes`, `parcelamentos`,
--     `demonstrativo_despesas`...) tem corpo em TEXTO (LANGUAGE sql AS $$...$$) e por isso NAO
--     registram dependencia: sobrevivem ao DROP e voltam a funcionar quando as views voltam. E
--     exatamente por isso que o DROP e o CREATE tem de estar na MESMA transacao.
--   * `public.audit_ignored_fields` tambem cita a coluna, em texto — o nome nao muda, segue valida.
--   * O GRANT NAO sobrevive ao DROP VIEW: reemitido ao final (mesma licao da 116).
--
-- 🔴 O ARQUIVO ABRE TRANSACAO EXPLICITA (BEGIN/COMMIT), e isso NAO e decorativo.
--   O `psql` roda em autocommit: sem BEGIN, cada statement comita sozinho e uma falha no meio
--   deixa o banco em estado PARCIAL — foi o que aconteceu na primeira tentativa (o CHECK novo
--   aplicado, as views intactas e a coluna gerada ainda antiga). Alem disso, `CREATE TEMP TABLE
--   ... ON COMMIT DROP` fora de transacao e destruido no commit implicito do proprio CREATE, e as
--   sondas encontrariam as tabelas de baseline ja inexistentes.
--
-- ⚠️ NUNCA forcar recalculo com `UPDATE ... SET x = x`: dispararia `trg_fe_status_vencimento` em
-- todas as linhas e poderia reescrever situacoes. O ADD COLUMN ja calcula a coluna inteira.
--
-- IDEMPOTENTE: reexecucao refaz CHECK/coluna/view chegando ao mesmo estado; as sondas abortam
-- em qualquer divergencia. Requer janela FORA da leitura de e-mails (o DROP/ADD toma lock).

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 0) BASELINE — a distribuicao ANTES, para provar que o DROP/ADD nao mexeu em linha existente.
--    Congelada em TEMP TABLE porque a coluna que a produz esta prestes a deixar de existir.
-- ---------------------------------------------------------------------------------------------
CREATE TEMP TABLE _base_131 ON COMMIT DROP AS
SELECT extraction_confidence AS faixa, count(*) AS n
  FROM public.financial_account_control
 GROUP BY 1;

-- Baseline da VIEW: o conjunto exato de colunas antes do DROP. A sonda P4 compara contra ISTO,
-- e nao contra um numero escrito a mao — que ja nasceu errado na primeira versao deste arquivo
-- (41, quando sao 40). Numero magico numa guarda so testa a memoria de quem o digitou; o
-- baseline testa o que o banco tinha.
CREATE TEMP TABLE _base_131_cols ON COMMIT DROP AS
SELECT table_name, column_name
  FROM information_schema.columns
 WHERE table_schema = 'analytics'
   AND table_name IN ('vw_payables', 'vw_aging_vencidos');

-- ---------------------------------------------------------------------------------------------
-- 1) CHECK do dominio
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.financial_account_control
    DROP CONSTRAINT IF EXISTS financial_account_control_extraction_source_check;

ALTER TABLE public.financial_account_control
    ADD CONSTRAINT financial_account_control_extraction_source_check
    CHECK (extraction_source = ANY (ARRAY[
        'email_body'::text,
        'pdf_text'::text,
        'pdf_vision'::text,
        'image_vision'::text,
        'docx_text'::text,
        'docx_vision'::text,
        'falha'::text
    ]));

-- ---------------------------------------------------------------------------------------------
-- 2) As views saem da frente, da dependente para a base (sem CASCADE — ver o bloco 🔴 acima)
-- ---------------------------------------------------------------------------------------------
DROP VIEW IF EXISTS analytics.vw_aging_vencidos;
DROP VIEW IF EXISTS analytics.vw_payables;

-- ---------------------------------------------------------------------------------------------
-- 3) Coluna GERADA recriada com os dois ramos novos
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.financial_account_control
    DROP COLUMN IF EXISTS extraction_confidence;

ALTER TABLE public.financial_account_control
    ADD COLUMN IF NOT EXISTS extraction_confidence text
    GENERATED ALWAYS AS (
        CASE
            WHEN extraction_source IS NULL          THEN 'manual'
            WHEN extraction_source = 'pdf_text'     THEN 'alta'
            WHEN extraction_source = 'docx_text'    THEN 'alta'
            WHEN extraction_source = 'email_body'   THEN 'media'
            WHEN extraction_source = 'pdf_vision'   THEN 'baixa'
            WHEN extraction_source = 'image_vision' THEN 'baixa'
            WHEN extraction_source = 'docx_vision'  THEN 'baixa'
            ELSE 'desconhecida'
        END
    ) STORED;

CREATE INDEX IF NOT EXISTS ix_fac_extraction_confidence
    ON public.financial_account_control (extraction_confidence);

COMMENT ON COLUMN public.financial_account_control.extraction_confidence IS
  'Confiança ORDINAL derivada de extraction_source: alta (pdf_text/docx_text — texto digital '
  'determinístico, sem OCR) > media (email_body) > baixa (pdf_vision/image_vision/docx_vision — '
  'leitura visual) > manual (NULL = digitado no CRUD). ''desconhecida'' é o ELSE: fonte nova sem '
  'mapeamento aqui — se aparecer, o domínio mudou e este CASE não acompanhou. Nunca numérico: o '
  'eixo é proveniência, não probabilidade calibrada.';

-- ---------------------------------------------------------------------------------------------
-- 4) A view volta — corpo VERBATIM do que estava no banco, so o DDL foi reescrito
-- ---------------------------------------------------------------------------------------------
CREATE VIEW analytics.vw_payables WITH (security_invoker = true) AS
 SELECT f.id AS payable_id,
    f.sk_company,
    c.trade_name AS company_name,
    f.sk_supplier,
    COALESCE(NULLIF(btrim(s.trade_name::text), ''::text), s.legal_name::text) AS supplier_name,
    s.cnpj AS supplier_cnpj,
    f.status_id,
    st.status_name,
    f.status_id = ANY (ARRAY[1, 2, 3]) AS is_open,
    f.status_id = 9 AS is_cancelled,
    f.issue_date,
    f.due_date,
    f.payment_date,
    f.amount,
    f.amount_charged,
    f.document_type,
    f.payment_method,
    f.invoice_number,
    f.cost_center_id,
    COALESCE(cc.cost_center_description, 'não informado'::character varying) AS cost_center_name,
    f.chart_account_id,
    COALESCE(ca.account_description, 'não informado'::character varying) AS chart_account_name,
    COALESCE(g.group_description, 'não informado'::character varying) AS chart_group_name,
    g.type_group_id AS chart_group_nature_id,
    COALESCE(sg.subgroup_description, 'não informado'::character varying) AS chart_subgroup_name,
    sg.type_group_id AS chart_subgroup_type_id,
    f.has_invoice,
    f.has_bank_slip,
    COALESCE(f.fine_interest, 0::numeric)::numeric(15,2) AS fine_interest,
    COALESCE(f.other_additions, 0::numeric)::numeric(15,2) AS other_additions,
    COALESCE(f.discount, 0::numeric)::numeric(15,2) AS discount,
    COALESCE(f.other_deductions, 0::numeric)::numeric(15,2) AS other_deductions,
    f.extraction_source,
    COALESCE(tgs.type_group_description, 'não informado'::character varying) AS chart_subgroup_type_name,
    COALESCE(tgg.type_group_description, 'não informado'::character varying) AS chart_group_nature_name,
    f.competence_month,
    f.days_late,
    f.extraction_confidence,
    f.installment_number,
    f.installment_base
   FROM financial_account_control f
     JOIN company c ON c.sk_company = f.sk_company
     JOIN supplier s ON s.sk_supplier = f.sk_supplier
     JOIN status st ON st.status_id = f.status_id
     LEFT JOIN financial_cost_center cc ON cc.cost_center_id = f.cost_center_id
     LEFT JOIN financial_chart_of_account ca ON ca.chart_account_id = f.chart_account_id
     LEFT JOIN financial_chart_of_account_group g ON g.chart_account_group_id = ca.chart_account_group_id
     LEFT JOIN financial_chart_of_account_subgroup sg ON sg.chart_account_subgroup_id = ca.chart_account_subgroup_id
     LEFT JOIN financial_type_group tgg ON tgg.type_group_id = g.type_group_id
     LEFT JOIN financial_type_group tgs ON tgs.type_group_id = sg.type_group_id;

COMMENT ON VIEW analytics.vw_payables IS
  'Fact plano de contas a pagar com dimensões resolvidas. security_invoker: a RLS de '
  'financial_account_control (migration 076) se aplica ao usuário do JWT. A migration 103 '
  'acrescentou curadoria, componentes de boleto e os NOMES de natureza/tipo; a 115 acrescentou '
  'os campos derivados da Onda 6 (competência, atraso, confiança da extração e parcelamento); a '
  '131 a recriou para permitir o DROP/ADD de extraction_confidence (domínio .docx).';

GRANT SELECT ON analytics.vw_payables TO authenticated;

-- E a dependente volta em seguida, tambem verbatim.
CREATE VIEW analytics.vw_aging_vencidos WITH (security_invoker = true) AS
 SELECT sk_company,
    company_name,
    sk_supplier,
    supplier_name,
    cost_center_name,
    chart_account_name,
        CASE
            WHEN (CURRENT_DATE - due_date) >= 1 AND (CURRENT_DATE - due_date) <= 30 THEN '1-30'::text
            WHEN (CURRENT_DATE - due_date) >= 31 AND (CURRENT_DATE - due_date) <= 60 THEN '31-60'::text
            WHEN (CURRENT_DATE - due_date) >= 61 AND (CURRENT_DATE - due_date) <= 90 THEN '61-90'::text
            ELSE '90+'::text
        END AS aging_bucket,
    CURRENT_DATE - due_date AS days_overdue,
    COALESCE(amount, 0::numeric)::numeric(15,2) AS amount
   FROM analytics.vw_payables v
  WHERE is_open AND due_date IS NOT NULL AND due_date < CURRENT_DATE;

COMMENT ON VIEW analytics.vw_aging_vencidos IS
  'Titulos em aberto ja vencidos, um por linha, com a faixa de aging. Vencido e calculado por '
  'due_date < CURRENT_DATE, NUNCA pelo rotulo status_name (que e defasado pela trigger + batch).';

GRANT SELECT ON analytics.vw_aging_vencidos TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5) SONDAS — abortam a migration inteira em qualquer divergencia
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  v_div        int;
  v_conf       text;
  v_ok         boolean;
  v_cols       int;
  v_invoker    boolean;
BEGIN
  -- P1: nenhuma linha existente mudou de faixa (o DROP/ADD e mecanico, nao pode mexer em dado).
  SELECT count(*) INTO v_div
    FROM (
      SELECT faixa, n FROM _base_131
      EXCEPT
      SELECT extraction_confidence, count(*)
        FROM public.financial_account_control GROUP BY 1
    ) d;
  IF v_div <> 0 THEN
    RAISE EXCEPTION 'P1: a distribuicao de extraction_confidence mudou em % faixa(s)', v_div;
  END IF;

  -- P2: os valores NOVOS sao aceitos pelo CHECK e caem na faixa certa. Testado por INSERT real
  -- numa subtransacao desfeita — checar o texto do CHECK provaria apenas que ele foi escrito.
  BEGIN
    INSERT INTO public.financial_account_control
      (gmail_message_id, sk_supplier, sk_company, amount, due_date, extraction_source)
    VALUES ('<sonda-131-docx-text@local>', 1, 1, 1.00, CURRENT_DATE, 'docx_text')
    RETURNING extraction_confidence INTO v_conf;
    IF v_conf <> 'alta' THEN
      RAISE EXCEPTION 'P2: docx_text deu confianca % (esperado alta)', v_conf;
    END IF;

    INSERT INTO public.financial_account_control
      (gmail_message_id, sk_supplier, sk_company, amount, due_date, extraction_source)
    VALUES ('<sonda-131-docx-vision@local>', 1, 1, 1.00, CURRENT_DATE, 'docx_vision')
    RETURNING extraction_confidence INTO v_conf;
    IF v_conf <> 'baixa' THEN
      RAISE EXCEPTION 'P2: docx_vision deu confianca % (esperado baixa)', v_conf;
    END IF;
    RAISE EXCEPTION 'rollback_sonda_p2';   -- desfaz os dois INSERTs de sonda
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'rollback_sonda_p2' THEN RAISE; END IF;
  END;

  -- P3: valor FORA do dominio continua recusado (anti-vacuidade do P2 — sem isto, um CHECK
  -- acidentalmente removido passaria nos dois testes acima).
  v_ok := false;
  BEGIN
    INSERT INTO public.financial_account_control
      (gmail_message_id, sk_supplier, sk_company, amount, due_date, extraction_source)
    VALUES ('<sonda-131-invalida@local>', 1, 1, 1.00, CURRENT_DATE, 'formato_inexistente');
    RAISE EXCEPTION 'rollback_sonda_p3';
  EXCEPTION
    WHEN check_violation THEN v_ok := true;              -- esperado
    WHEN raise_exception THEN
      IF SQLERRM <> 'rollback_sonda_p3' THEN RAISE; END IF;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'P3: o CHECK aceitou um extraction_source fora do dominio';
  END IF;

  -- P4: a view voltou com EXATAMENTE as mesmas colunas de antes (comparacao de conjunto nos dois
  -- sentidos — coluna faltando OU sobrando reprova) e com security_invoker; sem ele, a RLS da 076
  -- deixaria de valer no chat e todo usuario veria as contas de todos.
  SELECT count(*) INTO v_cols
    FROM (
      (SELECT table_name, column_name FROM _base_131_cols
       EXCEPT
       SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema='analytics'
          AND table_name IN ('vw_payables','vw_aging_vencidos'))
      UNION ALL
      (SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema='analytics'
          AND table_name IN ('vw_payables','vw_aging_vencidos')
       EXCEPT
       SELECT table_name, column_name FROM _base_131_cols)
    ) d;
  IF v_cols <> 0 THEN
    RAISE EXCEPTION 'P4: as views voltaram com % coluna(s) divergentes do baseline', v_cols;
  END IF;
  -- Anti-vacuidade: com o baseline vazio os dois EXCEPT dariam 0 e a guarda passaria sem testar
  -- nada. (View AUSENTE ja e pega pelo primeiro EXCEPT, que acusaria todas as colunas faltando.)
  IF (SELECT count(*) FROM _base_131_cols) = 0 THEN
    RAISE EXCEPTION 'P4: baseline de colunas vazio — a guarda estaria testando nada';
  END IF;
  -- security_invoker nas DUAS: sem ele a view roda com o privilegio do DONO e a RLS da 076
  -- deixa de valer, entregando as contas de todos a qualquer usuario do chat.
  SELECT bool_and('security_invoker=true' = ANY (c.reloptions)) INTO v_invoker
    FROM pg_class c
   WHERE c.oid IN ('analytics.vw_payables'::regclass,
                   'analytics.vw_aging_vencidos'::regclass);
  IF NOT coalesce(v_invoker, false) THEN
    RAISE EXCEPTION 'P4: view de analytics sem security_invoker — a RLS da 076 deixou de valer';
  END IF;

  -- P5: os GRANTs foram reemitidos (o DROP VIEW os levou junto) — nas DUAS views.
  IF (SELECT count(*) FROM information_schema.role_table_grants
       WHERE table_schema='analytics' AND grantee='authenticated' AND privilege_type='SELECT'
         AND table_name IN ('vw_payables','vw_aging_vencidos')) <> 2 THEN
    RAISE EXCEPTION 'P5: authenticated perdeu o SELECT em alguma das views de analytics';
  END IF;

  -- P6: o indice da coluna gerada voltou (o DROP COLUMN o levou junto).
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname='public' AND indexname='ix_fac_extraction_confidence') THEN
    RAISE EXCEPTION 'P6: ix_fac_extraction_confidence nao foi recriado';
  END IF;

  RAISE NOTICE 'Migration 131: dominio .docx aplicado; distribuicao preservada; views restauradas';
END $$;

COMMIT;
