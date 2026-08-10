-- 112_fac_colunas_derivadas.sql
--
-- ONDA 6 (itens 6.1, 6.4, 6.5) do roadmap — docs/roadmap-enriquecimento-dados.md
--
-- PROBLEMA: três informações que JÁ EXISTEM na linha não são consultáveis.
--   6.1  competência é TEXT 'YYYY-MM' — não dá para agrupar por mês nem comparar com caixa;
--   6.4  atraso de pagamento exige subtrair duas colunas em toda consulta (104 contas pagas em
--        atraso, medido em 2026-08-10, e nenhuma forma direta de perguntar por elas);
--   6.5  o chat não consegue qualificar a resposta ("esse valor veio de OCR").
--
-- Guardas deste arquivo: tests/test_onda6_campos_derivados.py (G1, G2, G5, G6).
--
-- ---------------------------------------------------------------------------
-- 🔴 GRANTS: não há nada a conceder — e isso é proposital
-- ---------------------------------------------------------------------------
-- Coluna nova em tabela EXISTENTE herda os grants da tabela (mesma nota da migration 105). Como
-- `authenticated` só tem UPDATE por COLUNA em has_invoice/has_bank_slip (033) e status_id (068),
-- as três colunas abaixo nascem não-graváveis por ele. E, sendo GENERATED, ninguém as escreve:
-- o PostgreSQL recusa qualquer INSERT/UPDATE que as cite (SQLSTATE 428C9).
--
-- IDEMPOTENTE (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS). Reexecutar é no-op.

-- ---------------------------------------------------------------------------
-- 6.1 — competence_month
-- ---------------------------------------------------------------------------
-- 🔴 `competence_date` PERMANECE TEXT E INTOCADA. Convertê-la para DATE quebraria a extração:
-- o conteúdo é 'YYYY-MM' (mês), '2026-06'::date é erro de sintaxe, e o formato é contrato de três
-- camadas (prompt do Claude em extract_pdf.py, template do CSV, schema Zod). Todo INSERT do reader
-- passaria a falhar. Acrescentar é seguro; converter não.
--
-- 🔴 `make_date`, NEM `::date` NEM `to_date` — e este ponto CONTRARIA o roadmap, com medição:
--
--   O roadmap (docs/roadmap-enriquecimento-dados.md, item 6.1) manda usar `to_date(...)` e afirma
--   que "to_date com máscara explícita é IMMUTABLE". **É FALSO.** Conferido no catálogo desta base:
--       to_date(text, text)                    -> provolatile = 's'  (STABLE)     ❌ recusado
--       make_date(integer, integer, integer)   -> provolatile = 'i'  (IMMUTABLE)  ✅
--   A primeira tentativa desta migration, escrita ao pé da letra do roadmap, morreu com
--   `ERROR: generation expression is not immutable`. É a MESMA classe de erro que o roadmap estava
--   tentando evitar (`::date` é STABLE) — ele só errou qual função escapa dela.
--
--   Lição operacional: volatilidade se confere em `pg_proc`, não se deduz de "tem máscara
--   explícita, logo é determinística". O `to_date` aceita padrões dependentes de sessão (era, TZ),
--   e é isso que o marca STABLE inteiro — independentemente da máscara que ESTE call site usa.
--
-- 🔴 O `CASE` com regex GUARDA a conversão — não é enfeite. Sem ele, `'2026-13'` faria
-- `make_date(2026, 13, 1)` lançar 22008 (date/time field value out of range), e numa COLUNA GERADA
-- isso não produz valor ruim: derruba o INSERT INTEIRO, parando a extração. Quem preenche
-- competence_date é o Claude — o prompt pede 'YYYY-MM', mas LLM desvia. Medido em 2026-08-10: 103
-- preenchidas, 0 fora do padrão; o risco é FUTURO, que é o tipo que só aparece meses depois.
--
-- O regex também é o que torna os `substr` seguros: depois de casar `^\d{4}-(0[1-9]|1[0-2])$`, as
-- posições 1-4 e 6-7 são garantidamente ano e mês numéricos.
--
-- O `btrim` recupera '2026-07 ' (espaço colado pelo LLM) sem afrouxar semântica: o regex continua
-- exigindo o formato exato depois de aparado.

ALTER TABLE public.financial_account_control
    ADD COLUMN IF NOT EXISTS competence_month date
    GENERATED ALWAYS AS (
        CASE WHEN btrim(competence_date) ~ '^\d{4}-(0[1-9]|1[0-2])$'
             THEN make_date(
                      substr(btrim(competence_date), 1, 4)::integer,
                      substr(btrim(competence_date), 6, 2)::integer,
                      1)
             ELSE NULL
        END
    ) STORED;

COMMENT ON COLUMN public.financial_account_control.competence_month IS
  'Primeiro dia do mês de competência, derivado de competence_date (TEXT ''YYYY-MM''). NULL quando '
  'competence_date é nula OU não casa o padrão — o regex GUARDA a conversão, que lançaria 22008 em '
  '''2026-13'' e derrubaria o INSERT inteiro. Usa make_date (IMMUTABLE); to_date é STABLE e o '
  'PostgreSQL o recusa aqui, ao contrário do que o roadmap afirmava. NUNCA derivar de due_date: '
  'competência é declaração contábil, vencimento é caixa. Cobertura hoje ~13% das contas.';

-- Índice PARCIAL: só ~13% das linhas têm competência. O parcial custa uma fração do índice cheio
-- e serve todo GROUP BY competence_month.
CREATE INDEX IF NOT EXISTS ix_fac_competence_month
    ON public.financial_account_control (competence_month)
    WHERE competence_month IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6.4 — days_late
-- ---------------------------------------------------------------------------
-- 🔴 `payment_date - due_date` e NADA MAIS. Usar CURRENT_DATE/now() aqui é impossível (não é
-- IMMUTABLE, o PostgreSQL recusa) E seria errado: é exatamente o bug da migration 095, em que uma
-- coluna passava a mentir com o tempo sem nenhum UPDATE. O CLAUDE.md já registra a mesma recusa
-- para `is_overdue`. Atraso de conta EM ABERTO é pergunta de consulta (due_date < hoje), não de
-- coluna.
--
-- NEGATIVO é informação legítima: pagamento antecipado. Não usar GREATEST(...,0) — zerar o
-- antecipado destruiria metade da distribuição e faria qualquer média mentir para cima.
--
-- ⚠️ `payment_date` tem TRÊS semânticas (ver CLAUDE.md): backfill da 096 (= vencimento, logo
-- days_late = 0 artificial), carimbo da trigger e baixa automática. NÃO agregar days_late como
-- DPO sem separar as populações — a decisão "DPO ADIADO" continua valendo.

ALTER TABLE public.financial_account_control
    ADD COLUMN IF NOT EXISTS days_late integer
    GENERATED ALWAYS AS (payment_date - due_date) STORED;

COMMENT ON COLUMN public.financial_account_control.days_late IS
  'payment_date - due_date, em dias. NULL enquanto a conta não foi paga. NEGATIVO = pagamento '
  'antecipado (legítimo, não normalizar para zero). NÃO é medida de DPO: nas contas pagas antes '
  'da migration 096 o payment_date veio do backfill (= vencimento) e produz 0 artificial. '
  'Atraso de conta EM ABERTO não está aqui — é due_date < CURRENT_DATE na consulta.';

CREATE INDEX IF NOT EXISTS ix_fac_days_late
    ON public.financial_account_control (days_late)
    WHERE days_late IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6.5 — extraction_confidence
-- ---------------------------------------------------------------------------
-- ORDINAL TEXTUAL, jamais numérico. Um 0.85 sugeriria uma calibração que não existe: o eixo aqui é
-- PROVENIÊNCIA (como o dado entrou), não probabilidade de acerto. Texto nomeia o que é; número
-- convidaria a fazer média de uma escala que ninguém mediu.
--
-- A ordem sai da natureza da fonte, não de palpite:
--   alta   pdf_text      texto digital do PDF, determinístico (pdfplumber) — sem OCR no caminho
--   media  email_body    parsing de texto livre; o layout varia por remetente
--   baixa  pdf_vision    leitura VISUAL; é a origem dos 18 barcodes corrompidos de 2026-08-07
--          image_vision  idem, sobre foto/scan
--   manual (NULL)        digitado por pessoa no CRUD — não passou por extrator nenhum
--   desconhecida         'falha' e qualquer valor futuro do CHECK que ninguém mapeou aqui
--
-- 🔴 O ELSE é obrigatório: sem ele, um valor novo em extraction_source viraria NULL silencioso e a
-- coluna deixaria de ser total. Com ELSE, aparece como 'desconhecida' — visível e contável.

ALTER TABLE public.financial_account_control
    ADD COLUMN IF NOT EXISTS extraction_confidence text
    GENERATED ALWAYS AS (
        CASE
            WHEN extraction_source IS NULL          THEN 'manual'
            WHEN extraction_source = 'pdf_text'     THEN 'alta'
            WHEN extraction_source = 'email_body'   THEN 'media'
            WHEN extraction_source = 'pdf_vision'   THEN 'baixa'
            WHEN extraction_source = 'image_vision' THEN 'baixa'
            ELSE 'desconhecida'
        END
    ) STORED;

COMMENT ON COLUMN public.financial_account_control.extraction_confidence IS
  'Confiança ORDINAL derivada de extraction_source: alta (pdf_text) > media (email_body) > baixa '
  '(pdf_vision/image_vision) > manual (NULL = digitado no CRUD). ''desconhecida'' é o ELSE: fonte '
  'nova sem mapeamento aqui — se aparecer, o domínio mudou e este CASE não acompanhou. Nunca '
  'numérico: o eixo é proveniência, não probabilidade calibrada.';

CREATE INDEX IF NOT EXISTS ix_fac_extraction_confidence
    ON public.financial_account_control (extraction_confidence);

-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO (executar após aplicar; em prosa — SQL comentado reprova o SonarCloud)
-- ---------------------------------------------------------------------------
--
--   1. As três colunas existem com attgenerated = 's' em pg_attribute, e pg_get_expr devolve a
--      expressão real — conferir que competence_month cita `make_date` e NÃO cita `to_date` nem
--      `::date` nem `due_date`, e que days_late é exatamente `payment_date - due_date`.
--      ⚠️ `to_date` AUSENTE é o resultado CORRETO, não um defeito: ele é STABLE e o PostgreSQL
--      recusaria a coluna (ver o bloco 🔴 do cabeçalho). A guarda G2 do teste asserta a ausência.
--   2. Oráculos diferenciais contra o baseline de 2026-08-10 (conferência humana no momento da
--      aplicação; jamais assert em teste, porque o dado deriva a cada 5 minutos):
--        - competence_month não-nulo  = competence_date preenchidos (103 na medição)
--        - days_late não-nulo         = contas pagas (607)
--        - days_late > 0              = pagas em atraso (104)
--        - extraction_confidence somando por valor = total de contas (803), NENHUMA linha NULL
--          (alta 377 · media 173 · baixa 111 · manual 142 · desconhecida 0)
--      `desconhecida` > 0 significa que extraction_source ganhou valor novo sem passar por aqui.
--   3. PROVA de que o caminho REAL de escrita não quebrou — o --dry-run do reader NÃO serve
--      (ele não grava). Rodar `py -3 scripts\reprocess_message.py <message_id já processado>`,
--      que refaz um INSERT de verdade por register_financial. Ausência de 428C9 é o que se busca.
--   4. Alternar NF/Boleto numa conta em /consulta logado como usuário real: prova que o UPDATE por
--      COLUNA de `authenticated` continua funcionando com as colunas geradas na linha.
--   5. `get_advisors` sem achado novo.
