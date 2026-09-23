-- =============================================================
-- 144_rainha_maria_reconciliacao_reprocesso.sql
-- Curadoria de dados (sem DDL): reconcilia o e-mail <002101dd4a8c...> depois do reprocessamento
-- que recuperou as 6 parcelas perdidas da NF 1724.
--
-- Projeto: pagamentos | Data: 2026-09-22
--
-- POR QUE EXISTE — o efeito colateral do reprocessamento, que NAO e um defeito novo e sim uma
-- propriedade conhecida do pipeline: `register_financial` faz UPSERT por `gmail_message_id`, e o
-- sufixo (#1, #2, ...) e POSICIONAL — vem da ordem em que os anexos foram processados. Ao
-- reprocessar um e-mail cuja leitura anterior gravou MENOS contas que anexos, as posicoes
-- mudam: o mesmo id passa a descrever OUTRO documento. As 15 contas resultantes estao
-- corretas e completas (uma por anexo, nenhum numero repetido), mas duas coisas seguiram o ID
-- em vez de seguir o DOCUMENTO:
--
-- BLOCO 1 — `has_bank_slip` (curadoria manual feita por Ricardo em 22/09 entre 12:29 e 12:35,
--   registrada em `audit_log`, ator 'jwt'). A marca ficou nas linhas 1617-1620, que hoje
--   descrevem parcelas da NF 1724 recem-criadas (nunca conferidas), enquanto os boletos que
--   FORAM conferidos (NF17351-5 a NF17354-5) foram para as contas 1658-1661, sem a marca.
--   Aqui ela volta a acompanhar o DOCUMENTO. Origem de cada valor:
--     marcados pelo usuario: NF17355-5 (1612) NF17242-10 (1614) NF17243-10 (1615)
--                            NF17351-5 (1658) NF17352-5 (1659) NF17353-5 (1660) NF17354-5 (1661)
--     nunca marcados:        NF17241-10 NF17244-10 NF17245-10 NF17246-10 NF17247-10
--                            NF17248-10 NF17249-10 NF172410-1
--
-- BLOCO 2 — ANEXO do documento anterior. As contas 1616-1620 ficaram com DOIS anexos: o do
--   documento que o id descrevia antes (ja vinculado a conta certa) e o seu proprio. O anexo
--   alheio sai por SOFT DELETE (padrao da 079: anexo nunca e apagado de verdade).
--
-- BLOCO 3 — `barcode` das 7 parcelas 1724 4-10. A 2a barreira do Vision (DV geral, criada
--   hoje) descartou o codigo que o modelo converteu errado — correto, e melhor que gravar
--   codigo falso. Mas a linha digitavel esta IMPRESSA e legivel nos PDFs: aqui ela e
--   transcrita e VALIDADA por tres testes independentes (DV geral fecha; valor embutido ==
--   `amount`; fator == `due_date` da conta), devolvendo a chave forte de deduplicacao.
--
-- EFEITO: so as colunas citadas. Nenhuma conta e criada ou removida.
-- Reexecucao = 0 linhas afetadas e sondas verdes.
-- =============================================================

BEGIN;

-- ── Estado esperado por DOCUMENTO (invoice_number), nunca por id ──────────────────────
CREATE TEMP TABLE _doc_144 (
  invoice   TEXT PRIMARY KEY,
  tem_bol   BOOLEAN NOT NULL,
  barcode   TEXT              -- NULL = a conta nao recebe codigo nesta migration
) ON COMMIT DROP;

INSERT INTO _doc_144 (invoice, tem_bol, barcode) VALUES
  ('NF17355-5',  TRUE,  NULL),
  ('NF17351-5',  TRUE,  NULL),
  ('NF17352-5',  TRUE,  NULL),
  ('NF17353-5',  TRUE,  NULL),
  ('NF17354-5',  TRUE,  NULL),
  ('NF17241-10', FALSE, NULL),
  ('NF17242-10', FALSE, NULL),   -- ja marcado; valor abaixo (TRUE) vem na linha seguinte
  ('NF17243-10', FALSE, NULL),
  ('NF17244-10', FALSE, '00195157900025092000000003580329000000433217'),
  ('NF17245-10', FALSE, '00197158000025092000000003580329000000433317'),
  ('NF17246-10', FALSE, '00191158300025092000000003580329000000433417'),
  ('NF17247-10', FALSE, '00191158400025092000000003580329000000433517'),
  ('NF17248-10', FALSE, '00193158500025092000000003580329000000433617'),
  ('NF17249-10', FALSE, '00195158600025092000000003580329000000433717'),
  ('NF172410-1', FALSE, '00197158700025092000000003580329000000433817');

-- NF17242-10 e NF17243-10 FORAM conferidos pelo usuario (audit_log 12:29:13 e 12:29:25) e
-- continuam nos ids originais — a correcao os mantem marcados.
UPDATE _doc_144 SET tem_bol = TRUE WHERE invoice IN ('NF17242-10', 'NF17243-10');

-- Contas do e-mail, resolvidas pelo DOCUMENTO.
CREATE TEMP TABLE _conta_144 ON COMMIT DROP AS
SELECT f.id, f.invoice_number, f.source_file, d.tem_bol, d.barcode
FROM   public.financial_account_control f
JOIN   _doc_144 d ON d.invoice = f.invoice_number
WHERE  split_part(f.gmail_message_id, '#', 1)
       = '<002101dd4a8c$5cf9e220$16eda660$@otimotex.com.br>';

-- ── Bloco 1 — a marca de boleto conferido volta ao documento ──────────────────────────
UPDATE public.financial_account_control f
   SET has_bank_slip = c.tem_bol
  FROM _conta_144 c
 WHERE f.id = c.id
   AND f.has_bank_slip <> c.tem_bol;

-- ── Bloco 2 — soft delete do anexo que pertence a OUTRA conta ─────────────────────────
-- O criterio e estrutural: o `storage_key` tem de ser o `source_file` da propria conta.
UPDATE public.financial_account_attachment a
   SET deleted_at = now()
  FROM public.financial_account_control f
 WHERE a.account_id = f.id
   AND a.deleted_at IS NULL
   AND f.id IN (SELECT id FROM _conta_144)
   AND a.storage_key <> f.source_file;

-- ── Bloco 3 — linha digitavel impressa devolvida as parcelas 4-10 ─────────────────────
UPDATE public.financial_account_control f
   SET barcode = c.barcode
  FROM _conta_144 c
 WHERE f.id = c.id
   AND c.barcode IS NOT NULL
   AND f.barcode IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Sondas — estado FINAL, dentro da transação.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n BIGINT;
BEGIN
  -- P0 (anti-vacuidade): os 15 documentos do e-mail casaram, um por anexo.
  SELECT count(*) INTO v_n FROM _conta_144;
  IF v_n <> 15 THEN RAISE EXCEPTION 'P0: % conta(s) casadas por documento, esperado 15', v_n; END IF;

  -- P1: a marca de boleto conferido bate com o esperado POR DOCUMENTO — 7 marcados.
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  JOIN   _conta_144 c ON c.id = f.id
  WHERE  f.has_bank_slip <> c.tem_bol;
  IF v_n <> 0 THEN RAISE EXCEPTION 'P1: % conta(s) com has_bank_slip fora do documento', v_n; END IF;

  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  JOIN   _conta_144 c ON c.id = f.id
  WHERE  f.has_bank_slip;
  IF v_n <> 7 THEN RAISE EXCEPTION 'P1b: % conta(s) marcadas, esperado 7', v_n; END IF;

  -- P2: cada conta tem EXATAMENTE um anexo vivo, e e o seu proprio arquivo.
  SELECT count(*) INTO v_n
  FROM   _conta_144 c
  WHERE  (SELECT count(*) FROM public.financial_account_attachment a
          WHERE a.account_id = c.id AND a.deleted_at IS NULL
            AND a.storage_key = c.source_file) <> 1;
  IF v_n <> 0 THEN RAISE EXCEPTION 'P2: % conta(s) sem o proprio anexo vinculado', v_n; END IF;

  SELECT count(*) INTO v_n
  FROM   public.financial_account_attachment a
  JOIN   _conta_144 c ON c.id = a.account_id
  WHERE  a.deleted_at IS NULL AND a.storage_key <> c.source_file;
  IF v_n <> 0 THEN RAISE EXCEPTION 'P2b: % anexo(s) alheio(s) ainda vivo(s)', v_n; END IF;

  -- P3: as 15 contas tem codigo de barras, e TODO codigo descreve a PROPRIA conta — DV geral
  -- fecha, valor embutido == amount e fator == due_date. A validacao roda aqui (e nao so na
  -- origem) porque os digitos foram TRANSCRITOS a mao nesta migration: um erro de transcricao
  -- gravaria outro codigo inventado, que e exatamente o defeito que ela corrige.
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  JOIN   _conta_144 c ON c.id = f.id
  WHERE  f.barcode IS NULL;
  IF v_n <> 0 THEN RAISE EXCEPTION 'P3: % conta(s) do e-mail sem codigo de barras', v_n; END IF;

  -- 🔴 O cruzamento FATOR x `due_date` vale so para os codigos ESCRITOS AQUI. Numa conta
  -- PRORROGADA os dois divergem POR DESENHO — e o caso da 1613 (impresso 05/10, fator 21/09),
  -- que a migration 143 acabou de corrigir. Exigir igualdade ali reprovaria exatamente o dado
  -- certo. Valor e DV, esses, valem para todas: nao dependem da prorrogacao.
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  JOIN   _conta_144 c ON c.id = f.id
  WHERE  substr(f.barcode, 10, 10)::bigint / 100.0 <> f.amount
     OR  (c.barcode IS NOT NULL
          AND DATE '2025-02-22' + (substr(f.barcode, 6, 4)::int - 1000) <> f.due_date)
     OR  (SELECT CASE WHEN (11 - soma % 11) IN (0, 10, 11) THEN 1 ELSE 11 - soma % 11 END
          FROM (SELECT sum(d::int * (((ord - 1) % 8) + 2)) AS soma
                FROM (SELECT ch AS d, row_number() OVER (ORDER BY i DESC) AS ord
                      FROM regexp_split_to_table(
                             substr(f.barcode, 1, 4) || substr(f.barcode, 6), '') WITH ORDINALITY AS t(ch, i)
                     ) s
               ) c2
         ) <> substr(f.barcode, 5, 1)::int;
  IF v_n <> 0 THEN RAISE EXCEPTION 'P3b: % codigo(s) que nao descrevem a propria conta', v_n; END IF;

  -- P4: nenhum codigo repetido no e-mail (dedup por barcode volta a ser confiavel).
  SELECT count(*) INTO v_n
  FROM   (SELECT f.barcode
          FROM   public.financial_account_control f
          JOIN   _conta_144 c ON c.id = f.id
          GROUP  BY f.barcode HAVING count(*) > 1) dup;
  IF v_n <> 0 THEN RAISE EXCEPTION 'P4: % codigo(s) repetido(s) entre as contas do e-mail', v_n; END IF;
END $$;

COMMIT;
