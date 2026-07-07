-- 069_drop_status_text.sql
-- FASE 3 (final) da remoção do `status` (texto) de financial_account_control — status_id
-- passa a ser a ÚNICA coluna de situação:
--   1. simplifica a trigger fn_set_status_from_due_date para operar SÓ em status_id
--      (remove a derivação do texto — a coluna deixa de existir);
--   2. remove o CHECK do texto (financial_account_control_status_check);
--   3. DROP da coluna `status` (texto) + do seu grant (some com a coluna).
--
-- PRÉ-REQUISITO: todo o app já lê/escreve por status_id (FASE 1+2 no ar) — frontend/Next API
-- por status_id + embed status_dim, Python por register_financial._apply_status_id (nunca envia
-- `status`). Nenhuma view depende da coluna (verificado). Idempotente (IF EXISTS + CREATE OR
-- REPLACE). Aplicar após confirmar a FASE 1+2 estável.

-- 1. Trigger só-id (sem derivar texto).
CREATE OR REPLACE FUNCTION public.fn_set_status_from_due_date()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  ref_date DATE;
BEGIN
  -- Situação por status_id: recalcula 'a vencer'(3)/'vencido'(2) por due_date apenas quando
  -- EM ABERTO (1=pendente, 2=vencido, 3=a vencer). Preserva os estados fechados.
  IF NEW.due_date IS NOT NULL
     AND (NEW.status_id IS NULL OR NEW.status_id IN (1, 2, 3)) THEN
    ref_date := (COALESCE(NEW.extracted_at, NOW()) AT TIME ZONE 'America/Sao_Paulo')::date;
    IF NEW.due_date >= ref_date THEN
      NEW.status_id := 3;   -- a vencer
    ELSE
      NEW.status_id := 2;   -- vencido
    END IF;
  END IF;

  IF NEW.status_id IS NULL THEN
    NEW.status_id := 3;   -- default 'a vencer'
  END IF;

  RETURN NEW;
END;
$function$;

-- 2. Remove o CHECK do texto e 3. dropa a coluna (o grant de coluna some junto).
ALTER TABLE public.financial_account_control
  DROP CONSTRAINT IF EXISTS financial_account_control_status_check;

ALTER TABLE public.financial_account_control
  DROP COLUMN IF EXISTS status;
