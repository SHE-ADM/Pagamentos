-- =============================================================
-- 132_doc_type_dar.sql
-- Novo document_type: 'dar' (Documento de Arrecadação) — guia de arrecadação
-- estadual/municipal GENÉRICA cujo cabeçalho imprime literalmente "DAR".
-- Caso de origem: conta id 1101, guia da Junta Comercial de Mato Grosso, cujo PDF
-- traz "DOCUMENTO DE ARRECADAÇÃO - DAR MODELO 1 - AUT" (SEFAZ-MT). Estende o CHECK
-- de financial_account_control.document_type.
--
-- Projeto: pagamentos | Data: 2026-08-19
--
-- 🔴 'dar' É PREFIXO DE 'darf'/'dare' E É VERBO COMUM DO PORTUGUÊS ("dar baixa",
-- "dar entrada", "padaria", "guardar"). Por isso o tipo é auto-classificado APENAS
-- por RÓTULO EXPLÍCITO — `_DOC_TYPE_NORM` em extract_pdf.py, que é lookup EXATO por
-- dict, alimentado pelo EXTRACTION_PROMPT ("copie EXATAMENTE o acrônimo IMPRESSO").
-- NENHUM classificador difuso casa a forma pura "dar":
--   * KEYWORDS/classify_document casa por SUBSTRING  -> "dar" pegaria "padaria";
--   * _SUBJECT_TAX_DOC_KEYWORDS e _BODY_DOC_KEYWORDS casam por PALAVRA INTEIRA
--     (_has_word) -> "dar" pegaria "favor dar baixa".
-- Nos três só entram FRASES inequívocas ("dar modelo 1", "dar-1", "dar/aut",
-- "dar avulso", "documento de arrecadacao estadual"). É o MESMO precedente de 'das'
-- (só casa por "simples nacional"/"simei") e de 'dam / duam' (só por "duam") —
-- acrônimo que colide com o português nunca casa na forma pura.
--
-- 'dar' NÃO entra em _TAX_SPHERE_CHART_CODES nem em _TAX_DOCTYPE_CHART_CODES:
-- "Documento de Arrecadação" é usado por estados E municípios, então o acrônimo não
-- determina a esfera. Mesma decisão já tomada para 'tributo' — sem esfera, não força
-- classificação. A forçada tem precedência máxima e faz WRITE-BACK no cadastro do
-- fornecedor, então errar ali se propaga para todas as contas futuras dele.
--
-- Idempotente (DROP IF EXISTS + recria o CHECK). O CHECK compara
-- lower(document_type), então o valor fica em minúsculo. SEM BACKFILL automático: a
-- reclassificação das guias já gravadas é feita à parte, após conferência humana
-- documento a documento (o acrônimo impresso é a única prova — JUCESP emite DARE e
-- JUCEPE emite DAE-PE, então "Junta Comercial" no texto NÃO indica o tipo).
--
-- ATENÇÃO (não regredir): 'pix' foi REMOVIDO do domínio pela migration 075 (pix é só
-- payment_method) + backfill pix->outro. A lista abaixo NÃO o inclui — deve espelhar
-- 1:1 o enum DOCUMENT_TYPES de @sheild/shared. Ao recriar o CHECK, copiar do enum,
-- nunca de uma versão pré-075. tests/test_doc_type_domain_consistency.py trava isso
-- lendo a migration de maior número que recria este constraint.
-- =============================================================

BEGIN;

ALTER TABLE financial_account_control
  DROP CONSTRAINT IF EXISTS financial_account_control_document_type_check;

ALTER TABLE financial_account_control
  ADD CONSTRAINT financial_account_control_document_type_check CHECK (
    lower(document_type) = ANY (ARRAY[
      'boleto', 'cte', 'nfe', 'nfse', 'seguro', 'fatura', 'recibo', 'contrato',
      'outro', 'darf', 'gps', 'das', 'gru', 'dae', 'dare', 'gnre', 'ipva', 'iptu',
      'dam / duam', 'iss', 'itbi', 'gare', 'tributo', 'multa', 'honorários',
      'container', 'cartório', 'cheque', 'comprovante',
      -- Documento de Arrecadacao generico (migration 132)
      'dar',
      -- Contas de concessionaria (migration 043)
      'conta de água', 'conta de luz', 'conta de telefone / internet'
    ]::text[])
  );

COMMIT;
