-- =============================================================
-- 082_supplier_contact_fields.sql
-- Campos de CONTATO do fornecedor em `supplier`: telefone (DDD + fone, 2 slots),
-- WhatsApp (2 slots) e chave PIX (2 slots). Preenchidos pela edição de fornecedores
-- (form) e pela extração de e-mails (parser de corpo/assunto), com lógica de 2 slots
-- (preenche o 1º; o 2º só quando o 1º já está informado e é diferente).
--
-- Todas as colunas nullable, sem default, sem FK (texto livre). `pix_key` = 77
-- (limite BACEN para chave do tipo e-mail). Telefone/WhatsApp são armazenados só
-- com dígitos (sem máscara), como cnpj/cpf.
--
-- A tabela `supplier` PRE-EXISTE (não é criada por migration — ver 042). Escrita
-- segue restrita a service_role: reafirmamos o REVOKE da 057 (idempotente).
--
-- Projeto: pagamentos | Data: 2026-07-16
-- =============================================================

BEGIN;

-- 1. Colunas de contato (todas nullable, sem default).
ALTER TABLE supplier
  ADD COLUMN IF NOT EXISTS phone_ddd1 CHAR(2),
  ADD COLUMN IF NOT EXISTS phone1     VARCHAR(9),
  ADD COLUMN IF NOT EXISTS phone_ddd2 CHAR(2),
  ADD COLUMN IF NOT EXISTS phone2     VARCHAR(9),
  ADD COLUMN IF NOT EXISTS whatsapp1  VARCHAR(11),
  ADD COLUMN IF NOT EXISTS whatsapp2  VARCHAR(11),
  ADD COLUMN IF NOT EXISTS pix_key1   VARCHAR(77),
  ADD COLUMN IF NOT EXISTS pix_key2   VARCHAR(77);

-- 2. Defesa em profundidade: escrita só por service_role (reafirma a 057).
--    A RLS de SELECT (029) e a trava de escrita (057) permanecem inalteradas.
REVOKE INSERT, UPDATE, DELETE ON public.supplier FROM authenticated, anon;

COMMIT;
