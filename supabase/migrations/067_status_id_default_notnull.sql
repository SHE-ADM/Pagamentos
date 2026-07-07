-- 067_status_id_default_notnull.sql
-- FASE 1 da remoção do `status` (texto) de financial_account_control — prepara o
-- status_id como FONTE ÚNICA da situação, SEM quebrar nada:
--   * mantém a coluna `status` (texto) e a trigger atual (fn_set_status_from_due_date),
--     que segue derivando status_id a partir do texto — nenhum runtime quebra;
--   * garante status_id preenchido (defensivo — a trigger já o mantém sincronizado);
--   * DEFAULT 3 ('a vencer') — decisão do usuário (substitui o antigo default 'pendente'
--     do texto). Em FASE 1 este default é INERTE: as inserções ainda enviam o texto e a
--     trigger sobrepõe o id; o default só passa a valer quando a escrita virar status_id
--     (FASE 2);
--   * NOT NULL.
--
-- Idempotente (SET DEFAULT / SET NOT NULL são idempotentes; o UPDATE é no-op sem nulos).
-- Aplicar manualmente no SQL Editor. Não remove nem altera a trigger/coluna de texto.
-- Ver o plano faseado (FASE 1 → 2 → 3) e as migrations 068/069 que o sucedem.

-- Defensivo: nenhuma linha deveria ter status_id nulo (a trigger sempre preenche),
-- mas se houver, resolve pela dimensão a partir do texto antes do SET NOT NULL.
UPDATE financial_account_control f
   SET status_id = s.status_id
  FROM status s
 WHERE f.status_id IS NULL
   AND s.status_name = f.status;

ALTER TABLE financial_account_control
  ALTER COLUMN status_id SET DEFAULT 3,   -- 3 = 'a vencer'
  ALTER COLUMN status_id SET NOT NULL;
