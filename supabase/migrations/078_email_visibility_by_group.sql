-- Migration 078 — Estende a visibilidade por GRUPO às telas /emails e /erros
--
-- Contexto: a 076 restringiu /consulta (financial_account_control) por DONO (created_by = auth.uid()),
-- controlado pela flag user_group.sees_only_own_accounts (opt-in por grupo; Comercial=6 ligada).
-- Esta migration aplica a MESMA regra às tabelas lidas por /emails (email_control) e /erros
-- (email_processing_errors), mas casando o REMETENTE do e-mail com o e-mail do usuário logado:
--   sender_email = auth.email()  (case-insensitive).
--   - Grupo com a flag (Comercial=6) → vê só os e-mails/erros de que é remetente.
--   - Financeiro (7), Administrador (1), sentinela (0) e demais → veem tudo (preservado).
-- Reusa o helper public.auth_group_sees_only_own() (criado na 076) — mesma flag, mesmo opt-in.
--
-- Diferença de chave em relação à 076 (intencional, conforme pedido): /consulta casa por
-- created_by (UUID resolvido do remetente, com sentinela); /emails e /erros casam o TEXTO
-- sender_email diretamente com auth.email(). Linhas com sender_email NULL ficam ocultas para
-- usuários restritos (não são "deles") — hoje não há nenhuma nas duas tabelas.
--
-- service_role mantém bypass (pipeline Python/Next API). Só a leitura via papel `authenticated`
-- (frontend REST direto) é filtrada. Idempotente (DROP IF EXISTS + OR REPLACE).
-- APLICADA via Supabase MCP em 2026-07-11 (base compartilhada dev/prod) — histórico; não reaplicar.

-- (a) email_control — /emails. Substitui a policy USING (true).
DROP POLICY IF EXISTS authenticated_select_email_control ON email_control;
CREATE POLICY authenticated_select_email_control
  ON email_control FOR SELECT TO authenticated
  USING ( NOT public.auth_group_sees_only_own()
          OR lower(sender_email) = lower(auth.email()) );

-- (b) email_processing_errors — /erros. Substitui a policy legada "authenticated read" (USING true).
DROP POLICY IF EXISTS "authenticated read" ON email_processing_errors;
DROP POLICY IF EXISTS authenticated_select_email_processing_errors ON email_processing_errors;
CREATE POLICY authenticated_select_email_processing_errors
  ON email_processing_errors FOR SELECT TO authenticated
  USING ( NOT public.auth_group_sees_only_own()
          OR lower(sender_email) = lower(auth.email()) );

-- Nota: a policy de UPDATE de email_control (grant restrito à coluna reviewed_at) NÃO é alterada
-- — espelha a 076, que mexeu só no SELECT. Endurecer o UPDATE por remetente é hardening opcional
-- futuro (hoje a UI só mostra as linhas visíveis; um PATCH forjado por id contornaria, mas só
-- tocaria reviewed_at). service_role/pipeline seguem intocados.
