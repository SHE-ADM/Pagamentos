-- 114_fac_parcelamento.sql
--
-- ONDA 6 (item 6.3, parte 2 de 2) do roadmap — docs/roadmap-enriquecimento-dados.md
--
-- Materializa em colunas o que a migration 113 provou saber calcular. Só existe porque o PORTÃO DE
-- ACEITE da 113 passou: sobre os 762 invoice_number reais, a regra aceitou **19** de 40 candidatos
-- (banda exigida: 8-25), e as 40 linhas foram lidas à mão em 2026-08-10.
--
--   Rejeitados corretamente: `09/00018287242` e família (nosso-número), `109/09116046` e família,
--   `112/250207258` e família — 21 linhas, nenhuma delas parcela.
--   Aceitos corretamente: 19, incluindo o carnê `962148` (parcelas 1/2/3, R$ 3.164,58 cada,
--   vencendo 01/07, 31/07 e 30/08 — cadência mensal perfeita).
--   Conferido também que NÃO há formato de parcela fora do conjunto candidato: os demais
--   invoice_number com barra são nosso-número (`009/06001081555-5`, `0001/112/0424368-1`).
--
-- Guardas deste arquivo: tests/test_onda6_campos_derivados.py (G1, G4).
--
-- ---------------------------------------------------------------------------
-- 🔴 COMO CORRIGIR A REGRA DEPOIS (o caminho errado apaga dado)
-- ---------------------------------------------------------------------------
-- Substituir `fac_installment_number` com CREATE OR REPLACE **não recalcula** os valores STORED já
-- gravados — a coluna fica com o resultado da regra ANTIGA, silenciosamente. O caminho correto é
-- DROP COLUMN + ADD COLUMN (o ADD recomputa a tabela inteira).
--
-- 🔴 NUNCA forçar recálculo com `UPDATE ... SET x = x`: isso dispara trg_fe_status_vencimento em
-- todas as linhas e pode REESCREVER situações — é o bug da migration 095 entrando pela porta dos
-- fundos. O ADD COLUMN não dispara trigger de linha.
--
-- IDEMPOTENTE (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS). Reexecutar é no-op.

ALTER TABLE public.financial_account_control
    ADD COLUMN IF NOT EXISTS installment_number smallint
    GENERATED ALWAYS AS (public.fac_installment_number(invoice_number)) STORED;

COMMENT ON COLUMN public.financial_account_control.installment_number IS
  'Ordinal da parcela (1, 2, 3...), derivado de invoice_number pela regra da migration 113. NULL '
  'quando o número não é INEQUIVOCAMENTE parcela — 21 dos 40 candidatos da base são nosso-número. '
  'NÃO existe coluna de TOTAL: o total não está na origem (o reader grava doc/ordinal). Para '
  '"quantas parcelas tem este documento", use analytics.parcelamentos(), que devolve o OBSERVADO '
  'e as parcelas FALTANDO.';

ALTER TABLE public.financial_account_control
    ADD COLUMN IF NOT EXISTS installment_base text
    GENERATED ALWAYS AS (public.fac_installment_base(invoice_number)) STORED;

COMMENT ON COLUMN public.financial_account_control.installment_base IS
  'Número do documento sem o sufixo de parcela — chave para agrupar o carnê. NULL exatamente '
  'quando installment_number é NULL.';

-- Índice pensado para a pergunta real ("as parcelas deste documento, deste fornecedor"), não para
-- a coluna isolada. Parcial: só ~19 linhas em 803 têm parcela.
CREATE INDEX IF NOT EXISTS ix_fac_installment_base
    ON public.financial_account_control (sk_supplier, installment_base)
    WHERE installment_number IS NOT NULL;

-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO (executar após aplicar; em prosa — SQL comentado reprova o SonarCloud)
-- ---------------------------------------------------------------------------
--
--   1. As duas colunas existem com attgenerated = 's'.
--   2. 🔴 ORÁCULO DIFERENCIAL — o mais forte desta onda: a contagem de `installment_number IS NOT
--      NULL` na COLUNA tem de ser idêntica à contagem pela FUNÇÃO (19 na aplicação). Mesma regra,
--      dois caminhos de avaliação. Divergência significa que a coluna não está usando a função —
--      e é o único sintoma que isso produziria.
--   3. Nenhuma linha com parcela sem base, nem base sem parcela (as funções delegam uma à outra).
--   4. PROVA do caminho REAL de escrita, obrigatória depois desta migration:
--      `py -3 scripts\reprocess_message.py <message_id já processado>` — INSERT de verdade por
--      register_financial. Ausência de 428C9 (coluna gerada citada em INSERT) é o que se busca.
--   5. 🔴 PROVA DO GRANT: alternar NF/Boleto numa conta em /consulta logado como usuário real. O
--      UPDATE de `authenticated` recomputa TODAS as colunas geradas da linha, inclusive estas duas,
--      que chamam funções — sem o GRANT EXECUTE da migration 113 isso devolveria 42501 num lugar
--      sem relação com parcela.
--   6. `get_advisors` sem achado novo.
