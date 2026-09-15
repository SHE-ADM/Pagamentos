-- =============================================================
-- 140_guias_contribuinte_para_otimotex.sql
-- Curadoria de dados (sem DDL): guias de tributo gravadas sob cadastros-APELIDO da pagadora.
--
-- Projeto: pagamentos | Data: 2026-09-15
--
-- POR QUE EXISTE: numa guia de tributo (GNRE/DARF) a única razão social impressa além do
-- Fisco é a do CONTRIBUINTE — a própria pagadora ("TEXTIL E CONFECCOES OTIMOTEX LTDA",
-- 47.273.917/0001-23). A extração devolvia esse bloco como FORNECEDOR (nome + CNPJ). O
-- pipeline descartava o CNPJ pela raiz da pagadora, mas mantinha o NOME extraído junto dele,
-- e o nome casava por texto:
--   * sk 4 (LEBIANCO), cuja legal_name ERA a razão social da pagadora até a migration 136 —
--     guias 782/785/786 (07/2026), 1388 (DARF), 1429/1432/1438 (09/2026);
--   * sk 1400 "TEXTIL E CONFECES OTIMOTEX LTDA" — a GUIA imprime o nome com erro de grafia; a
--     guarda de razão social (igualdade exata) não o pegou e o auto-insert criou o cadastro —
--     guias 1389/1390/1393/1394/1395;
--   * sk 1415 "TEXTIL E CONFECCOES OTIMOTEX" (sem LTDA) — guia 1480, criada horas antes do
--     deploy da guarda de 14/09.
-- As mesmas guias do mesmo e-mail caíram parte no sk 1, parte num apelido, conforme a leitura
-- do modelo — por isso a correção de CÓDIGO descarta o nome pelo CNPJ (sinal forte), não pela
-- grafia. O texto de todos os 13 PDFs foi conferido: contribuinte = OTIMOTEX, sem favorecido.
--
-- EFEITO:
--   1. As 13 guias vão para a OTIMOTEX (sk 1), destino da regra de imposto. cost_center_id /
--      chart_account_id NÃO mudam: a classificação de guia é FORÇADA pelo tipo do tributo,
--      não pelo fornecedor.
--   2. 1400 e 1415 recebem soft delete: são a própria pagadora com grafia de guia, sem conta
--      restante. ⚠️ A RPC de resolução não filtra `deleted_at` no passo por nome — o que
--      impede o nome de voltar a chegar lá é a regra do contribuinte no pipeline.
--   3. sk 4 (LEBIANCO) NÃO é removido: é nome fantasia de fornecedor legítimo (decisão
--      registrada na 136). A classificação default dele (3/33) foi escrita por write-back
--      dessas guias e fica como está — o valor original não é recuperável pela trilha.
--
-- Cada UPDATE casa o estado ANTERIOR; a sonda confere o estado FINAL com a MESMA varredura
-- que encontrou o problema (oráculo). Reexecução: UPDATE 0 e sonda verde.
-- =============================================================

BEGIN;

-- ── 1. Guias do contribuinte → OTIMOTEX ─────────────────────────────────────────
UPDATE public.financial_account_control
   SET sk_supplier = 1
 WHERE id IN (782, 785, 786, 1388, 1429, 1432, 1438, 1389, 1390, 1393, 1394, 1395, 1480)
   AND sk_supplier IN (4, 1400, 1415)
   AND document_type IN ('gnre', 'darf');

-- ── 2. Soft delete dos cadastros-apelido sem conta ──────────────────────────────
UPDATE public.supplier s
   SET deleted_at = now()
 WHERE s.sk_supplier IN (1400, 1415)
   AND s.deleted_at IS NULL
   AND COALESCE(s.cnpj, '') = ''
   AND normalize_search(s.trade_name) LIKE '%otimotex%'
   AND NOT EXISTS (SELECT 1 FROM public.financial_account_control f WHERE f.sk_supplier = s.sk_supplier);

-- ─────────────────────────────────────────────────────────────────────────────
-- Sonda — estado FINAL, dentro da transação.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n BIGINT;
BEGIN
  -- P1: as 13 guias estão na OTIMOTEX.
  SELECT count(*) INTO v_n FROM public.financial_account_control
   WHERE id IN (782, 785, 786, 1388, 1429, 1432, 1438, 1389, 1390, 1393, 1394, 1395, 1480)
     AND sk_supplier = 1;
  IF v_n <> 13 THEN RAISE EXCEPTION 'P1: esperadas 13 guias na OTIMOTEX, obtidas %', v_n; END IF;

  -- P2 (oráculo — a MESMA varredura que achou o defeito): nenhuma guia de tributo fora do sk 1
  -- sob cadastro cujo nome lembra uma pagadora ou cujo CNPJ tem a raiz de uma.
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  JOIN   public.supplier s ON s.sk_supplier = f.sk_supplier
  WHERE  f.sk_supplier <> 1
    AND  f.document_type IN ('darf','das','gru','dae','gnre','ipva','iptu','dar / dare',
                             'dam / duam','iss','itbi','gare','tributo')
    AND  (normalize_search(concat_ws(' ', s.trade_name, s.legal_name)) ~ '(otimotex|lebianco|le ?blanc)'
          OR left(s.cnpj, 8) IN (SELECT left(c.cnpj, 8) FROM public.company c WHERE c.cnpj IS NOT NULL));
  IF v_n <> 0 THEN RAISE EXCEPTION 'P2: ainda ha % guia(s) de tributo sob cadastro-apelido da pagadora', v_n; END IF;

  -- P3: os apelidos estão removidos e sem conta.
  SELECT count(*) INTO v_n FROM public.supplier s
   WHERE s.sk_supplier IN (1400, 1415) AND s.deleted_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.financial_account_control f WHERE f.sk_supplier = s.sk_supplier);
  IF v_n <> 2 THEN RAISE EXCEPTION 'P3: cadastros 1400/1415 fora do estado esperado (% de 2)', v_n; END IF;

  -- P4 (não regredir): sk 4 continua ativo — é fornecedor legítimo por nome fantasia.
  PERFORM 1 FROM public.supplier WHERE sk_supplier = 4 AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'P4: o cadastro 4 (LEBIANCO) foi removido — nao era para ser'; END IF;
END $$;

COMMIT;
