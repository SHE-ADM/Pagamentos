-- =============================================================
-- 044_backfill_doc_type_por_fornecedor.sql
-- Backfill: reclassifica document_type das contas ja gravadas cujo FORNECEDOR e uma
-- concessionaria conhecida (regra de negocio adicionada apos a 043):
--   enel / eletropaulo            -> conta de luz
--   vivo / claro / tim            -> conta de telefone / internet
--   sabesp                        -> conta de água
--
-- Projeto: pagamentos | Data: 2026-06-23
--
-- A marca casa contra supplier.trade_name/legal_name (financial_account_control nao
-- guarda mais o nome do fornecedor — JOIN por sk_supplier, migration 042). Palavra
-- inteira (\y...\y) para nao casar substring. So altera linhas cujo tipo difere.
-- Requer a 043 aplicada (os tipos 'conta de ...' precisam existir no CHECK).
-- =============================================================

BEGIN;

UPDATE financial_account_control f
   SET document_type = b.novo
  FROM (
    SELECT fa.id,
           CASE
             WHEN s.trade_name ~* '\y(enel|eletropaulo)\y'
               OR s.legal_name ~* '\y(enel|eletropaulo)\y' THEN 'conta de luz'
             WHEN s.trade_name ~* '\y(vivo|claro|tim)\y'
               OR s.legal_name ~* '\y(vivo|claro|tim)\y'    THEN 'conta de telefone / internet'
             WHEN s.trade_name ~* '\ysabesp\y'
               OR s.legal_name ~* '\ysabesp\y'              THEN 'conta de água'
           END AS novo
      FROM financial_account_control fa
      JOIN supplier s ON s.sk_supplier = fa.sk_supplier
  ) b
 WHERE f.id = b.id
   AND b.novo IS NOT NULL
   AND f.document_type IS DISTINCT FROM b.novo;

COMMIT;
