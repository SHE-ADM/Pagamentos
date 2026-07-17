-- 085_sk_company_fardos.sql
-- 3a empresa: OTIMOTEX FARDOS (sk_company = 3). Backfill das contas ja extraidas cujo
-- remetente/dono e a ester — decisao do usuario (2026-07-17):
--
--   1o  remetente ester@otimotex.com.br  -> sk_company = 3 (OTIMOTEX FARDOS)   <- VENCE tudo
--   2o  referencia a "lebianco"          -> sk_company = 2 (LEBIANCO)
--   3o  nenhum dos dois                  -> sk_company = 1 (OTIMOTEX TECIDOS)
--
-- A ester vence o DOMINIO otimotex.com.br E a mencao a lebianco. A regra em si vive no
-- Python (read_emails.py: FARDOS_SENDER/_is_fardos_sender/resolve_sk_company) — esta
-- migration so corrige os dados ja gravados.
--
-- Projeto: pagamentos | Data: 2026-07-17
--
-- SEM DDL: a linha sk_company=3 ja existe em `company` (cadastrada pelo usuario) e o
-- trigger da 084 ja respeita sk_company explicito (e e no-op no UPDATE) — por isso o valor
-- GRUDA e nao e revertido pela proxima curadoria. Idempotente (IS DISTINCT FROM 3):
-- re-run reporta 0 linhas.
--
-- Casa REMETENTE **OU** DONO (o "usuario e/ou remetente" do pedido). Hoje os dois dao o
-- mesmo conjunto (37 contas) porque created_by e resolvido a partir do sender_email; o OR
-- cobre um eventual descasamento (ex.: dono re-atribuido por re-varredura).

BEGIN;

UPDATE financial_account_control f
   SET sk_company = 3
 WHERE f.sk_company IS DISTINCT FROM 3
   AND (
         lower(f.sender_email) = 'ester@otimotex.com.br'
      OR f.created_by = (SELECT id FROM auth.users
                          WHERE lower(email) = 'ester@otimotex.com.br')
       );

COMMIT;

-- ============================================================================
-- VERIFICACAO (rodar apos aplicar):
--
--   -- (1) distribuicao (esperado: 3 -> 37 contas; 2 -> 55; o resto em 1):
--   SELECT sk_company, count(*) FROM financial_account_control GROUP BY 1 ORDER BY 1;
--
--   -- (2) nenhuma conta da ester ficou fora da FARDOS:
--   SELECT count(*) FROM financial_account_control
--    WHERE lower(sender_email) = 'ester@otimotex.com.br' AND sk_company <> 3;   -- 0
--
--   -- (3) o backfill GRUDA (fix do trigger da 084): UPDATE no-op nao reverte a empresa:
--   BEGIN;
--     UPDATE financial_account_control SET has_invoice = has_invoice
--      WHERE id = (SELECT id FROM financial_account_control
--                   WHERE lower(sender_email) = 'ester@otimotex.com.br' LIMIT 1);
--     SELECT sk_company FROM financial_account_control
--      WHERE id = (SELECT id FROM financial_account_control
--                   WHERE lower(sender_email) = 'ester@otimotex.com.br' LIMIT 1);  -- 3
--   ROLLBACK;
--
--   -- (4) idempotencia: reaplicar esta migration -> UPDATE 0.
-- ============================================================================
