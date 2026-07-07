-- 071_add_payment_method_debito_automatico.sql
-- Adiciona 'débito automático' ao domínio de financial_account_control.payment_method.
--
-- Motivo: contas de concessionária (ex.: Sabesp água) declaram no corpo do e-mail
-- "Tipo de pagamento: Débito Automático" — um débito DIRETO em conta, distinto do
-- 'débito' (cartão-débito) do enum. Passa a ser valor próprio, capturado pelo detector
-- _classify_body_payment_method (read_emails.py). 'vale' já existia no domínio.
--
-- O CHECK de payment_method NÃO usa lower() (diferente de document_type) — é match
-- exato de valor, então o novo valor entra literal na lista.
--
-- Idempotente (DROP IF EXISTS + ADD). Aplicar no SQL Editor.

ALTER TABLE public.financial_account_control
  DROP CONSTRAINT IF EXISTS financial_account_control_payment_method_check;

ALTER TABLE public.financial_account_control
  ADD CONSTRAINT financial_account_control_payment_method_check
  CHECK (payment_method IN (
    'boleto', 'pix', 'ted', 'cartão', 'depósito', 'duplicata', 'bancário',
    'carteira', 'vale', 'crédito', 'débito', 'débito automático', 'dinheiro',
    'transferência', 'cheque', 'outro'
  ));

-- Re-mapeia as contas de água Sabesp (antes gravadas como 'débito' pelo backfill anterior)
-- para o valor específico agora que ele existe.
UPDATE public.financial_account_control
SET payment_method = 'débito automático'
WHERE id IN (171, 189, 190)
  AND payment_method = 'débito';
