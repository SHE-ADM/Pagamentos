-- 137_limpa_razao_social_pagadora_cdi.sql
-- CORRECAO DE DADOS: o cadastro sk_supplier = 404 (CDI) deixa de ter a RAZAO SOCIAL da pagadora.
--
-- Projeto: pagamentos | Data: 2026-09-14
--
-- Defeito (achado R3 do code review de 2026-09-14): o 404 e uma FILIAL da propria OTIMOTEX
-- (CNPJ 47273917000395, mesma raiz da pagadora) cadastrada como fornecedor "CDI", com
-- legal_name = "TEXTIL E CONFECCOES OTIMOTEX LTDA". A guarda Python `_is_own_company_name`
-- impede que esse nome chegue a RPC pelos fallbacks de nome de `_finalize_supplier`, mas o
-- fallback 6 (`_resolve_supplier_by_payer`) o envia DE PROPOSITO, para a conta cair na OTIMOTEX
-- (sk 1). O passo por nome de resolve_supplier_id casa normalize_search(legal_name) com LIMIT sem
-- ORDER BY: com dois cadastros com essa razao social (1 e 404), a conta podia ir para a CDI,
-- herdar a classificacao default dela (21/200) e ainda receber CNPJ/CPF pelo _enrich_supplier.
-- E o mesmo ima que a 136 desmontou no sk 4.
--
-- Medido antes (2026-09-14, leitura READ ONLY): so os cadastros 1 e 404 casam por nome (razao
-- social ou fantasia) a razao social de uma empresa pagadora; o 404 tem 1 conta, fechada. Sem o
-- 404, o casamento por nome passa a ser deterministico: sk 1.
--
-- Efeito: legal_name do 404 -> NULL (a coluna aceita NULL). O cadastro segue identificavel pelo
-- nome fantasia "CDI" e pelo CNPJ — o que satisfaz o refine do supplierUpdateSchema e mantem o
-- rotulo das telas (trade_name ?? legal_name). NAO muda CNPJ, classificacao, contatos nem a conta.
--
-- SEM DDL. Idempotente: o UPDATE e condicionado ao valor ERRADO (re-run = UPDATE 0) e a sonda
-- final vale igual na reexecucao.

SET client_encoding = 'UTF8';

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0) Trava — abortar aqui e o objetivo: limpar a razao social do cadastro errado nao da erro
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supplier
                  WHERE sk_supplier = 404 AND trade_name = 'CDI' AND cnpj = '47273917000395') THEN
    RAISE EXCEPTION '137: supplier 404 nao e o cadastro CDI medido (trade_name/CNPJ) — abortado';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Correcao
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE supplier
   SET legal_name = NULL
 WHERE sk_supplier = 404
   AND normalize_search(legal_name) = normalize_search('TEXTIL E CONFECCOES OTIMOTEX LTDA');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Sonda — aborta (e desfaz tudo) se o estado final nao for o esperado
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_imas int[];
BEGIN
  -- Cadastros que casam, pela MESMA normalizacao da RPC, a razao social de uma pagadora.
  SELECT array_agg(DISTINCT s.sk_supplier ORDER BY s.sk_supplier) INTO v_imas
    FROM supplier s
    JOIN company c
      ON normalize_search(s.legal_name) = normalize_search(c.legal_name)
      OR normalize_search(s.trade_name) = normalize_search(c.legal_name);

  -- P0: sanidade do casamento — o sk 1 (a propria OTIMOTEX, destino intencional do fallback 6)
  -- TEM de casar. Se nao casar, a normalizacao mudou e P1 passaria sem provar nada.
  IF v_imas IS NULL OR NOT (1 = ANY (v_imas)) THEN
    RAISE EXCEPTION '137/P0: o sk 1 nao casa a razao social da pagadora (obtido %) — sonda vazia',
      v_imas;
  END IF;

  -- P1: nenhum OUTRO cadastro casa por nome a razao social de uma pagadora. Um ima novo, criado
  -- depois da medicao, tambem aborta aqui — de proposito: a RPC voltaria a ser nao-deterministica.
  IF v_imas <> ARRAY[1] THEN
    RAISE EXCEPTION '137/P1: cadastros ainda casam a razao social de pagadora: %', v_imas;
  END IF;

  -- P2: o 404 perdeu SO a razao social — segue identificavel pelo nome fantasia e pelo CNPJ.
  IF NOT EXISTS (SELECT 1 FROM supplier
                  WHERE sk_supplier = 404 AND legal_name IS NULL
                    AND trade_name = 'CDI' AND cnpj = '47273917000395') THEN
    RAISE EXCEPTION '137/P2: o supplier 404 nao ficou no estado esperado';
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- VERIFICACAO (rodar apos aplicar):
--
--   SELECT sk_supplier, legal_name, trade_name, cnpj, cost_center_id, chart_account_id
--     FROM supplier WHERE sk_supplier IN (1, 404);
--
--   -- idempotencia: reaplicar esta migration -> UPDATE 0 e sonda verde.
-- ============================================================================
