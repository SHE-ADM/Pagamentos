-- =============================================================
-- 031_email_control_status_duplicidade.sql
-- Novo status de email_control: 'duplicidade'.
-- Projeto: pagamentos | Data: 2026-06-17
--
-- Contexto: um e-mail cujo pagável (extraído do corpo) DUPLICA uma conta já
-- registrada por outro e-mail — ex.: a mensagem original e seu RES:/encaminhamento
-- — antes caía em 'falha' (ruído na fila de revisão). Agora recebe status próprio
-- 'duplicidade', com card/filtro dedicados em /emails. A conta NÃO é recriada
-- (find_financial_duplicate evita); o e-mail apenas referencia a conta existente
-- na coluna notes ("Duplicata — conta já registrada (id N)").
--
-- Domínio passa a: extraído, recebido, pendente, falha, ignorado, duplicidade.
-- Idempotente: recria o CHECK com o domínio ampliado.
-- =============================================================

ALTER TABLE email_control
  DROP CONSTRAINT IF EXISTS email_control_status_check;

ALTER TABLE email_control
  ADD CONSTRAINT email_control_status_check
  CHECK (status IN ('extraído', 'recebido', 'pendente', 'falha', 'ignorado', 'duplicidade'));
