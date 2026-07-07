-- 068_status_id_primary_trigger.sql
-- FASE 2 da remoção do `status` (texto) de financial_account_control — inverte a fonte de
-- verdade para status_id:
--   * a trigger fn_set_status_from_due_date passa a operar em status_id (id-primária):
--     recalcula 'a vencer'(3)/'vencido'(2) por due_date apenas quando EM ABERTO
--     (status_id IN (1,2,3) = pendente/vencido/a vencer) e DERIVA o texto `status` a
--     partir do id (compat: a coluna texto ainda existe, com CHECK + NOT NULL, até a FASE 3);
--   * concede UPDATE(status_id) ao papel `authenticated` — o frontend passa a gravar a
--     situação por status_id (antes gravava o texto). A escrita do texto `status` continua
--     coberta pela trigger SECURITY DEFINER (o usuário não precisa de grant nela).
--
-- ATENÇÃO — DEPLOY COORDENADO: aplicar esta migração JUNTO com o deploy do frontend/Next API
-- (Vercel) que grava status_id E a cópia do Python de produção (que passa a emitir status_id).
-- A trigger id-primária IGNORA o texto enviado por escritores antigos; um runtime antigo que
-- grave `status='falha'` sem status_id teria o 'falha' sobrescrito. Ver o runbook do plano.
-- Idempotente (CREATE OR REPLACE + GRANT). Não remove a coluna texto (isso é a FASE 3 / 069).

CREATE OR REPLACE FUNCTION public.fn_set_status_from_due_date()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  ref_date DATE;
BEGIN
  -- Situação de vencimento por status_id (fonte única): só recalcula quando há vencimento e
  -- o status está EM ABERTO (1=pendente, 2=vencido, 3=a vencer). Preserva os estados fechados
  -- (falha/pago/baixado/cancelado/protestado/cartório/prorrogado) definidos por baixa/CRUD.
  IF NEW.due_date IS NOT NULL
     AND (NEW.status_id IS NULL OR NEW.status_id IN (1, 2, 3)) THEN
    ref_date := (COALESCE(NEW.extracted_at, NOW()) AT TIME ZONE 'America/Sao_Paulo')::date;
    IF NEW.due_date >= ref_date THEN
      NEW.status_id := 3;   -- a vencer
    ELSE
      NEW.status_id := 2;   -- vencido
    END IF;
  END IF;

  -- Sem status_id (não deveria — NOT NULL DEFAULT 3), aplica o default 'a vencer'.
  IF NEW.status_id IS NULL THEN
    NEW.status_id := 3;
  END IF;

  -- Deriva o TEXTO `status` a partir do id (compat enquanto a coluna existir — CHECK +
  -- NOT NULL). Removido na FASE 3 (069), quando a coluna texto for dropada.
  SELECT s.status_name INTO NEW.status
    FROM status s
   WHERE s.status_id = NEW.status_id;

  RETURN NEW;
END;
$function$;

-- O frontend (papel authenticated) passa a gravar a situação por status_id.
GRANT UPDATE (status_id) ON public.financial_account_control TO authenticated;
