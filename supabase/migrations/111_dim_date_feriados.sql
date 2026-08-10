-- 111_dim_date_feriados.sql
--
-- ONDA 6 (item 6.2) do roadmap — docs/roadmap-enriquecimento-dados.md
--
-- PROBLEMA: o sistema responde "vence em 12/08", mas não responde "quantos DIAS ÚTEIS faltam" nem
-- "esse vencimento cai em feriado" — e vencimento em dia não-útil é vencimento no PRÓXIMO dia útil
-- para efeito bancário. Não há calendário em lugar nenhum: varredura de 2026-08-10 confirmou 0
-- ocorrências de dim_/calendar/feriado/holiday nas 110 migrations anteriores. Greenfield.
--
-- Guardas deste arquivo: tests/test_onda6_campos_derivados.py (G3).
--
-- ---------------------------------------------------------------------------
-- DECISÃO: a FUNÇÃO é a verdade; a TABELA é o índice
-- ---------------------------------------------------------------------------
-- Nem "só função" nem "só tabela":
--   - `br_easter` / `br_holiday_name` são IMMUTABLE e respondem para QUALQUER ano, então não
--     existe buraco de cobertura conceitual — perguntar por 2071 funciona.
--   - `dim_date` é o que se JOINa e indexa, e é o que faz `dias_uteis()` ser varredura de índice
--     em vez de milhares de chamadas de função.
--   - A tabela é semeada PELAS funções, e o bloco de verificação no fim compara as duas
--     (oráculo diferencial embutido: se divergirem, a migration ABORTA).
--
-- ---------------------------------------------------------------------------
-- 🔴 IMMUTABLE não é enfeite: `to_char` está PROIBIDO aqui
-- ---------------------------------------------------------------------------
-- `to_char(date, text)` é STABLE (depende de `lc_time`, configuração de sessão). Usá-lo tornaria o
-- nome do mês dependente de quem executou o INSERT — dois valores diferentes para a mesma data,
-- conforme a sessão. Os nomes em pt-BR saem de CASE explícito, que é determinístico e ainda evita
-- depender do locale do servidor. Mesma família da lição de `to_tsvector` na migration 105.
--
-- ---------------------------------------------------------------------------
-- ESCOPO DO CALENDÁRIO: fechamento BANCÁRIO, não "feriado por lei"
-- ---------------------------------------------------------------------------
-- Carnaval e Corpus Christi NÃO são feriados nacionais por lei — são ponto facultativo. Mas o
-- sistema bancário FECHA nesses dias, e o que importa para conta a pagar é se o dinheiro anda.
-- `is_business_day` segue o calendário bancário (padrão Febraban); `holiday_kind` distingue
-- 'nacional' (lei) de 'bancario' (fechamento sem lei federal), para quem precisar da diferença.
--
-- Consciência Negra (20/11) só é feriado NACIONAL a partir de 2024 (Lei 14.759/2023). Antes disso
-- era estadual/municipal. A função respeita a data de vigência — inventar o feriado para 2015
-- produziria "dia não útil" onde os bancos operaram normalmente.
--
-- IDEMPOTENTE (CREATE OR REPLACE FUNCTION / CREATE TABLE IF NOT EXISTS / INSERT ... ON CONFLICT
-- DO NOTHING / CREATE INDEX IF NOT EXISTS). Reexecutar é no-op.

-- ---------------------------------------------------------------------------
-- 1. Páscoa — algoritmo Gregoriano Anônimo (Meeus/Jones/Butcher)
-- ---------------------------------------------------------------------------
-- Só aritmética inteira: nenhuma dependência de locale, timezone ou configuração de sessão.
-- É o que permite marcar IMMUTABLE com sinceridade.

CREATE OR REPLACE FUNCTION public.br_easter(p_year integer)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE STRICT PARALLEL SAFE
SET search_path = ''
AS $$
DECLARE
    a integer; b integer; c integer; d integer; e integer;
    f integer; g integer; h integer; i integer; k integer;
    l integer; m integer; mes integer; dia integer;
BEGIN
    a := p_year % 19;
    b := p_year / 100;
    c := p_year % 100;
    d := b / 4;
    e := b % 4;
    f := (b + 8) / 25;
    g := (b - f + 1) / 3;
    h := (19 * a + b - d - g + 15) % 30;
    i := c / 4;
    k := c % 4;
    l := (32 + 2 * e + 2 * i - h - k) % 7;
    m := (a + 11 * h + 22 * l) / 451;
    mes := (h + l - 7 * m + 114) / 31;
    dia := ((h + l - 7 * m + 114) % 31) + 1;
    RETURN make_date(p_year, mes, dia);
END;
$$;

COMMENT ON FUNCTION public.br_easter(integer) IS
  'Domingo de Páscoa do ano (algoritmo Gregoriano Anônimo). IMMUTABLE: só aritmética inteira, '
  'sem locale nem timezone. Base dos feriados móveis brasileiros.';

-- ---------------------------------------------------------------------------
-- 2. Nome do feriado numa data (NULL = não é feriado)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.br_holiday_name(p_date date)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE STRICT PARALLEL SAFE
SET search_path = ''
AS $$
DECLARE
    ano    integer := EXTRACT(YEAR FROM p_date)::integer;
    pascoa date    := public.br_easter(ano);
    mmdd   text    := lpad(EXTRACT(MONTH FROM p_date)::text, 2, '0') || '-'
                   || lpad(EXTRACT(DAY   FROM p_date)::text, 2, '0');
BEGIN
    -- Móveis primeiro: são os que exigem cálculo e os que mais erram quando escritos à mão.
    IF p_date = pascoa - 48 THEN RETURN 'Carnaval (segunda)';   END IF;
    IF p_date = pascoa - 47 THEN RETURN 'Carnaval';             END IF;
    IF p_date = pascoa - 2  THEN RETURN 'Sexta-Feira Santa';    END IF;
    IF p_date = pascoa      THEN RETURN 'Páscoa';               END IF;
    IF p_date = pascoa + 60 THEN RETURN 'Corpus Christi';       END IF;

    -- Fixos.
    CASE mmdd
        WHEN '01-01' THEN RETURN 'Confraternização Universal';
        WHEN '04-21' THEN RETURN 'Tiradentes';
        WHEN '05-01' THEN RETURN 'Dia do Trabalho';
        WHEN '09-07' THEN RETURN 'Independência do Brasil';
        WHEN '10-12' THEN RETURN 'Nossa Senhora Aparecida';
        WHEN '11-02' THEN RETURN 'Finados';
        WHEN '11-15' THEN RETURN 'Proclamação da República';
        WHEN '12-25' THEN RETURN 'Natal';
        ELSE NULL;
    END CASE;

    -- Consciência Negra: feriado NACIONAL só a partir de 2024 (Lei 14.759/2023). Marcá-lo antes
    -- disso diria "banco fechado" num dia em que ele operou.
    IF mmdd = '11-20' AND ano >= 2024 THEN RETURN 'Consciência Negra'; END IF;

    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.br_holiday_name(date) IS
  'Nome do feriado na data, ou NULL. Cobre fixos + móveis (Páscoa como âncora) e respeita a '
  'vigência da Lei 14.759/2023 para Consciência Negra (nacional só a partir de 2024). '
  'Carnaval e Corpus Christi entram porque o BANCO fecha — ver holiday_kind em dim_date.';

-- ---------------------------------------------------------------------------
-- 3. dim_date
-- ---------------------------------------------------------------------------
-- Faixa 2015-2045: cobre o histórico plausível de documento fiscal (5 anos de guarda legal) e
-- ~20 anos à frente, incluindo parcelamento longo. 11.323 linhas, < 2 MB — o custo de estender
-- é irrelevante perto do custo de descobrir a lacuna em produção.

CREATE TABLE IF NOT EXISTS public.dim_date (
    date_id       date     PRIMARY KEY,
    -- Smart key YYYYMMDD (convenção de DW do workspace): entra em filtro e join sem precisar de
    -- cast, e ordena igual à data.
    sk_date       integer  NOT NULL,
    year          smallint NOT NULL,
    quarter       smallint NOT NULL,
    month         smallint NOT NULL,
    day           smallint NOT NULL,
    year_month    integer  NOT NULL,            -- YYYYMM
    day_of_week   smallint NOT NULL,            -- 0 = domingo (compatível com EXTRACT(DOW))
    day_name      text     NOT NULL,
    month_name    text     NOT NULL,
    is_weekend    boolean  NOT NULL,
    holiday_name  text,
    holiday_kind  text,                         -- 'nacional' | 'bancario' | NULL
    is_business_day boolean NOT NULL,
    CONSTRAINT chk_dim_date_holiday_kind
        CHECK (holiday_kind IS NULL OR holiday_kind IN ('nacional', 'bancario'))
);

COMMENT ON TABLE public.dim_date IS
  'Calendário 2015-2045 semeado pelas funções br_easter/br_holiday_name. is_business_day segue o '
  'calendário BANCÁRIO (Febraban): exclui fim de semana, feriados nacionais e os pontos '
  'facultativos em que o banco fecha (Carnaval, Corpus Christi). Para "feriado por lei" use '
  'holiday_kind = ''nacional''.';

INSERT INTO public.dim_date (
    date_id, sk_date, year, quarter, month, day, year_month,
    day_of_week, day_name, month_name, is_weekend,
    holiday_name, holiday_kind, is_business_day
)
SELECT
    d::date,
    (EXTRACT(YEAR FROM d) * 10000 + EXTRACT(MONTH FROM d) * 100 + EXTRACT(DAY FROM d))::integer,
    EXTRACT(YEAR    FROM d)::smallint,
    EXTRACT(QUARTER FROM d)::smallint,
    EXTRACT(MONTH   FROM d)::smallint,
    EXTRACT(DAY     FROM d)::smallint,
    (EXTRACT(YEAR FROM d) * 100 + EXTRACT(MONTH FROM d))::integer,
    EXTRACT(DOW FROM d)::smallint,
    -- CASE explícito em vez de to_char: to_char depende de lc_time (STABLE) e o nome sairia
    -- conforme o locale de quem rodou o INSERT.
    CASE EXTRACT(DOW FROM d)::integer
        WHEN 0 THEN 'domingo'       WHEN 1 THEN 'segunda-feira'
        WHEN 2 THEN 'terça-feira'   WHEN 3 THEN 'quarta-feira'
        WHEN 4 THEN 'quinta-feira'  WHEN 5 THEN 'sexta-feira'
        ELSE 'sábado'
    END,
    CASE EXTRACT(MONTH FROM d)::integer
        WHEN  1 THEN 'janeiro'   WHEN  2 THEN 'fevereiro' WHEN  3 THEN 'março'
        WHEN  4 THEN 'abril'     WHEN  5 THEN 'maio'      WHEN  6 THEN 'junho'
        WHEN  7 THEN 'julho'     WHEN  8 THEN 'agosto'    WHEN  9 THEN 'setembro'
        WHEN 10 THEN 'outubro'   WHEN 11 THEN 'novembro'  ELSE 'dezembro'
    END,
    EXTRACT(DOW FROM d)::integer IN (0, 6),
    public.br_holiday_name(d::date),
    CASE
        WHEN public.br_holiday_name(d::date) IS NULL THEN NULL
        WHEN public.br_holiday_name(d::date) IN
             ('Carnaval', 'Carnaval (segunda)', 'Corpus Christi', 'Páscoa') THEN 'bancario'
        ELSE 'nacional'
    END,
    EXTRACT(DOW FROM d)::integer NOT IN (0, 6)
        AND public.br_holiday_name(d::date) IS NULL
FROM generate_series(DATE '2015-01-01', DATE '2045-12-31', INTERVAL '1 day') AS g(d)
ON CONFLICT (date_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS ix_dim_date_business
    ON public.dim_date (date_id) WHERE is_business_day;

CREATE INDEX IF NOT EXISTS ix_dim_date_year_month
    ON public.dim_date (year_month);

-- ---------------------------------------------------------------------------
-- 4. Dias úteis entre duas datas
-- ---------------------------------------------------------------------------
-- Intervalo SEMIABERTO [p_de, p_ate): dias_uteis(hoje, hoje) = 0 e dias_uteis(sexta, segunda) = 1.
-- A alternativa (fechado) faria "faltam N dias úteis" contar o próprio dia do vencimento, que é
-- justamente o dia em que já não dá mais para agendar o pagamento.

CREATE OR REPLACE FUNCTION public.dias_uteis(p_de date, p_ate date)
RETURNS integer
LANGUAGE sql
STABLE STRICT PARALLEL SAFE
SET search_path = ''
AS $$
    SELECT CASE WHEN p_ate <= p_de THEN 0 ELSE (
        SELECT count(*)::integer
          FROM public.dim_date
         WHERE date_id >= p_de AND date_id < p_ate AND is_business_day
    ) END;
$$;

COMMENT ON FUNCTION public.dias_uteis(date, date) IS
  'Dias úteis no intervalo SEMIABERTO [p_de, p_ate) pelo calendário bancário. STABLE (lê tabela), '
  'não IMMUTABLE — por isso NÃO pode ser usada em coluna gerada. Devolve 0 quando p_ate <= p_de.';

-- ---------------------------------------------------------------------------
-- 5. Grants — objeto NOVO exige explícito (lição 056/057/079/081/097)
-- ---------------------------------------------------------------------------
-- O Supabase concede INSERT/UPDATE/DELETE a `authenticated` em toda tabela nova do schema public,
-- e o ALTER DEFAULT PRIVILEGES da 097 não alcança objeto criado por supabase_admin. Calendário é
-- dado de referência: todo mundo lê, ninguém escreve pelo app.

GRANT SELECT ON public.dim_date TO authenticated;
GRANT ALL    ON public.dim_date TO service_role;
REVOKE INSERT, UPDATE, DELETE ON public.dim_date FROM authenticated;
REVOKE ALL   ON public.dim_date FROM anon;

REVOKE EXECUTE ON FUNCTION public.br_easter(integer)      FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.br_holiday_name(date)   FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.dias_uteis(date, date)  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.br_easter(integer)      TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.br_holiday_name(date)   TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.dias_uteis(date, date)  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 🔴 RLS: GRANT SOZINHO NÃO BASTA — a policy é obrigatória (achado de 2026-08-10)
-- ---------------------------------------------------------------------------
-- A 1ª versão desta migration dizia "calendário é público, não precisa de RLS" e parou no GRANT.
-- Errado, e o modo de falha é SILENCIOSO: o Supabase HABILITA row level security automaticamente
-- em toda tabela nova do schema `public`. Com RLS ligado e ZERO policies, o default é DENY —
-- medido com `SET ROLE authenticated`: 0 linhas visíveis, e `dias_uteis('2026-01-01','2026-02-01')`
-- devolvendo **0** em vez de 21. Nenhum erro, nenhuma exceção: só o calendário respondendo que
-- nenhum dia é útil, para todos os usuários do app.
--
-- Calendário é dado de REFERÊNCIA: todo usuário autenticado lê tudo, ninguém escreve. Não há linha
-- "de alguém", então policy por dono não faria sentido — mas a policy permissiva de leitura tem de
-- existir, senão o GRANT é letra morta.

ALTER TABLE public.dim_date ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dim_date_select_authenticated ON public.dim_date;
CREATE POLICY dim_date_select_authenticated
    ON public.dim_date FOR SELECT
    TO authenticated
    USING (true);

-- ---------------------------------------------------------------------------
-- 🔴 AUTO-VERIFICAÇÃO — a migration ABORTA se ela mesma estiver errada
-- ---------------------------------------------------------------------------
-- Um calendário errado não gera erro: gera "faltam 3 dias úteis" onde faltam 2. O defeito
-- apareceria meses depois, numa conta paga em atraso. Por isso a conferência roda AQUI.

DO $$
DECLARE
    divergentes bigint;
    faltando    bigint;
BEGIN
    -- Vetores de Páscoa conferidos contra calendário civil (fonte independente do algoritmo).
    IF public.br_easter(2024) <> DATE '2024-03-31' THEN
        RAISE EXCEPTION 'ABORTADO: br_easter(2024) = % (esperado 2024-03-31)', public.br_easter(2024);
    END IF;
    IF public.br_easter(2025) <> DATE '2025-04-20' THEN
        RAISE EXCEPTION 'ABORTADO: br_easter(2025) = % (esperado 2025-04-20)', public.br_easter(2025);
    END IF;
    IF public.br_easter(2026) <> DATE '2026-04-05' THEN
        RAISE EXCEPTION 'ABORTADO: br_easter(2026) = % (esperado 2026-04-05)', public.br_easter(2026);
    END IF;

    -- Móveis de 2026, derivados da Páscoa acima.
    IF public.br_holiday_name(DATE '2026-02-17') <> 'Carnaval' THEN
        RAISE EXCEPTION 'ABORTADO: 2026-02-17 deveria ser Carnaval';
    END IF;
    IF public.br_holiday_name(DATE '2026-04-03') <> 'Sexta-Feira Santa' THEN
        RAISE EXCEPTION 'ABORTADO: 2026-04-03 deveria ser Sexta-Feira Santa';
    END IF;
    IF public.br_holiday_name(DATE '2026-06-04') <> 'Corpus Christi' THEN
        RAISE EXCEPTION 'ABORTADO: 2026-06-04 deveria ser Corpus Christi';
    END IF;

    -- Vigência da Lei 14.759/2023: 20/11 é feriado em 2024, não em 2023.
    IF public.br_holiday_name(DATE '2024-11-20') IS NULL THEN
        RAISE EXCEPTION 'ABORTADO: 2024-11-20 deveria ser Consciência Negra';
    END IF;
    IF public.br_holiday_name(DATE '2023-11-20') IS NOT NULL THEN
        RAISE EXCEPTION 'ABORTADO: 2023-11-20 NÃO era feriado nacional (lei entrou em 2024)';
    END IF;

    -- Cobertura: 2015-2045 completo, sem buraco.
    SELECT (DATE '2045-12-31' - DATE '2015-01-01' + 1) - count(*) INTO faltando FROM public.dim_date;
    IF faltando <> 0 THEN
        RAISE EXCEPTION 'ABORTADO: dim_date tem % dia(s) faltando na faixa 2015-2045', faltando;
    END IF;

    -- 🔴 ORÁCULO DIFERENCIAL: a tabela materializada TEM de concordar com a função que a gerou.
    -- Se alguém editar uma linha à mão (ou um INSERT parcial rodar com a função antiga), é aqui
    -- que aparece — não meses depois, num cálculo de prazo.
    SELECT count(*) INTO divergentes
      FROM public.dim_date
     WHERE holiday_name IS DISTINCT FROM public.br_holiday_name(date_id);
    IF divergentes <> 0 THEN
        RAISE EXCEPTION 'ABORTADO: % linha(s) de dim_date divergem de br_holiday_name', divergentes;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO (executar após aplicar; em prosa — SQL comentado reprova o SonarCloud)
-- ---------------------------------------------------------------------------
--
--   1. `dim_date` tem 11.323 linhas (2015-01-01 a 2045-12-31) — o DO $$ acima já abortaria se não.
--   2. `br_easter` e `br_holiday_name` têm provolatile = 'i' em pg_proc. Se vierem 's', alguém
--      trocou a implementação por algo dependente de sessão e elas deixam de servir a coluna
--      gerada de qualquer migration futura.
--   3. `dias_uteis` é 's' (STABLE) DE PROPÓSITO: lê tabela. Não usar em coluna gerada.
--   4. `has_table_privilege('anon','public.dim_date','SELECT')` = false e
--      `has_table_privilege('authenticated','public.dim_date','INSERT')` = false.
--   5. Conferência de sanidade num ano conhecido: em 2026, `dias_uteis('2026-01-01','2026-02-01')`
--      deve dar 21 (janeiro tem 22 dias úteis de calendário menos o dia 1º, feriado).
--   6. 🔴 LER `dim_date` COM O PAPEL REAL, não como postgres: `BEGIN; SET LOCAL ROLE
--      authenticated; SELECT count(*) FROM public.dim_date;` tem de devolver 11.323, e
--      `dias_uteis('2026-01-01','2026-02-01')` tem de devolver 21. Como superuser os dois passam
--      mesmo com a policy ausente — foi assim que o defeito escapou da primeira verificação.
--   7. `get_advisors` sem achado de RLS habilitado sem policy.
