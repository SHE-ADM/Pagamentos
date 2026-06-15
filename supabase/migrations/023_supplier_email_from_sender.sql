-- =============================================================
-- 023_supplier_email_from_sender.sql
-- Alinha supplier.email com o remetente do e-mail (email_control.sender_email).
-- O alinhamento entra na rotina de atualização de supplier (trg_fe_resolve_supplier),
-- que já roda na extração quando uma conta é gravada em financial_account_control.
-- Projeto: pagamentos | Data: 2026-06-13
--
-- Como o email_control é inserido DEPOIS das contas, o trigger não consegue buscar
-- o sender_email de lá em tempo de insert — por isso a extração grava o sender_email
-- na própria conta (financial_account_control.sender_email) e o trigger o propaga
-- para supplier.email ao resolver/criar o fornecedor.
-- =============================================================

-- 1. Novas colunas
ALTER TABLE supplier
  ADD COLUMN IF NOT EXISTS email TEXT;

ALTER TABLE financial_account_control
  ADD COLUMN IF NOT EXISTS sender_email TEXT;

-- 2. Trigger de resolução de fornecedor passa a ALINHAR supplier.email.
--    SECURITY DEFINER para o UPDATE supplier funcionar mesmo em inserts de papéis
--    sem permissão de escrita em supplier (consistente com resolve_supplier_id).
CREATE OR REPLACE FUNCTION trg_fe_resolve_supplier()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  NEW.supplier_id := resolve_supplier_id(
    NEW.supplier_cnpj,
    NEW.supplier_cpf,
    NEW.supplier_name
  );

  -- Alinha supplier.email com o remetente do e-mail (sender_email gravado na conta).
  IF NEW.sender_email IS NOT NULL AND trim(NEW.sender_email) <> '' THEN
    UPDATE supplier
    SET    email = trim(NEW.sender_email)
    WHERE  supplier_id = NEW.supplier_id;
  END IF;

  RETURN NEW;
END;
$$;

-- 3. Backfill: alinha os fornecedores existentes com o sender_email do e-mail mais
--    recente que gerou conta para cada fornecedor (gmail_message_id -> message_id).
UPDATE supplier s
SET    email = sub.sender_email
FROM (
  SELECT DISTINCT ON (f.supplier_id)
         f.supplier_id,
         ec.sender_email
  FROM   financial_account_control f
  JOIN   email_control ec
         ON ec.message_id = split_part(f.gmail_message_id, '#', 1)
  WHERE  ec.sender_email IS NOT NULL
    AND  trim(ec.sender_email) <> ''
  ORDER  BY f.supplier_id, f.created_at DESC
) sub
WHERE  s.supplier_id = sub.supplier_id;
