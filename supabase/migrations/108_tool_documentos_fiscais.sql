-- 108_tool_documentos_fiscais.sql
--
-- ONDA 3 (item 3.6) do roadmap — docs/roadmap-enriquecimento-dados.md
--
-- A migration 107 passou a guardar o documento fiscal, mas dado guardado não vira resposta
-- sozinho: o modelo só enxerga o que pode CHAMAR (regra transversal do roadmap). Esta é a
-- **9ª tool** — e a segunda que sai da tabela de contas, depois de `buscar_emails` (106).
--
-- O QUE ELA DESTRAVA
-- Perguntas hoje impossíveis em qualquer camada do sistema: "quantos CT-e a transportadora X
-- emitiu neste mês?", "recebi a NF-e número 19016?", "de quais emitentes vieram conhecimentos
-- de transporte em julho?". Antes desta onda esse dado não existia — o PDF era baixado,
-- descartado e, na purga seguinte, apagado.
--
-- ---------------------------------------------------------------------------
-- 🔴 INVARIANTE QUE A DESCRIÇÃO DA TOOL PRECISA CARREGAR
-- ---------------------------------------------------------------------------
-- Documento fiscal NUNCA soma em relatório financeiro. O frete já entra no sistema como
-- BOLETO e a NF-e é a origem da mercadoria, não a obrigação de pagamento — somar duplicaria
-- despesa. Por isso esta função não devolve valor monetário NENHUM: não é uma omissão, é a
-- barreira. Sem coluna de valor, não há como o modelo somar por engano.
--
-- ---------------------------------------------------------------------------
-- POR QUE `total_encontrado` VIAJA EM TODA LINHA
-- ---------------------------------------------------------------------------
-- Mesma armadilha do `gasto_por_fornecedor` (ranking truncado em 100, que o SYSTEM_PROMPT
-- proíbe somar): devolver 20 de 80 linhas e deixar o modelo CONTAR produz um número errado
-- com cara de certo. O `count(*) OVER ()` é avaliado ANTES do LIMIT, então cada linha carrega
-- o total verdadeiro do filtro — o modelo lê a contagem em vez de deduzi-la.
--
-- ---------------------------------------------------------------------------
-- SEGURANÇA
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER: a RLS da 107 (recorte por remetente, herdado da 078) se aplica sozinha.
-- Trocar para DEFINER exporia a caixa inteira ao grupo restrito. O JOIN com `supplier` também
-- roda como o usuário — `supplier` tem policy de SELECT para `authenticated` desde a 057.

CREATE OR REPLACE FUNCTION analytics.documentos_fiscais(
    p_tipo       text[]  DEFAULT NULL,   -- 'cte' | 'nfe' | 'cfe' | 'nfce'
    p_emitente   text    DEFAULT NULL,   -- CNPJ (com ou sem máscara) OU parte do nome do fornecedor
    p_date_from  date    DEFAULT NULL,   -- por data de RECEBIMENTO do e-mail
    p_date_to    date    DEFAULT NULL,
    p_numero     integer DEFAULT NULL,   -- número do documento (posições 25-33 da chave)
    p_limit      integer DEFAULT 20
)
RETURNS TABLE (
    total_encontrado  bigint,
    tipo              text,
    chave_acesso      text,
    numero            integer,
    serie             smallint,
    emitente_cnpj     text,
    emitente_nome     text,
    emissao           text,
    recebido_em       timestamptz,
    assunto_email     text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT
        count(*) OVER ()  AS total_encontrado,
        CASE d.model WHEN 55 THEN 'NF-e' WHEN 57 THEN 'CT-e'
                     WHEN 59 THEN 'CF-e' WHEN 65 THEN 'NFC-e'
                     ELSE d.model::text END,
        d.access_key::text,
        d.doc_number,
        d.series,
        d.emitter_cnpj::text,
        -- Enriquecimento: o CNPJ do emitente costuma já estar cadastrado como fornecedor.
        -- LEFT JOIN — documento fiscal de quem nunca emitiu boleto não tem cadastro, e isso
        -- não pode esconder a linha.
        COALESCE(s.trade_name, s.legal_name),
        -- AAMM da chave -> 'AAAA-MM', legível. É a emissão DECLARADA no documento, distinta
        -- de received_at (quando o e-mail chegou) — as duas divergem em reenvio.
        '20' || left(d.issue_yearmonth, 2) || '-' || right(d.issue_yearmonth, 2),
        d.received_at,
        d.subject
    FROM public.fiscal_document d
    LEFT JOIN public.supplier s
           ON s.cnpj = d.emitter_cnpj AND s.deleted_at IS NULL
    WHERE (p_tipo IS NULL OR d.model = ANY (
              SELECT CASE t WHEN 'nfe' THEN 55 WHEN 'cte' THEN 57
                            WHEN 'cfe' THEN 59 WHEN 'nfce' THEN 65
                            ELSE -1 END                    -- valor fora do domínio => vazio,
              FROM unnest(p_tipo) AS t))                   -- nunca "todos" por engano
      AND (p_emitente IS NULL
           OR d.emitter_cnpj = regexp_replace(p_emitente, '\D', '', 'g')
           OR public.normalize_search(COALESCE(s.trade_name, s.legal_name, ''))
              LIKE '%' || public.normalize_search(p_emitente) || '%')
      AND (p_date_from IS NULL OR d.received_at >= p_date_from)
      -- +1 dia: received_at é timestamptz e o parâmetro é date (mesma correção da 106).
      AND (p_date_to   IS NULL OR d.received_at < (p_date_to + 1))
      AND (p_numero    IS NULL OR d.doc_number = p_numero)
    ORDER BY d.received_at DESC NULLS LAST, d.id DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
$$;

COMMENT ON FUNCTION analytics.documentos_fiscais(text[], text, date, date, integer, integer) IS
  'Documentos fiscais eletrônicos recebidos por e-mail (NF-e, CT-e, CF-e, NFC-e), identificados '
  'pela chave de acesso. NÃO é conta a pagar e NÃO tem valor: o frete já entra como boleto. '
  'total_encontrado traz a contagem real do filtro, antes do LIMIT. Tool: documentos_fiscais.';

-- GRANT explícito + REVOKE explícito — guardrail 2 do roadmap, confirmado na Onda 1: o
-- PostgreSQL concede EXECUTE a PUBLIC por default e o ALTER DEFAULT PRIVILEGES da 098 não
-- persiste neste schema, então sem o REVOKE a função nasce chamável com a anon key pública.
GRANT  EXECUTE ON FUNCTION analytics.documentos_fiscais(text[], text, date, date, integer, integer) TO authenticated;
REVOKE EXECUTE ON FUNCTION analytics.documentos_fiscais(text[], text, date, date, integer, integer) FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO (executar após aplicar; em prosa — SQL comentado reprova o SonarCloud)
-- ---------------------------------------------------------------------------
--
--   1. `documentos_fiscais()` devolve linhas, e `total_encontrado` bate com a query de
--      controle `SELECT count(*) FROM public.fiscal_document` (oráculo diferencial).
--   2. `documentos_fiscais(ARRAY['cte'])` devolve só CT-e, e o total cai proporcionalmente.
--   3. Um tipo inexistente (ARRAY['xpto']) devolve VAZIO — nunca "todos".
--   4. `authenticated` tem EXECUTE; `anon` NÃO tem.
--   5. Com o papel `authenticated` de um usuário do grupo Comercial, o total é MENOR que o de
--      um irrestrito — prova de que o security_invoker propagou a RLS da 107.
