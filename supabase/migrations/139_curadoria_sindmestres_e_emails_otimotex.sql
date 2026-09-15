-- =============================================================
-- 139_curadoria_sindmestres_e_emails_otimotex.sql
-- Curadoria de dados (sem DDL): boleto SINDMESTRES e e-mails indevidos no cadastro da OTIMOTEX.
--
-- Projeto: pagamentos | Data: 2026-09-15
--
-- PARTE A — SINDMESTRES (já aplicada via psql em 2026-09-15; registrada aqui para rastreio e
-- idempotente: reexecutar dá UPDATE 0 e a sonda confere o estado final).
--   * Contas 895 e 1396 nasceram sob a OTIMOTEX (sk 1) pelo defeito que a migration 138
--     corrige; a 895 foi reapontada à mão com o plano 3/11 (ICMS Importação), igual à 420.
--   * O cadastro 1264 não tinha CNPJ e trazia o nome com erro ("MESTES"): nem o CNPJ nem o
--     nome lidos do boleto o casavam. Com o CNPJ, o boleto casa no 1º passo da RPC.
--   * Plano escolhido pelo usuário: 8/519 (RH / 69.1.01 Contribuições Sindicais) — o mesmo do
--     outro sindicato cadastrado (sk 118).
--
-- PARTE B — os 4 e-mails no cadastro da OTIMOTEX (sk 1). Nenhum é da OTIMOTEX:
--   padariabelga@gmail.com       → é da PANIFICADORA BELGA (1254)
--   controladoria@ophir.com.br   → é da OBER (249)
--   financeiro@acarolacbrand...  → cliente (comprovante da conta 194)
--   dalvana@ophir.com.br         → sem conta
-- Chegaram pelo fallback do PAGADOR: a sondagem enviava o `sender_email` junto e
-- `_add_supplier_email` o anexava ao cadastro da pagadora (corrigido no pipeline no mesmo
-- trabalho). No cadastro da OTIMOTEX eles SEQUESTRAM contas pelo passo 4 da RPC (e-mail,
-- `LIMIT` sem `ORDER BY`): um boleto da Panificadora podia ser lançado na própria pagadora.
--
-- Cada UPDATE casa o estado ANTERIOR exato; a sonda confere o estado FINAL. ⚠️ Uma edição
-- manual posterior nesses registros faz a REEXECUÇÃO abortar, de propósito (precedente 137).
-- =============================================================

BEGIN;

-- ── Parte A — SINDMESTRES ─────────────────────────────────────────────────────
UPDATE public.supplier
   SET cnpj             = '60938487000180',
       trade_name       = 'SINDICATO DOS TRABALHADORES MESTRES E CONTRAMESTRES',
       legal_name       = 'SINDICATO DOS TRABALHADORES MESTRES E CONTRAMESTRES',
       cost_center_id   = 8,
       chart_account_id = 519
 WHERE sk_supplier      = 1264
   AND COALESCE(cnpj, '') = ''
   AND trade_name       = 'SINDICATO DOS TRABALHADORES MESTES E CONTRAMESTRES';

UPDATE public.financial_account_control
   SET sk_supplier = 1264, cost_center_id = 8, chart_account_id = 519
 WHERE id = 1396 AND sk_supplier = 1 AND cost_center_id = 8 AND chart_account_id = 478;

UPDATE public.financial_account_control
   SET cost_center_id = 8, chart_account_id = 519
 WHERE id IN (420, 895) AND sk_supplier = 1264 AND cost_center_id = 3 AND chart_account_id = 11;

-- ── Parte B — e-mails fora do cadastro da OTIMOTEX ────────────────────────────
UPDATE public.supplier
   SET email  = CASE WHEN lower(trim(email))  IN ('financeiro@acarolacbrand.com.br', 'controladoria@ophir.com.br',
                                                  'dalvana@ophir.com.br', 'padariabelga@gmail.com')
                     THEN NULL ELSE email  END,
       email2 = CASE WHEN lower(trim(email2)) IN ('financeiro@acarolacbrand.com.br', 'controladoria@ophir.com.br',
                                                  'dalvana@ophir.com.br', 'padariabelga@gmail.com')
                     THEN NULL ELSE email2 END,
       email3 = CASE WHEN lower(trim(email3)) IN ('financeiro@acarolacbrand.com.br', 'controladoria@ophir.com.br',
                                                  'dalvana@ophir.com.br', 'padariabelga@gmail.com')
                     THEN NULL ELSE email3 END,
       email4 = CASE WHEN lower(trim(email4)) IN ('financeiro@acarolacbrand.com.br', 'controladoria@ophir.com.br',
                                                  'dalvana@ophir.com.br', 'padariabelga@gmail.com')
                     THEN NULL ELSE email4 END
 WHERE sk_supplier = 1
   AND lower(concat_ws(' ', email, email2, email3, email4))
       ~ '(financeiro@acarolacbrand\.com\.br|controladoria@ophir\.com\.br|dalvana@ophir\.com\.br|padariabelga@gmail\.com)';

-- ─────────────────────────────────────────────────────────────────────────────
-- Sonda — estado FINAL, dentro da transação.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n BIGINT;
BEGIN
  -- A1: cadastro 1264 com CNPJ, nome corrigido e plano 8/519.
  SELECT count(*) INTO v_n FROM public.supplier
   WHERE sk_supplier = 1264 AND cnpj = '60938487000180' AND cost_center_id = 8
     AND chart_account_id = 519 AND trade_name NOT LIKE '%MESTES%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'A1: cadastro 1264 fora do estado esperado'; END IF;

  -- A2: as três contas do sindicato no 1264 com 8/519.
  SELECT count(*) INTO v_n FROM public.financial_account_control
   WHERE id IN (420, 895, 1396) AND sk_supplier = 1264 AND cost_center_id = 8 AND chart_account_id = 519;
  IF v_n <> 3 THEN RAISE EXCEPTION 'A2: esperadas 3 contas SINDMESTRES em 1264 / 8-519, obtidas %', v_n; END IF;

  -- A3: o par centro x plano é lançável (a validação autoritativa da API é checkClassificationPair).
  PERFORM 1 FROM public.financial_chart_of_account
   WHERE chart_account_id = 519 AND cost_center_id = 8 AND is_postable;
  IF NOT FOUND THEN RAISE EXCEPTION 'A3: par 8/519 invalido ou nao lancavel'; END IF;

  -- B1: nenhum dos 4 e-mails continua no cadastro da OTIMOTEX.
  SELECT count(*) INTO v_n FROM public.supplier
   WHERE sk_supplier = 1
     AND lower(concat_ws(' ', email, email2, email3, email4))
         ~ '(acarolacbrand|@ophir\.com\.br|padariabelga)';
  IF v_n <> 0 THEN RAISE EXCEPTION 'B1: o cadastro da OTIMOTEX ainda guarda e-mail de terceiro'; END IF;

  -- B2 (não regredir): os donos reais mantêm os seus.
  SELECT count(*) INTO v_n FROM public.supplier
   WHERE (sk_supplier = 1254 AND 'padariabelga@gmail.com'     IN (lower(trim(email)), lower(trim(email2)), lower(trim(email3)), lower(trim(email4))))
      OR (sk_supplier = 249  AND 'controladoria@ophir.com.br' IN (lower(trim(email)), lower(trim(email2)), lower(trim(email3)), lower(trim(email4))));
  IF v_n <> 2 THEN RAISE EXCEPTION 'B2: PANIFICADORA BELGA (1254) ou OBER (249) perdeu o proprio e-mail'; END IF;
END $$;

COMMIT;
