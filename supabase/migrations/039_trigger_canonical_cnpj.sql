-- 039_trigger_canonical_cnpj.sql
-- Estende o trigger trg_fe_resolve_supplier para também sobrescrever
-- supplier_cnpj e supplier_cpf com os valores canônicos do cadastro (supplier),
-- não os extraídos do e-mail/PDF.
-- Mesma lógica já aplicada ao supplier_name na migration 038.

CREATE OR REPLACE FUNCTION public.trg_fe_resolve_supplier()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  NEW.supplier_id := resolve_supplier_id(
    NEW.supplier_cnpj, NEW.supplier_cpf, NEW.supplier_name, NEW.sender_email
  );
  PERFORM _add_supplier_email(NEW.supplier_id, NEW.sender_email);

  IF NEW.supplier_id IS NOT NULL THEN
    SELECT
      COALESCE(NULLIF(trim(trade_name), ''), NULLIF(trim(legal_name), ''), NEW.supplier_name),
      COALESCE(NULLIF(trim(cnpj), ''), NEW.supplier_cnpj),
      COALESCE(NULLIF(trim(cpf),  ''), NEW.supplier_cpf)
    INTO NEW.supplier_name, NEW.supplier_cnpj, NEW.supplier_cpf
    FROM supplier
    WHERE supplier_id = NEW.supplier_id;
  END IF;

  RETURN NEW;
END;
$function$;

-- Backfill: propaga nome, CNPJ e CPF canônicos para os registros existentes.
-- Executar com o trigger desabilitado para evitar re-resolução pelo próprio trigger.
ALTER TABLE financial_account_control DISABLE TRIGGER trg_fe_supplier_id;

UPDATE financial_account_control fac
SET
  supplier_name = COALESCE(NULLIF(trim(s.trade_name),''), NULLIF(trim(s.legal_name),''), fac.supplier_name),
  supplier_cnpj = COALESCE(NULLIF(trim(s.cnpj),''), fac.supplier_cnpj),
  supplier_cpf  = COALESCE(NULLIF(trim(s.cpf), ''), fac.supplier_cpf)
FROM supplier s
WHERE fac.supplier_id = s.supplier_id
  AND (
    fac.supplier_name IS DISTINCT FROM COALESCE(NULLIF(trim(s.trade_name),''), NULLIF(trim(s.legal_name),''), fac.supplier_name)
    OR fac.supplier_cnpj IS DISTINCT FROM COALESCE(NULLIF(trim(s.cnpj),''), fac.supplier_cnpj)
    OR fac.supplier_cpf  IS DISTINCT FROM COALESCE(NULLIF(trim(s.cpf), ''), fac.supplier_cpf)
  );

ALTER TABLE financial_account_control ENABLE TRIGGER trg_fe_supplier_id;
