-- 096_add_payment_date.sql
-- Cria financial_account_control.payment_date — a DATA EM QUE A CONTA FOI PAGA.
--
-- MOTIVAÇÃO: até aqui o banco não tinha nenhuma data de pagamento. A situação 'pago'
-- (status_id = 8) dizia QUE foi pago, nunca QUANDO. O único proxy disponível era
-- status_changed_at (migration 077), que NÃO serve: seu valor mínimo em toda a tabela é
-- 2026-07-10 — a data em que a própria 077 criou a coluna —, inclusive para contas com
-- vencimento em abril. Ou seja, todo o histórico de pagamento está achatado na data de
-- uma migration. Sem payment_date, perguntas de caixa realizado ("quanto foi pago em
-- maio") são estruturalmente irrespondíveis, e a camada analítica só consegue trabalhar
-- por vencimento/emissão.
--
-- ESTA MIGRATION FAZ 4 COISAS, NESTA ORDEM (a ordem importa — ver nota do passo 3):
--   1. cria a coluna payment_date DATE (nullable);
--   2. cria índice parcial para o filtro por período;
--   3. BACKFILL do histórico: payment_date := due_date nas contas já pagas;
--   4. só então cria a trigger que carimba a data corrente nas baixas FUTURAS.
--
-- SOBRE O BACKFILL (passo 3) — é uma APROXIMAÇÃO DELIBERADA, não um dado real. A data
-- verdadeira de pagamento das 442 contas já baixadas não existe em lugar nenhum do banco
-- (ver acima). Adotar o vencimento como data de pagamento é a melhor aproximação
-- disponível e foi a decisão do dono do produto. Conferido antes de aplicar: NENHUMA das
-- contas pagas tem vencimento futuro (o maior é a data de hoje), então o backfill não
-- produz data de pagamento no futuro. Contas pagas com atraso ficarão com a data
-- otimista (a do vencimento, não a do pagamento efetivo) — limitação conhecida do dado
-- histórico, que NÃO se propaga para as baixas novas (passo 4 usa a data corrente).
--
-- POR QUE O BACKFILL VEM ANTES DA TRIGGER: assim o UPDATE de 442 linhas do passo 3 roda
-- num momento em que a trigger sequer existe — impossível haver conflito. Defesa em
-- profundidade: mesmo se a ordem fosse invertida, a trigger não tocaria nessas linhas
-- (o preenchimento exige payment_date IS NULL, e o backfill grava um valor não-nulo; e a
-- limpeza exige uma TRANSIÇÃO 8 → outro status, que o backfill não faz — ele mantém
-- status_id = 8). O passo 3 é idempotente (WHERE payment_date IS NULL): reexecutar a
-- migration não sobrescreve nada.
--
-- SEMÂNTICA DA TRIGGER (passo 4), decidida com o dono do produto:
--   * ENTRA em pago  (status_id vira 8)  → payment_date := data corrente, SE estiver NULL.
--     Respeitar o NULL preserva uma data retroativa informada no MESMO UPDATE (registro
--     de pagamento com data anterior) em vez de sobrescrevê-la com "hoje".
--   * SAI de pago    (8 → qualquer outro) → payment_date := NULL.
--     Baixa feita por engano e corrigida não deixa data de pagamento órfã numa conta que
--     voltou a estar em aberto/cancelada.
--   * Continua em pago com payment_date apagado à mão → é repreenchido com a data
--     corrente: conta paga sempre tem data.
--
-- FUSO: America/Sao_Paulo, o mesmo de fn_set_status_from_due_date (095). CURRENT_DATE no
-- servidor Supabase é UTC e, entre 21h e 00h BRT, já é "amanhã" — a baixa feita à noite
-- ficaria registrada no dia seguinte.
--
-- CONVIVÊNCIA COM AS OUTRAS 3 TRIGGERS BEFORE DA TABELA (trg_fac_authorship,
-- trg_fe_sk_company, trg_fe_status_vencimento): nenhuma delas produz status_id = 8, então
-- não há disputa pela situação. A única que reescreve status_id é
-- fn_set_status_from_due_date, e só quando a conta está EM ABERTO (1/2/3). O resultado
-- desta trigger é INDEPENDENTE DA ORDEM de disparo: o preenchimento testa NEW.status_id
-- = 8 (que nenhuma outra trigger cria nem destrói) e a limpeza testa a transição a partir
-- de OLD.status_id = 8 (que continua verdadeira mesmo se outra trigger trocar o NEW de 3
-- para 2 depois). Ainda assim, o nome trg_fac_payment_date a posiciona entre
-- trg_fac_authorship e as trg_fe_* (Postgres dispara BEFORE em ordem alfabética).
--
-- SECURITY DEFINER: adotado por CONSISTÊNCIA com as 3 triggers irmãs desta tabela, NÃO
-- por necessidade — a função não acessa tabela alguma, só atribui a NEW. Registrando para
-- não induzir a erro quem ler depois: privilégio de COLUNA é checado contra a lista SET do
-- comando, não contra o que um trigger BEFORE altera, então SECURITY INVOKER bastaria.
-- Verificado empiricamente no papel `authenticated` (que só tem UPDATE em has_invoice,
-- has_bank_slip e status_id — migrations 033/068): um PATCH apenas de status_id = 8 grava
-- payment_date normalmente. payment_date NÃO entra nesse grant de propósito: quem a
-- preenche é a trigger, não o cliente.
--
-- PARIDADE ARQUIVO ↔ BANCO: o que fica GRAVADO no catálogo (corpo da função e os textos de
-- COMMENT ON) está aqui exatamente como foi aplicado — sem acentos, porque a acentuação foi
-- removida no transporte do SQL. Os comentários `--` fora dos objetos (este cabeçalho) não
-- são armazenados pelo Postgres e por isso seguem acentuados. Reexecutar este arquivo
-- reproduz o estado atual byte a byte.
--
-- Idempotente (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
-- CREATE OR REPLACE FUNCTION / DROP TRIGGER IF EXISTS + CREATE TRIGGER).

-- ---------------------------------------------------------------------------
-- 1. Coluna
-- ---------------------------------------------------------------------------

ALTER TABLE public.financial_account_control
  ADD COLUMN IF NOT EXISTS payment_date DATE;

COMMENT ON COLUMN public.financial_account_control.payment_date IS
  'Data em que a conta foi paga. Preenchida automaticamente pela trigger '
  'trg_fac_payment_date quando status_id passa a 8 (pago) e limpa quando deixa de ser 8. '
  'Nas contas pagas ANTES da migration 096 contem o VENCIMENTO (backfill aproximado - a '
  'data real de pagamento do historico nao existe no banco).';

-- ---------------------------------------------------------------------------
-- 2. Índice
-- ---------------------------------------------------------------------------
-- Parcial (WHERE payment_date IS NOT NULL), no mesmo padrão de ix_fac_source_file (080):
-- todo filtro útil é por intervalo de data, e intervalo nunca casa NULL — indexar as
-- linhas não pagas só aumentaria o índice sem servir a nenhuma consulta.

CREATE INDEX IF NOT EXISTS ix_fac_payment_date
  ON public.financial_account_control (payment_date)
  WHERE payment_date IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Backfill do histórico (ANTES de existir a trigger) — 442 contas hoje
-- ---------------------------------------------------------------------------

UPDATE public.financial_account_control
   SET payment_date = due_date
 WHERE status_id = 8            -- pago
   AND payment_date IS NULL     -- idempotente: não sobrescreve o que já tem data
   AND due_date IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Trigger de carimbo automático
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_set_payment_date()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status_id = 8 THEN
    -- Entrou em 'pago' (ou nasceu pago no INSERT), ou segue pago sem data.
    -- So preenche o vazio: data informada explicitamente no mesmo comando e preservada.
    IF NEW.payment_date IS NULL THEN
      NEW.payment_date := (NOW() AT TIME ZONE 'America/Sao_Paulo')::date;
    END IF;

  ELSIF TG_OP = 'UPDATE' AND OLD.status_id = 8 THEN
    -- Deixou de estar pago: a data nao pode sobreviver a situacao que a originou.
    NEW.payment_date := NULL;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.fn_set_payment_date() IS
  'Carimba financial_account_control.payment_date com a data corrente (America/Sao_Paulo) '
  'quando a conta passa a status_id = 8 (pago) e a limpa quando deixa de ser 8. '
  'Preserva data informada explicitamente no mesmo comando.';

DROP TRIGGER IF EXISTS trg_fac_payment_date ON public.financial_account_control;

CREATE TRIGGER trg_fac_payment_date
  BEFORE INSERT OR UPDATE ON public.financial_account_control
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_set_payment_date();
