-- 119_cte_content_onda5.sql
-- ONDA 5, item 5.3 — conteudo do CT-e (peso, rota, NF vinculada, frete) em `fiscal_document`.
--
-- POR QUE COLUNA, E NAO TABELA FILHA
--     O conteudo e 1:1 com o conhecimento de transporte: um CT-e tem um peso, uma origem, um
--     destino, um valor de frete. O item 5.1 do roadmap previa tabela filha porque falava de
--     ITENS DE NF-e, que sao 1:N — aquele item ficou suspenso por falta de populacao (15
--     documentos medidos). Criar tabela filha para dado 1:1 so acrescentaria um JOIN.
--
-- DE ONDE VEM O DADO (e por que so dessa fonte, por enquanto)
--     `skills/pdf-contas-pagar/scripts/cte_content.py`, lendo a FATURA AGREGADA da BRASPRESS —
--     10 PDFs, 55 CT-e, um unico emissor e um unico layout, com SUB-TOTAL impresso que serve de
--     oraculo. O DACTE individual (83 PDFs) tem layout diferente por transportadora e fica para
--     a etapa com LLM; `content_source` existe justamente para as duas fontes conviverem sem
--     que ninguem precise adivinhar qual delas produziu a linha.
--
-- 🔴 O VALOR DO FRETE AQUI E DECOMPOSICAO, NUNCA UMA SEGUNDA DESPESA
--     A fatura inteira JA esta em `financial_account_control` como conta a pagar (ela vem com
--     boleto). O frete por CT-e e a MESMA quantia vista por outro eixo — rota, destinatario,
--     nota fiscal. Somar `freight_amount` com `gasto_por_*` conta o mesmo dinheiro duas vezes.
--
--     Na Onda 3 a barreira era ESTRUTURAL (a tabela nao tinha coluna de valor). Ela passa a ser
--     DECLARADA: no SYSTEM_PROMPT, na descricao da tool e no COMMENT abaixo — e coberta por
--     guarda de teste em `regression.test.ts`, que reprova se a tool expuser valor sem que o
--     prompt carregue a advertencia. Sem essa guarda, a protecao seria so uma frase.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS, DROP/CREATE da funcao e sonda em transacao propria.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 1. Colunas de conteudo
-- ─────────────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.fiscal_document
  ADD COLUMN IF NOT EXISTS awb                  VARCHAR(16),
  ADD COLUMN IF NOT EXISTS origin               VARCHAR(8),
  ADD COLUMN IF NOT EXISTS destination          VARCHAR(8),
  ADD COLUMN IF NOT EXISTS service_date         DATE,
  -- Peso em kg. NUMERIC(12,3) porque a fatura imprime 2 casas mas o DACTE usa 3 (peso cubado).
  ADD COLUMN IF NOT EXISTS cargo_weight_kg      NUMERIC(12,3),
  -- Monetarios em NUMERIC(15,2) — padrao do workspace, nunca FLOAT.
  ADD COLUMN IF NOT EXISTS cargo_amount         NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS freight_amount       NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS linked_invoice       VARCHAR(20),
  ADD COLUMN IF NOT EXISTS receiver_name        VARCHAR(120),
  ADD COLUMN IF NOT EXISTS content_source       VARCHAR(30),
  ADD COLUMN IF NOT EXISTS content_extracted_at TIMESTAMPTZ;

COMMENT ON COLUMN public.fiscal_document.freight_amount IS
  'DECOMPOSICAO do frete da fatura que ja e conta a pagar — mesmo dinheiro por outro eixo. '
  'NUNCA somar com gasto_por_periodo/gasto_por_fornecedor: duplicaria a despesa.';
COMMENT ON COLUMN public.fiscal_document.cargo_amount IS
  'Valor da MERCADORIA transportada (informado no conhecimento). Nao e despesa nem obrigacao '
  'de pagamento — e a base de calculo do seguro/ad valorem.';
COMMENT ON COLUMN public.fiscal_document.content_source IS
  'Fonte do conteudo: braspress_invoice (fatura agregada, deterministico) ou dacte_llm (futuro).';
COMMENT ON COLUMN public.fiscal_document.linked_invoice IS
  'Numero da NF-e transportada. NULL quando o conhecimento cobre VARIAS notas ("DIVER." na '
  'fatura) — guardar o literal seria inventar uma nota que nao existe.';

-- Dominio fechado da procedencia. Sem o CHECK, um script futuro gravaria 'braspress' ou
-- 'BRASPRESS_INVOICE' e a analise por fonte passaria a depender de qual variante foi escrita.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_fiscal_content_source') THEN
    ALTER TABLE public.fiscal_document
      ADD CONSTRAINT chk_fiscal_content_source
      CHECK (content_source IS NULL OR content_source IN ('braspress_invoice', 'dacte_llm'));
  END IF;
END $$;

-- Consulta por rota e o caso de uso do 5.3 ("quanto custou o frete para o Rio?"). Parcial: hoje
-- 55 de 293 documentos tem conteudo, e a fracao seguira pequena enquanto o DACTE nao for lido.
CREATE INDEX IF NOT EXISTS ix_fiscal_document_rota
  ON public.fiscal_document (origin, destination)
  WHERE origin IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 2. Tool `documentos_fiscais` — passa a devolver o conteudo
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- DROP + CREATE e OBRIGATORIO: acrescentar coluna ao RETURNS TABLE muda o TIPO DE RETORNO, e o
-- PostgreSQL recusa CREATE OR REPLACE com 42P13. 🔴 O DROP APAGA OS GRANTS — reemitidos no fim
-- do arquivo. Foi a licao da migration 116; sem isso a funcao fica executavel por PUBLIC (default
-- do PostgreSQL) e INEXECUTAVEL por `authenticated`: aberta para quem nao deve, quebrada para
-- quem deve.

-- ⚠️ AS DUAS assinaturas precisam cair: a ANTIGA (6 parametros, sem `p_rota`) e a NOVA (7).
-- Sem o segundo DROP a migration NAO e re-executavel — na 2a passada a antiga ja nao existe, a
-- nova existe, o DROP nao acha nada e o CREATE morre com "function already exists with same
-- argument types". Medido ao reexecutar em 2026-08-12. E uma variante da armadilha da 116: la o
-- risco era perder os GRANTs, aqui e a idempotencia.
DROP FUNCTION IF EXISTS analytics.documentos_fiscais(text[], text, date, date, integer, integer);
DROP FUNCTION IF EXISTS analytics.documentos_fiscais(text[], text, date, date, integer, text, integer);

CREATE FUNCTION analytics.documentos_fiscais(
    p_tipo      text[]  DEFAULT NULL,
    p_emitente  text    DEFAULT NULL,
    p_date_from date    DEFAULT NULL,
    p_date_to   date    DEFAULT NULL,
    p_numero    integer DEFAULT NULL,
    p_rota      text    DEFAULT NULL,
    p_limit     integer DEFAULT 20
)
RETURNS TABLE (
    total_encontrado bigint,
    tipo             text,
    chave_acesso     text,
    numero           integer,
    serie            smallint,
    emitente_cnpj    text,
    emitente_nome    text,
    emissao          text,
    recebido_em      timestamptz,
    assunto_email    text,
    -- Conteudo (Onda 5 item 5.3). NULL = conteudo ainda nao extraido para este documento,
    -- distinto de "o documento nao tem peso" — a cobertura e parcial por construcao.
    rota             text,
    peso_kg          numeric,
    frete_rs         numeric,
    valor_mercadoria numeric,
    nf_vinculada     text,
    destinatario     text,
    data_servico     date
)
LANGUAGE sql
STABLE
SECURITY INVOKER          -- é isto que faz a RLS de fiscal_document (107) valer para o chat
SET search_path = ''
AS $function$
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
        d.subject,
        -- Rota so existe quando as duas pontas existem: "CCT->" seria uma rota inventada.
        CASE WHEN d.origin IS NOT NULL AND d.destination IS NOT NULL
             THEN d.origin || '->' || d.destination END,
        d.cargo_weight_kg,
        d.freight_amount,
        d.cargo_amount,
        d.linked_invoice::text,
        d.receiver_name::text,
        d.service_date
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
      -- Rota casa a ponta de origem OU a de destino: "para o Rio" é destino, mas o usuário
      -- também pergunta "saindo de SP". Comparação normalizada porque a sigla vem do emissor.
      AND (p_rota IS NULL
           OR upper(trim(p_rota)) IN (upper(d.origin), upper(d.destination))
           OR upper(trim(p_rota)) = upper(d.origin || '->' || d.destination))
    ORDER BY d.received_at DESC NULLS LAST, d.id DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
$function$;

-- Grants reemitidos (o DROP acima os levou junto). REVOKE explícito de PUBLIC/anon porque o
-- PostgreSQL concede EXECUTE a PUBLIC por default — não confiar no default privilege.
REVOKE ALL ON FUNCTION analytics.documentos_fiscais(text[], text, date, date, integer, text, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION analytics.documentos_fiscais(text[], text, date, date, integer, text, integer)
  TO authenticated;

COMMENT ON FUNCTION analytics.documentos_fiscais(text[], text, date, date, integer, text, integer) IS
  'Documentos fiscais recebidos por e-mail + conteudo de transporte (Onda 5). O frete devolvido '
  'e DECOMPOSICAO da fatura ja lancada como conta a pagar — nunca somar com gasto_por_*.';

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 3. SONDA — prova que a estrutura funciona, e ABORTA se nao funcionar
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Padrao das migrations 116/118. Roda em subtransacao e desfaz tudo: a verificacao nao pode
-- deixar residuo. Sem a sonda, "a migration aplicou" significaria apenas "o DDL nao deu erro".
-- A limpeza e por DELETE explicito, NAO por "RAISE EXCEPTION para forcar rollback": as proprias
-- verificacoes usam RAISE EXCEPTION (SQLSTATE P0001), entao um handler que capturasse P0001 para
-- desfazer a sonda engoliria tambem a falha que ela existe para detectar — a migration aplicaria
-- com a estrutura quebrada e a mensagem de sucesso no log. Se uma verificacao falhar, a excecao
-- sobe e a transacao da migration inteira e desfeita, levando o INSERT junto.
--
-- A chave e SINTETICA (numero de documento 999999999, ano 2699) porque as 55 chaves reais da
-- BRASPRESS ja estao na tabela: usar uma delas bateria na UNIQUE `access_key` e a sonda falharia
-- por colisao, nao por defeito.
DO $$
DECLARE
  v_chave text := '35' || '2699' || '48740351011442' || '57' || '000'
                       || '999999999' || '1' || '99999999' || '9';
  v_id      bigint;
  v_rota    text;
  v_frete   numeric;
  v_total   bigint;
  v_barrou  boolean := false;
BEGIN
  IF length(v_chave) <> 44 THEN          -- sanidade: a chave sintetica tem de ter 44 digitos
    RAISE EXCEPTION 'sonda 119: chave sintetica com % digitos', length(v_chave);
  END IF;

  -- (a) as colunas aceitam o formato que o parser produz
  INSERT INTO public.fiscal_document
    (access_key, model, uf_code, issue_yearmonth, emitter_cnpj, series, doc_number,
     awb, origin, destination, service_date, cargo_weight_kg, cargo_amount, freight_amount,
     linked_invoice, receiver_name, content_source, content_extracted_at)
  VALUES
    (v_chave, 57, 35, '2699', '48740351011442', 0, 999999999,
     '005709378', 'CCT', 'RIO', DATE '2026-07-14', 96.000, 24156.61, 652.60,
     '248632', 'HANDRED STUDIO COMERCIO LTDA', 'braspress_invoice', now())
  RETURNING id INTO v_id;

  -- (b) a tool devolve o conteudo e monta a rota
  SELECT rota, frete_rs, total_encontrado
    INTO v_rota, v_frete, v_total
    FROM analytics.documentos_fiscais(p_numero := 999999999, p_limit := 1);

  IF v_rota IS DISTINCT FROM 'CCT->RIO' THEN
    RAISE EXCEPTION 'sonda 119: rota esperada CCT->RIO, veio %', v_rota;
  END IF;
  IF v_frete IS DISTINCT FROM 652.60 THEN
    RAISE EXCEPTION 'sonda 119: frete esperado 652.60, veio %', v_frete;
  END IF;
  IF v_total IS NULL OR v_total < 1 THEN
    RAISE EXCEPTION 'sonda 119: total_encontrado invalido (%)', v_total;
  END IF;

  -- (c) o filtro de rota casa pelas duas pontas e recusa sigla inexistente
  PERFORM 1 FROM analytics.documentos_fiscais(p_rota := 'RIO', p_numero := 999999999);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sonda 119: filtro de rota por DESTINO nao casou';
  END IF;
  PERFORM 1 FROM analytics.documentos_fiscais(p_rota := 'CCT', p_numero := 999999999);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sonda 119: filtro de rota por ORIGEM nao casou';
  END IF;
  PERFORM 1 FROM analytics.documentos_fiscais(p_rota := 'ZZZ', p_numero := 999999999);
  IF FOUND THEN
    RAISE EXCEPTION 'sonda 119: filtro de rota aceitou sigla inexistente';
  END IF;

  -- (d) o CHECK barra procedencia fora do dominio. A subtransacao aqui e legitima: ela captura
  -- check_violation, uma condicao ESPECIFICA, nao a P0001 generica das verificacoes acima.
  BEGIN
    UPDATE public.fiscal_document SET content_source = 'braspress' WHERE id = v_id;
  EXCEPTION WHEN check_violation THEN
    v_barrou := true;
  END;
  IF NOT v_barrou THEN
    RAISE EXCEPTION 'sonda 119: CHECK de content_source nao barrou valor fora do dominio';
  END IF;

  DELETE FROM public.fiscal_document WHERE id = v_id;
  RAISE NOTICE 'sonda 119 OK — conteudo gravado, tool devolveu rota/frete, filtro e CHECK ativos';
END $$;
