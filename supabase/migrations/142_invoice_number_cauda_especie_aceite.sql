-- =============================================================
-- 142_invoice_number_cauda_especie_aceite.sql
-- Curadoria de dados (sem DDL): 5 contas com a Espécie/Aceite gravada junto do "Nº do Documento".
--
-- Projeto: pagamentos | Data: 2026-09-15
--
-- POR QUE EXISTE: `scripts/reprocess_document_number.py` rodou em modo real em 2026-09-15
-- (14:44–14:50 UTC, 338 contas) com o parser `extract_boleto_document_number` ainda defeituoso.
-- O regex admitia até 2 tokens de 1 a 5 letras entre o Nº e a Data de Processamento; com Aceite
-- "NAO ACEITO" ou Espécie "RECIBO" (6 letras), a cauda entrou no número:
--   15/06/2026 0008901683 RECIBO N 16/06/2026 04/26/104177433-1   → '0008901683 RECIBO'
--   19/06/2026 2306 DM NAO ACEITO 19/06/2026 0000000000120        → '2306 DM NAO ACEITO'
-- O parser foi corrigido (descarta os tokens finais sem dígito). Reexecutar o script NÃO repara
-- estas contas: o invoice_number delas deixou de ser a cópia do nosso número, então saíram da
-- seleção. Daí a correção dirigida.
--
-- Valores conferidos no PDF de cada conta (bucket `attachments`, 1 página cada), pela linha
-- crua da ficha e pelo extrator corrigido — as duas leituras coincidem:
--   123  (boleto, Editora Globo 1191)   '0008901683 RECIBO'  → '0008901683'
--   147  (cte,    SEVEN EXPRESS 1180)   '2306 DM NAO ACEITO' → '2306'
--   558  (boleto, Editora Globo 1191)   '0008951990 RECIBO'  → '0008951990'
--   1043 (cte,    TORRE S 1337)         '1808 DM NAO ACEITO' → '1808'
--   1051 (boleto, Editora Globo 1191)   '0009004814 RECIBO'  → '0009004814'
-- Nenhum dos valores corrigidos existe em outra conta (nem com sufixo "(N)").
--
-- EFEITO: só `invoice_number` das 5 contas. Situação, valores, fornecedor e classificação NÃO
-- mudam (todas pagas, status 8). A trigger de auditoria registra cada UPDATE (ator 'servico').
--
-- Cada UPDATE casa o valor ERRADO exato: reexecução = UPDATE 0 e sonda verde. Edição manual
-- posterior do invoice_number dessas contas faz a reexecução ABORTAR em P1, de propósito.
-- =============================================================

BEGIN;

-- ── Correção: (id, valor errado atual, valor correto do PDF) ────────────────────
CREATE TEMP TABLE _fix_142 (
  id           BIGINT PRIMARY KEY,
  valor_errado TEXT NOT NULL,
  valor_certo  TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO _fix_142 (id, valor_errado, valor_certo) VALUES
  (123,  '0008901683 RECIBO',  '0008901683'),
  (147,  '2306 DM NAO ACEITO', '2306'),
  (558,  '0008951990 RECIBO',  '0008951990'),
  (1043, '1808 DM NAO ACEITO', '1808'),
  (1051, '0009004814 RECIBO',  '0009004814');

-- ── Baseline: a linha INTEIRA antes do UPDATE (oráculo de "nada além do número mudou") ──
CREATE TEMP TABLE _baseline_142 ON COMMIT DROP AS
SELECT f.id, to_jsonb(f) AS linha
FROM   public.financial_account_control f
JOIN   _fix_142 x ON x.id = f.id;

-- ── UPDATE — só onde o valor atual é o errado exato ─────────────────────────────
UPDATE public.financial_account_control f
   SET invoice_number = x.valor_certo
  FROM _fix_142 x
 WHERE f.id = x.id
   AND f.invoice_number = x.valor_errado;

-- ─────────────────────────────────────────────────────────────────────────────
-- Sonda — estado FINAL, dentro da transação.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n BIGINT;
BEGIN
  -- P0 (anti-vacuidade): as 5 contas existem e entraram no baseline.
  SELECT count(*) INTO v_n FROM _baseline_142;
  IF v_n <> 5 THEN RAISE EXCEPTION 'P0: baseline com % conta(s), esperado 5', v_n; END IF;

  -- P1: as 5 estão com o valor conferido no PDF.
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  JOIN   _fix_142 x ON x.id = f.id
  WHERE  f.invoice_number = x.valor_certo;
  IF v_n <> 5 THEN RAISE EXCEPTION 'P1: % de 5 conta(s) com o valor corrigido', v_n; END IF;

  -- P2: NADA além do invoice_number mudou (oráculo = linha inteira do baseline). Colunas de
  -- escrituração carimbadas por trigger ficam fora da comparação.
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  JOIN   _baseline_142 b ON b.id = f.id
  WHERE  (to_jsonb(f)  - 'invoice_number' - 'updated_at' - 'updated_by')
      <> (b.linha      - 'invoice_number' - 'updated_at' - 'updated_by');
  IF v_n <> 0 THEN RAISE EXCEPTION 'P2: % conta(s) com outra coluna alterada', v_n; END IF;

  -- P3 (oráculo — a MESMA varredura que achou o defeito, restrita ao lote do script): nenhuma
  -- conta alterada pelo lote de 2026-09-15 14:44–14:50 UTC segue com cauda sem dígito.
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  WHERE  f.invoice_number ~ '\s[^\s\d]+$'
    AND  f.id IN (SELECT a.registro_id
                  FROM   public.audit_log a
                  WHERE  a.tabela = 'financial_account_control'
                    AND  a.campos_alterados @> ARRAY['invoice_number']
                    AND  a.criado_em >= '2026-09-15 14:40+00'
                    AND  a.criado_em <  '2026-09-15 14:55+00');
  IF v_n <> 0 THEN RAISE EXCEPTION 'P3: ainda ha % conta(s) do lote com cauda sem digito', v_n; END IF;
END $$;

COMMIT;
