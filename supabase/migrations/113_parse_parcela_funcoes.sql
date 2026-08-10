-- 113_parse_parcela_funcoes.sql
--
-- ONDA 6 (item 6.3, parte 1 de 2) do roadmap — docs/roadmap-enriquecimento-dados.md
--
-- PROBLEMA: o pipeline JÁ produz o número da parcela — `read_emails.py:5289` monta
-- `f"{inst['doc']}/{inst['parcela']}"` — mas o dado fica preso dentro de uma string. Não há como
-- perguntar "quais carnês estão em aberto" nem "falta alguma parcela deste documento".
--
-- Guardas deste arquivo: tests/test_onda6_campos_derivados.py (G4).
--
-- ---------------------------------------------------------------------------
-- 🔴 CORREÇÃO DO ROADMAP: `installment_total` NÃO EXISTE e não será criada
-- ---------------------------------------------------------------------------
-- O roadmap pede `installment_number` / `installment_total`. Verificado no código: o sufixo é o
-- ORDINAL da parcela, e o TOTAL não existe na origem — `inst['parcela']` vem da coluna "Parcela"
-- da tabela do corpo do e-mail, que traz 1, 2, 3. Os dados confirmam: `19019 / 1`, `19019 / 2` e
-- `19019 / 3` são TRÊS contas do mesmo documento.
--
-- Criar uma coluna chamada `installment_total` a partir desse sufixo escreveria "3 de 3" num carnê
-- de 12 — um número plausível, errado e sem erro nenhum. No lugar entra `installment_base` (o nº
-- do documento, que permite AGRUPAR o carnê) e, na migration 115, `analytics.parcelamentos()`, que
-- devolve `parcelas_observadas` e `parcelas_faltando` — o que se pode afirmar honestamente.
--
-- ---------------------------------------------------------------------------
-- 🔴 POR QUE ESTA MIGRATION NÃO CRIA COLUNA (o corte 113/114 é deliberado)
-- ---------------------------------------------------------------------------
-- Com a 113 aplicada e a 114 ainda não, a regra é 100% executável e mensurável sobre os 762
-- `invoice_number` reais SEM que uma única coluna exista. O portão de aceite (ver VERIFICAÇÃO) é
-- lido à mão antes de materializar qualquer coisa. Se a regra estiver errada, joga-se fora um
-- `CREATE OR REPLACE FUNCTION` — não um `ALTER TABLE` em 803 linhas.
--
-- ---------------------------------------------------------------------------
-- 🔴 GRANT EXECUTE PARA `authenticated` — sem isso, /consulta QUEBRA
-- ---------------------------------------------------------------------------
-- A expressão de uma coluna gerada é avaliada com o privilégio de QUEM ESCREVE A LINHA. E
-- `authenticated` escreve nesta tabela: has_invoice/has_bank_slip (grant por coluna, 033) e
-- status_id (068). Um UPDATE recomputa TODAS as colunas geradas STORED da linha — inclusive as da
-- migration 114, que chamam estas funções.
--
-- Sem o GRANT, marcar "Tem NF" numa conta passaria a devolver 42501 permission denied — num lugar
-- que não tem relação nenhuma com parcela. Modo de falha clássico "sintoma longe da causa".
--
-- IDEMPOTENTE (CREATE OR REPLACE FUNCTION). Reexecutar é no-op.

-- ---------------------------------------------------------------------------
-- Número da parcela (ordinal). NULL sempre que não for INEQUIVOCAMENTE uma parcela.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fac_installment_number(p_invoice text)
RETURNS smallint
LANGUAGE plpgsql
IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $$
DECLARE
    base    text;
    partes  text[];
    prefixo text;
    sufixo  text;
    n       integer;
BEGIN
    IF p_invoice IS NULL THEN RETURN NULL; END IF;

    -- PASSO 1 — descascar o desambiguador `(N)`.
    -- `unique_invoice_number` (read_emails.py:557-585) grava `base(2)`, `base(3)`… quando o número
    -- já existe. Sem descascar, uma regex ancorada em `$` devolveria NULL em `962148/002(2)` — e a
    -- parcela sumiria em silêncio justamente nas contas reemitidas, que são as mais interessantes.
    base := btrim(regexp_replace(btrim(p_invoice), '\(\d+\)$', ''));

    -- PASSO 2 — separar prefixo / sufixo. `.*?` não-guloso para que o ÚLTIMO '/' seja o separador.
    partes := regexp_match(base, '^(.*?)\s*/\s*(\d+)$');
    IF partes IS NULL THEN RETURN NULL; END IF;
    prefixo := btrim(partes[1]);
    sufixo  := partes[2];

    -- PASSO 3 — plausibilidade. TODOS têm de passar; qualquer reprovação devolve NULL.
    -- O viés é deliberado: parcela AUSENTE é uma pergunta sem resposta; parcela ERRADA é uma
    -- resposta errada, e o sistema não teria como saber.

    -- P1 — sufixo de 1 a 3 dígitos. Rejeita `09/00018287242` (11 dígitos: é nosso-número).
    IF length(sufixo) > 3 THEN RETURN NULL; END IF;

    -- P2 — faixa 1..120. Parcela 0 não existe; 120 é carnê de 10 anos, teto realista.
    -- Também BLINDA o cast: sem P1+P2, '00018287242'::smallint estouraria — e numa coluna gerada
    -- isso não é um valor ruim, é o INSERT inteiro morrendo (mesma lição do 22008 na 112).
    n := sufixo::integer;
    IF n < 1 OR n > 120 THEN RETURN NULL; END IF;

    -- P3 — prefixo com pelo menos 3 dígitos. Rejeita `09/12`: prefixo de 1-2 dígitos é código de
    -- carteira/banco/série, não número de documento.
    IF length(regexp_replace(prefixo, '\D', '', 'g')) < 3 THEN RETURN NULL; END IF;

    -- P4 — competência escrita como documento. Rejeita `2026/07`, `2025/12`.
    -- Custo assumido: um documento realmente numerado '2026' com parcela <= 12 vira NULL. É o lado
    -- certo do erro — preferimos perder uma parcela a inventar doze.
    IF prefixo ~ '^(19|20)\d{2}$' AND n <= 12 THEN RETURN NULL; END IF;

    -- P5 — data residual `dd/mm`. P1 já pega `10/08/2026` (sufixo de 4 dígitos); este é o cinto
    -- para o caso `10/8`, que P3 também rejeitaria. Redundância barata num parser que decide se um
    -- número entra ou não no sistema.
    IF prefixo ~ '^\d{1,2}/\d{1,2}$' THEN RETURN NULL; END IF;

    RETURN n::smallint;
END;
$$;

COMMENT ON FUNCTION public.fac_installment_number(text) IS
  'Ordinal da parcela extraído de invoice_number (padrão doc/parcela do reader), ou NULL quando '
  'não é INEQUIVOCAMENTE parcela. Descasca o sufixo (N) de unique_invoice_number e aplica 5 testes '
  'de plausibilidade. NÃO existe "total de parcelas" na origem — ver analytics.parcelamentos().';

-- ---------------------------------------------------------------------------
-- Documento-base do parcelamento (o que permite agrupar o carnê)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fac_installment_base(p_invoice text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $$
DECLARE
    partes text[];
BEGIN
    -- A DECISÃO é delegada: se não há parcela plausível, não há base. Delegar (em vez de repetir
    -- os 5 testes) torna a divergência entre as duas funções IMPOSSÍVEL por construção — uma
    -- segunda cópia da regra passaria a divergir na primeira alteração.
    IF public.fac_installment_number(p_invoice) IS NULL THEN RETURN NULL; END IF;

    partes := regexp_match(btrim(regexp_replace(btrim(p_invoice), '\(\d+\)$', '')),
                          '^(.*?)\s*/\s*(\d+)$');
    RETURN btrim(partes[1]);
END;
$$;

COMMENT ON FUNCTION public.fac_installment_base(text) IS
  'Número do documento sem o sufixo de parcela — a chave para agrupar as parcelas de um carnê. '
  'NULL exatamente quando fac_installment_number é NULL (a decisão é delegada a ela, para as duas '
  'não poderem divergir).';

-- ---------------------------------------------------------------------------
-- Grants — ver o bloco 🔴 no cabeçalho: `authenticated` PRECISA de EXECUTE
-- ---------------------------------------------------------------------------

GRANT  EXECUTE ON FUNCTION public.fac_installment_number(text) TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.fac_installment_base(text)   TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.fac_installment_number(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fac_installment_base(text)   FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- 🔴 AUTO-VERIFICAÇÃO — a migration ABORTA se a regra não reproduzir a amostra REAL
-- ---------------------------------------------------------------------------
-- Os vetores abaixo não são inventados: saíram de `SELECT invoice_number FROM
-- financial_account_control WHERE invoice_number ~ '\d+\s*/\s*\d+$'` em 2026-08-10. Os dois
-- primeiros são os falsos positivos que motivaram os cinco testes.

DO $$
DECLARE
    v      text;
    obtido smallint;
    casos  text[][] := ARRAY[
        -- entrada              , parcela esperada (NULL = tem de rejeitar)
        ['09/00018287242'       , NULL],   -- nosso-número, NÃO é parcela (P1)
        ['09/00018286636'       , NULL],   -- idem
        ['2026/07'              , NULL],   -- competência escrita como documento (P4)
        ['09/12'                , NULL],   -- prefixo curto = carteira/banco (P3)
        ['962148 / 03'          , '3'],
        ['959924 / 3'           , '3'],
        ['19019 / 1'            , '1'],
        ['19019 / 2'            , '2'],
        ['19019 / 3'            , '3'],
        ['962148/002'           , '2'],
        ['962148/002(2)'        , '2'],    -- sufixo (N) do unique_invoice_number
        ['sem barra nenhuma'    , NULL]
    ];
    i integer;
BEGIN
    FOR i IN 1 .. array_length(casos, 1) LOOP
        v      := casos[i][1];
        obtido := public.fac_installment_number(v);

        IF casos[i][2] IS NULL THEN
            IF obtido IS NOT NULL THEN
                RAISE EXCEPTION 'ABORTADO: % deveria ser rejeitado, veio %', v, obtido;
            END IF;
            IF public.fac_installment_base(v) IS NOT NULL THEN
                RAISE EXCEPTION 'ABORTADO: base de % deveria ser NULL', v;
            END IF;
        ELSE
            IF obtido IS DISTINCT FROM casos[i][2]::smallint THEN
                RAISE EXCEPTION 'ABORTADO: % deveria dar parcela %, veio %', v, casos[i][2], obtido;
            END IF;
            IF public.fac_installment_base(v) IS NULL THEN
                RAISE EXCEPTION 'ABORTADO: base de % não deveria ser NULL', v;
            END IF;
        END IF;
    END LOOP;

    -- As duas funções concordam SEMPRE (uma delega à outra) — conferido no dado real, não só nos
    -- vetores: nenhuma linha pode ter parcela sem base, nem base sem parcela.
    IF EXISTS (
        SELECT 1 FROM public.financial_account_control
         WHERE (public.fac_installment_number(invoice_number) IS NULL)
            <> (public.fac_installment_base(invoice_number)   IS NULL)
    ) THEN
        RAISE EXCEPTION 'ABORTADO: fac_installment_number e fac_installment_base divergem';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO (executar após aplicar; em prosa — SQL comentado reprova o SonarCloud)
-- ---------------------------------------------------------------------------
--
--   1. `provolatile` das duas funções = 'i'. Se vier 's', a migration 114 não consegue usá-las em
--      coluna gerada e o erro aparece só lá.
--   2. `has_function_privilege('anon', ..., 'EXECUTE')` = false para as duas;
--      `has_function_privilege('authenticated', ...)` = TRUE (ver o bloco 🔴 do cabeçalho).
--   3. 🔴 PORTÃO DE ACEITE — obrigatório ANTES de aplicar a 114. Listar, para os invoice_number que
--      contêm algo parecido com parcela, o par (entrada, parcela, documento) e LER AS LINHAS À MÃO.
--      São ~40. Previsão: 12 a 20 aceitos (oráculo independente: o roadmap §2.4 registrou 12 sobre
--      uma base de 609 contas; escalando para 803 dá ~16).
--      Fora da banda 8-25 => PARAR e replanejar (critério de parada do §3 do roadmap): abaixo, a
--      regra está apertada demais e perde carnê real; acima, está frouxa e inventa parcela.
--      Qualquer ACEITO que não seja parcela => apertar a regra, nunca relaxar o portão.
--   4. `get_advisors` sem achado novo.
