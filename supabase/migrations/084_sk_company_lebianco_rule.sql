-- 084_sk_company_lebianco_rule.sql
-- Empresa pagadora (sk_company) pela regra LEBIANCO + correcao do trigger que
-- sobrescrevia o valor. Decisao do usuario (2026-07-17):
--
--   e-mail com REFERENCIA a "lebianco" (assunto, corpo, ANEXO, remetente ou dominio
--   do remetente) -> sk_company = 2 (LEBIANCO); SEM mencao -> SEMPRE 1 (OTIMOTEX).
--   A REFERENCIA VENCE a busca por CNPJ: a conta pode ser da LEBIANCO com o CNPJ da
--   OTIMOTEX impresso no boleto. Logo, CNPJ sozinho NAO classifica.
--
-- A deteccao vive no Python (read_emails.py: resolve_sk_company/apply_sk_company), unico
-- ponto que enxerga assunto + corpo + anexo + remetente. Esta migration faz as DUAS coisas
-- que o banco precisa: (1) parar de sobrescrever o que o Python grava e (2) corrigir os
-- dados ja extraidos.
--
-- Projeto: pagamentos | Data: 2026-07-17
--
-- ORDEM INTERNA IMPORTA (nao reordenar): o fix do trigger (secao 1) vem ANTES do backfill
-- (secao 2) — invertido, o proprio trigger reverteria silenciosamente o UPDATE do backfill.
--
-- Idempotente (CREATE OR REPLACE + UPDATE com IS DISTINCT FROM). Aplicacao manual.

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- 1. Trigger passa a RESPEITAR sk_company explicito
-- ─────────────────────────────────────────────────────────────
-- ANTES (083): atribuicao INCONDICIONAL —
--   NEW.sk_company := resolve_company_sk(NEW.payer_cnpj, NEW.payer_name);
-- Dois defeitos provados contra o banco:
--   (a) o valor gravado pelo Python era DESCARTADO (a regra LEBIANCO nunca pegaria);
--   (b) QUALQUER update re-resolvia a empresa — um UPDATE no-op
--       (SET has_invoice = has_invoice) na conta 267 mudava sk_company de 1 para 2.
--       Ou seja: a curadoria de NF/BOL revertia a empresa e o backfill nao grudaria.
--
-- DEPOIS: so resolve quando o caller NAO informou (sk_company IS NULL).
--   - INSERT do pipeline (com sk_company)  -> respeitado (a regra do Python manda).
--   - INSERT manual (CRUD da Next API, que nao grava sk_company nem payer_*) -> NULL ->
--     resolve -> payer_* nulos -> fallback company_id=1 (OTIMOTEX). Comportamento atual.
--   - UPDATE -> NEW.sk_company nunca e NULL (coluna NOT NULL) -> NO-OP -> PRESERVA.
--
-- Mantem SECURITY DEFINER + search_path fixo + chamada QUALIFICADA (licao da 074: sem isso
-- o UPDATE de curadoria pelo papel `authenticated` quebra com 42501 ao chamar a funcao).
-- resolve_company_sk NAO muda (segue como fallback de quem nao informa a empresa).
CREATE OR REPLACE FUNCTION public.trg_fe_resolve_company()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.sk_company IS NULL THEN
    NEW.sk_company := public.resolve_company_sk(NEW.payer_cnpj, NEW.payer_name);
  END IF;
  RETURN NEW;
END;
$function$;

-- ─────────────────────────────────────────────────────────────
-- 2. Backfill: contas ja extraidas -> sk_company = 2 pela regra
-- ─────────────────────────────────────────────────────────────
-- Fontes: financial_account_control + email_control (LEFT JOIN por message_id). O JOIN e
-- NECESSARIO porque o CORPO do e-mail nao e persistido na fac no caminho de PDF — so no
-- caminho do corpo (email_body_excerpt). email_control.body_preview sozinho traz +15 contas.
--
-- payer_cnpj NAO entra (regra estrita: a referencia vence o CNPJ). supplier_name tambem
-- NAO entra: sk_company (PAGADORA) e independente do FORNECEDOR — se a LEBIANCO for o
-- fornecedor, quem paga e a OTIMOTEX.
--
-- "LE BIANCO" (com ESPACO) so no ASSUNTO — espelha _subject_has_lebianco do Python. No
-- assunto e referencia deliberada ("LE BIANCO - PAGAMENTO FORNECEDOR"); no CORPO aparece na
-- ASSINATURA do grupo ("Departamento Financeiro | Otimotex / Le Bianco") e marcaria contas
-- da OTIMOTEX (falso positivo real: conta 167, assunto "COBRANCA OTIMOTEX TECIDO").
--
-- Idempotente: IS DISTINCT FROM 2 (re-run reporta 0 linhas).
UPDATE financial_account_control f
   SET sk_company = 2
  FROM (SELECT message_id, subject, sender_email, body_preview, attachment_names
          FROM email_control) e
 WHERE e.message_id = f.gmail_message_id
   AND f.sk_company IS DISTINCT FROM 2
   AND (   f.subject            ILIKE '%lebianco%'
        OR f.subject            ILIKE '%le bianco%'   -- grafia com espaco: SO no assunto
        OR f.sender_email       ILIKE '%lebianco%'
        OR f.email_body_excerpt ILIKE '%lebianco%'
        OR f.description        ILIKE '%lebianco%'
        OR f.source_file        ILIKE '%lebianco%'
        OR f.payer_name         ILIKE '%lebianco%'
        OR e.subject            ILIKE '%lebianco%'
        OR e.subject            ILIKE '%le bianco%'   -- idem
        OR e.sender_email       ILIKE '%lebianco%'
        OR e.body_preview       ILIKE '%lebianco%'
        OR e.attachment_names   ILIKE '%lebianco%');

-- Contas SEM e-mail correspondente em email_control (o JOIN acima nao as alcanca):
-- aplica a regra so com os campos da propria conta.
UPDATE financial_account_control f
   SET sk_company = 2
 WHERE f.sk_company IS DISTINCT FROM 2
   AND NOT EXISTS (SELECT 1 FROM email_control e WHERE e.message_id = f.gmail_message_id)
   AND (   f.subject            ILIKE '%lebianco%'
        OR f.subject            ILIKE '%le bianco%'   -- grafia com espaco: SO no assunto
        OR f.sender_email       ILIKE '%lebianco%'
        OR f.email_body_excerpt ILIKE '%lebianco%'
        OR f.description        ILIKE '%lebianco%'
        OR f.source_file        ILIKE '%lebianco%'
        OR f.payer_name         ILIKE '%lebianco%');

COMMIT;

-- ============================================================================
-- VERIFICACAO (rodar apos aplicar):
--
--   -- (1) distribuicao (esperado: 2 -> 55 contas; o resto em 1):
--   SELECT sk_company, count(*) FROM financial_account_control GROUP BY 1 ORDER BY 1;
--
--   -- (2) REGRA ESTRITA: a conta 267 (payer_cnpj = CNPJ da LEBIANCO, sem mencao)
--   --     PERMANECE em 1 — o CNPJ sozinho nao classifica:
--   SELECT id, sk_company, payer_cnpj FROM financial_account_control WHERE id = 267;  -- 1
--
--   -- (3) O FIX DO TRIGGER: um UPDATE no-op NAO pode mais mudar sk_company
--   --     (antes da 084 este teste mudava a 267 de 1 para 2):
--   BEGIN;
--     UPDATE financial_account_control SET has_invoice = has_invoice WHERE id = 267;
--     SELECT sk_company FROM financial_account_control WHERE id = 267;   -- 1 (preservado)
--   ROLLBACK;
--
--   -- (4) INSERT sem sk_company continua caindo no fallback (OTIMOTEX):
--   SELECT public.resolve_company_sk(NULL, NULL);   -- 1
--
--   -- (5) SEGURANCA (licao 074): a curadoria pelo papel `authenticated` nao levanta 42501:
--   BEGIN;
--     SET LOCAL ROLE authenticated;
--     UPDATE financial_account_control SET has_invoice = has_invoice
--     WHERE id = (SELECT id FROM financial_account_control LIMIT 1);
--   ROLLBACK;
--
--   -- (6) funcao do trigger segue SECURITY DEFINER:
--   SELECT proname, prosecdef FROM pg_proc WHERE proname = 'trg_fe_resolve_company';  -- true
-- ============================================================================
