-- 105_email_control_body_full.sql
--
-- ONDA 2 (item 2.1) do roadmap — docs/roadmap-enriquecimento-dados.md
--
-- PROBLEMA: `email_control.body_preview` corta o corpo em 500 caracteres, e a perda é ATIVA —
-- medido em 2026-07-31, **440 de 823** e-mails com corpo (53%) estão exatamente no teto, ou seja,
-- foram truncados. O texto perdido só existe no IMAP; para os e-mails que saírem da caixa, ele
-- some de vez. Por isso esta onda vem cedo no roadmap.
--
-- O QUE ESTA MIGRATION FAZ
--   1. `body_full`   — o corpo INTEIRO, sem teto.
--   2. `body_search` — tsvector GERADO de assunto + corpo, para busca textual.
--   3. índice GIN sobre o tsvector.
--   4. backfill conservador (ver abaixo).
--
-- `body_preview` PERMANECE e continua sendo gravada: é o que a tela /emails já lê, e removê-la
-- transformaria uma migration aditiva numa mudança de contrato do frontend. Ela passa a ser o que
-- o nome sempre prometeu — um preview — enquanto `body_full` guarda o texto completo.
--
-- ---------------------------------------------------------------------------
-- POR QUE `to_tsvector('portuguese'::regconfig, ...)` E NÃO `to_tsvector(...)` DE UM ARGUMENTO
-- ---------------------------------------------------------------------------
-- Coluna gerada exige expressão IMMUTABLE. Verificado no catálogo desta base:
--   - `to_tsvector(regconfig, text)` → provolatile = 'i'  (IMMUTABLE)  ✅ serve
--   - `to_tsvector(text)`            → provolatile = 's'  (STABLE)     ❌ o PostgreSQL recusa
-- A versão de 1 argumento depende de `default_text_search_config`, que é uma configuração de
-- sessão — daí ser STABLE. Fixar a config no literal é o que torna a expressão determinística.
-- (Mesma família da lição do `competence_month`, na Onda 6: `::date` é STABLE, `to_date` é
-- IMMUTABLE.)
--
-- ---------------------------------------------------------------------------
-- POR QUE O BACKFILL É CONSERVADOR (não copia tudo)
-- ---------------------------------------------------------------------------
-- Só copia `body_preview` para `body_full` quando o preview NÃO está truncado (comprimento entre
-- 1 e 499). Os **440** truncados ficam NULL de propósito: preenchê-los com o texto cortado faria
-- uma coluna chamada `body_full` conter meio corpo, e a busca devolveria "não encontrado" para um
-- termo que está no trecho perdido — sem nenhum sinal de que o dado está incompleto. NULL é
-- honesto: significa "ainda não temos o corpo inteiro".
--   - alcance do backfill: **383** e-mails
--   - ficam NULL: **440**, recuperáveis pela varredura da Onda 4 (que rebusca no IMAP)
--
-- ---------------------------------------------------------------------------
-- SEGURANÇA
-- ---------------------------------------------------------------------------
-- Coluna nova em tabela EXISTENTE herda os grants da tabela — não há grant novo a conceder e,
-- principalmente, `authenticated` NÃO ganha escrita: o UPDATE dele é restrito por COLUNA a
-- `reviewed_at` (migrations 030/081), então `body_full` fica gravável só por `service_role`.
-- A RLS da migration 078 (o grupo restrito só vê e-mail de que é remetente) continua valendo,
-- inclusive para o texto novo — é a mesma linha.

ALTER TABLE public.email_control
    ADD COLUMN IF NOT EXISTS body_full text;

COMMENT ON COLUMN public.email_control.body_full IS
  'Corpo COMPLETO do e-mail, sem truncamento. NULL quando ainda não foi capturado (e-mail antigo '
  'cujo preview veio truncado, ou e-mail sem keyword, que não tem o corpo baixado). '
  'body_preview segue existindo como preview de 500 chars para a tela.';

ALTER TABLE public.email_control
    ADD COLUMN IF NOT EXISTS body_search tsvector
    GENERATED ALWAYS AS (
        to_tsvector(
            'portuguese'::regconfig,
            left(COALESCE(subject, '') || ' ' || COALESCE(body_full, ''), 100000)
        )
    ) STORED;

COMMENT ON COLUMN public.email_control.body_search IS
  'Busca textual sobre assunto + corpo completo. Gerada com regconfig EXPLÍCITO porque '
  'to_tsvector(text) é STABLE e o PostgreSQL recusa expressão não-IMMUTABLE em coluna gerada. '
  'O left(...,100000) é teto de segurança NO BANCO — ver o bloco abaixo.';

-- ---------------------------------------------------------------------------
-- 🔴 POR QUE O `left(..., 100000)` NA EXPRESSÃO GERADA (não remover)
-- ---------------------------------------------------------------------------
-- `tsvector` tem limite RÍGIDO de 1 MB. Estourá-lo não devolve resultado ruim: **quebra o INSERT**
-- com erro do Postgres — e numa coluna GERADA isso derruba a gravação do e-mail inteiro.
--
-- O reader já aplica um teto de 100 KB (`BODY_FULL_MAX_CHARS`), mas ele **não é o único caminho de
-- escrita** em `body_full`: a varredura histórica da Onda 4, scripts de backfill e correções
-- manuais gravam direto pelo `service_role`. Um teto só no cliente protege apenas o cliente que se
-- lembrou dele.
--
-- Medido nesta base, no pior caso (todos os lexemas ÚNICOS, que é o que mais infla o vetor):
--   100 KB de texto  → tsvector de ~128 KB = **12% do limite** (margem de 8×)
--   287 KB de texto  → tsvector de ~372 KB = 35% do limite
-- Ou seja, o teto de 100 KB é confortável, e o `left` garante que ele valha para QUALQUER origem.
--
-- Efeito colateral aceito: um corpo acima de 100 KB fica pesquisável só até esse ponto. O texto
-- INTEIRO continua em `body_full` — quem perde é o índice, não o dado.

-- GIN é o índice correto para tsvector: busca por termo contido, não por prefixo ordenado.
CREATE INDEX IF NOT EXISTS ix_email_control_body_search
    ON public.email_control USING GIN (body_search);

-- Backfill conservador — só o que comprovadamente NÃO está truncado. Idempotente
-- (`body_full IS NULL`), então reexecutar não sobrescreve corpo já capturado pelo reader.
UPDATE public.email_control
   SET body_full = body_preview
 WHERE body_full IS NULL
   AND length(COALESCE(body_preview, '')) BETWEEN 1 AND 499;

-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO (executar após aplicar; esperado em prosa — SQL comentado reprova o SonarCloud)
-- ---------------------------------------------------------------------------
--
--   1. `body_full` preenchida em ~383 linhas; ~440 seguem NULL (os truncados).
--   2. `body_search` NÃO é nula em nenhuma linha — o COALESCE garante que assunto sozinho já
--      produz vetor, então e-mail sem corpo continua pesquisável pelo assunto.
--   3. O índice `ix_email_control_body_search` aparece no EXPLAIN de uma busca com `@@`.
--   4. `authenticated` NÃO tem UPDATE em body_full (só em reviewed_at) — conferir em
--      information_schema.column_privileges.
--   5. Com o papel `authenticated` de um usuário do grupo Comercial, a contagem de linhas visíveis
--      em email_control permanece a mesma de antes (a RLS da 078 não é afetada por coluna nova).
