-- 040_resolve_supplier_rpc.sql
-- FASE 1 (aditiva) da eliminação das colunas denormalizadas supplier_name/
-- supplier_cnpj/supplier_cpf de financial_account_control.
--
-- Cria um wrapper RPC que resolve/cria/enriquece o fornecedor e anexa o e-mail
-- do remetente, devolvendo o supplier_id. Reusa exatamente a lógica que hoje
-- roda dentro do trigger trg_fe_resolve_supplier (resolve_supplier_id +
-- _add_supplier_email) — apenas move o ponto de chamada do trigger para o
-- pipeline Python, que passa a gravar só a FK supplier_id.
--
-- Esta migration é NÃO-destrutiva: o trigger e as colunas continuam existindo.
-- O drop acontece na migration 041, após validação em produção.

CREATE OR REPLACE FUNCTION public.resolve_supplier_for_account(
  p_cnpj text,
  p_cpf text,
  p_name text,
  p_email text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id bigint;
BEGIN
  v_id := resolve_supplier_id(p_cnpj, p_cpf, p_name, p_email);
  PERFORM _add_supplier_email(v_id, p_email);
  RETURN v_id;
END;
$function$;

-- Pipeline Python/Flask usa service_role para chamar a RPC via PostgREST.
GRANT EXECUTE ON FUNCTION public.resolve_supplier_for_account(text, text, text, text) TO service_role;
