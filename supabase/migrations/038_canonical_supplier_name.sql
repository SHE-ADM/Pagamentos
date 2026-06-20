-- 038_canonical_supplier_name.sql
-- Garante que financial_account_control.supplier_name sempre reflita o nome
-- canônico do cadastro (supplier.trade_name ou supplier.legal_name), não o
-- nome bruto extraído do e-mail/PDF.
--
-- Também corrige o cadastro de fornecedor:
--   - supplier_id=109 recebe o e-mail financeiro@smartwebservices.com.br
--   - supplier_id=1096 (duplicata de 109) é removido

-- 1. Adiciona e-mails ao supplier_id=109 (LOJAS VIRTUAIS.NET LTDA)
UPDATE supplier
SET email = 'financeiro@smartwebservices.com.br'
WHERE supplier_id = 109
  AND (email IS NULL OR trim(email) = '');

UPDATE supplier
SET email2 = 'boleto@smartwebservices.com.br'
WHERE supplier_id = 109
  AND (email2 IS NULL OR trim(email2) = '');

-- 2. Remove duplicata
DELETE FROM supplier WHERE supplier_id = 1096;

-- 3. Trigger: sobrescreve supplier_name com o nome canônico após resolver supplier_id
CREATE OR REPLACE FUNCTION public.trg_fe_resolve_supplier()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  NEW.supplier_id := resolve_supplier_id(
    NEW.supplier_cnpj,
    NEW.supplier_cpf,
    NEW.supplier_name,
    NEW.sender_email
  );

  PERFORM _add_supplier_email(NEW.supplier_id, NEW.sender_email);

  -- Sobrescreve supplier_name com o nome canônico do cadastro (trade_name ou legal_name).
  -- Garante que o DataGrid sempre exiba o nome original do fornecedor, não o extraído.
  IF NEW.supplier_id IS NOT NULL THEN
    SELECT COALESCE(
             NULLIF(trim(trade_name), ''),
             NULLIF(trim(legal_name), ''),
             NEW.supplier_name
           )
    INTO NEW.supplier_name
    FROM supplier
    WHERE supplier_id = NEW.supplier_id;
  END IF;

  RETURN NEW;
END;
$function$;
