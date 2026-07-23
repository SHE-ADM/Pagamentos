-- 095_fix_status_trigger_reference_date.sql
-- Corrige a data de referência da trigger fn_set_status_from_due_date, que usava
-- COALESCE(NEW.extracted_at, NOW()) desde a criação (migration 034, 2026-06-18) e
-- nunca a data ATUAL. Bug real detectado em 2026-07-23: a skill baixa-automatica
-- (Regra 2 — marcação de vencidos) fazia PATCH status_id=2 em contas em aberto com
-- due_date no passado, mas a trigger BEFORE UPDATE recalculava usando extracted_at
-- (data em que a conta foi EXTRAÍDA, congelada — quase sempre ANTERIOR ao vencimento)
-- em vez de "hoje", concluindo due_date >= extracted_at → 'a vencer' e revertendo o
-- UPDATE explícito dentro da MESMA transação. Resultado: das 123 contas que deveriam
-- estar 'vencido' (status_id IN (1,3) AND due_date < hoje), só 3 realmente persistiam
-- assim (os únicos casos em que due_date < extracted_at, ex.: correção manual do
-- vencimento para uma data anterior à extração).
--
-- O mesmo bug afetava qualquer UPDATE em conta 'em aberto' feito DEPOIS do vencimento
-- ter passado (ex.: curadoria de NF/Boleto em /consulta) — a trigger sempre recalculava
-- pela data de extração congelada, nunca revertendo corretamente para 'vencido'. Não é
-- exclusivo da skill baixa-automatica: é um bug de fundação da trigger, presente desde
-- 034/067/068/069, só evidenciado agora porque a Regra 2 foi o primeiro caminho a tentar
-- setar status_id=2 explicitamente em massa.
--
-- Fix: ref_date passa a ser a data ATUAL (NOW() no fuso America/Sao_Paulo), não mais
-- extracted_at. Sem efeito colateral no INSERT (extracted_at ≈ NOW() no momento da
-- extração — resultado idêntico); no UPDATE, agora reavalia corretamente contra "hoje".
-- Regra 1 (baixa → status_id=8) e as demais transições fechadas continuam intocadas —
-- 8 não está em (1,2,3), a trigger nem entra no ramo de recálculo.
--
-- Idempotente (CREATE OR REPLACE). Sem novos objetos, sem coluna nova, sem backfill
-- automático aqui — as contas já mal-classificadas foram corrigidas manualmente logo
-- após esta migration (re-run da Regra 2, que agora funciona corretamente porque a
-- trigger deixou de reverter o UPDATE).

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
    -- CORRIGIDO (095): data de referência é HOJE (NOW()), não mais extracted_at
    -- (congelada na extração — fazia a trigger reverter qualquer tentativa de marcar
    -- 'vencido' depois que o vencimento já havia passado).
    ref_date := (NOW() AT TIME ZONE 'America/Sao_Paulo')::date;
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
