-- 064_add_additional_info.sql
-- Campo de texto livre "Informações adicionais", escrito pelo USUÁRIO no cadastro de
-- contas (ContaForm em /contas e no modal de edição de /consulta) e exibido no card de
-- detalhe de /consulta. Distinto de `processing_notes` (auditoria/pipeline) — este é
-- conteúdo do usuário, nunca tocado pela extração.
-- Escrita via Next API (service_role) — sem grant por coluna para `authenticated`.
-- Idempotente: ADD COLUMN IF NOT EXISTS.

ALTER TABLE financial_account_control
  ADD COLUMN IF NOT EXISTS additional_info TEXT;

COMMENT ON COLUMN financial_account_control.additional_info IS
  'Informações adicionais em texto livre escritas pelo usuário no cadastro de contas; exibidas no card de detalhe de /consulta. Distinta de processing_notes (auditoria/pipeline).';
