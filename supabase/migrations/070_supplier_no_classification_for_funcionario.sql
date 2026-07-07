-- 070_supplier_no_classification_for_funcionario.sql
-- Fornecedor de FUNCIONÁRIO NÃO carrega classificação contábil default.
--
-- Regra (decisão do usuário): quando o `trade_name` do fornecedor contém o termo
-- "funcionário"/"Funcionário" (sem acento/caixa — via normalize_search), as colunas
-- `supplier.cost_center_id` e `supplier.chart_account_id` NÃO são registradas — ficam em 0
-- ("não informado"). Motivo: a classificação de uma despesa de funcionário (reembolso/
-- adiantamento) varia por conta, então um DEFAULT no cadastro do fornecedor não faz sentido.
--
-- A trigger BEFORE INSERT/UPDATE força cc/plano = 0 para esses fornecedores, cobrindo TODOS os
-- caminhos de escrita numa fonte única: write-back do modal de contas (TS setSupplierClassification),
-- write-back da extração (Python update_supplier_classification / apply_forced_classification),
-- edição pelo CRUD de fornecedores (/fornecedores) e qualquer UPDATE direto. A classificação por
-- CONTA (financial_account_control) NÃO é afetada — só o default do fornecedor.
--
-- Idempotente (CREATE OR REPLACE + DROP/CREATE TRIGGER). Aplicar no SQL Editor.

CREATE OR REPLACE FUNCTION public.fn_supplier_block_funcionario_classification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.trade_name IS NOT NULL
     AND normalize_search(NEW.trade_name) LIKE '%funcionario%' THEN
    NEW.cost_center_id  := 0;   -- "não informado"
    NEW.chart_account_id := 0;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_supplier_no_funcionario_classification ON public.supplier;
CREATE TRIGGER trg_supplier_no_funcionario_classification
BEFORE INSERT OR UPDATE ON public.supplier
FOR EACH ROW EXECUTE FUNCTION public.fn_supplier_block_funcionario_classification();

-- Backfill: zera a classificação dos funcionários já cadastrados (write-backs passados).
UPDATE public.supplier
SET cost_center_id = 0, chart_account_id = 0
WHERE normalize_search(trade_name) LIKE '%funcionario%'
  AND (cost_center_id <> 0 OR chart_account_id <> 0);
