-- 136_fornecedor_pagadora_e_leadster.sql
-- CORRECAO DE DADOS: contas atraidas pelo cadastro sk_supplier = 4 via RAZAO SOCIAL da pagadora.
--
-- Projeto: pagamentos | Data: 2026-09-14
--
-- Defeito (caso real: contas 1020 e 1474, fatura Leadster): o corpo traz "Empresa: Textil E
-- Confeccoes Otimotex Ltda" — o DESTINATARIO. O rotulo "empresa" e de fornecedor no extrator do
-- corpo, e o nome da pagadora casava por razao social o cadastro sk 4 (LEBIANCO), cuja
-- legal_name era exatamente "TEXTIL E CONFECCOES OTIMOTEX LTDA". A conta herdava o plano ICMS-ST
-- (default do sk 4), e o write-back de contato gravava no sk 4 o e-mail/WhatsApp do fornecedor
-- real — que passavam a sequestrar as faturas seguintes pela busca por e-mail.
--
-- O mesmo ima puxou as contas 29 (protesto), 337 (resposta de cliente), 497 (Cipatex) e
-- 978 (ESPRO), cujos contatos tambem acabaram no sk 4.
--
-- A regra que IMPEDE a reincidencia vive no Python (read_emails.py: `_is_own_company_name` em
-- `_finalize_supplier`; `apply_due_date_reminder` para o vencimento). Esta migration corrige os
-- dados ja gravados e desmonta o ima no cadastro.
--
-- SEM DDL. Idempotente: todo UPDATE e condicionado ao valor ERRADO medido (re-run = UPDATE 0) e
-- todo INSERT tem NOT EXISTS. Abre com travas que abortam se os cadastros de destino nao forem
-- os medidos, e fecha com sonda que aborta se o estado final divergir.
--
-- Decisoes por conta (analise de 2026-09-14):
--   1474 -> 1369 Leadster; classificacao do cadastro; forma 'boleto' (o e-mail "Recebemos o seu
--           pagamento" da Leadster declara "Forma de pagamento: Boleto Bancario"); vencimento
--           27/09/2026, INFERIDO do ciclo das faturas anteriores (27/07 e 27/08) e mantido com a
--           marca de PRESUMIDO para que o proximo lembrete do fornecedor o confirme ou corrija.
--   497  -> 154 CIPATEX IMPREGNADORA (unico cadastro Cipatex com e-mail do dominio e classificacao)
--   978  -> 1182 ASSOCIACAO DE ENSINO SOCIAL PROFISSIONALIZANTE (ESPRO; CNPJ + e-mail do dominio)
--   29   -> cadastro novo do 1o Tabeliao de Protesto, SEM e-mail: o remetente
--           (cartoriooline@1tabeliao.sp.gov.br) nao e o endereco que o proprio corpo cita.
--   337  -> CANCELADA: e RECEBIVEL (o cliente responde "ja foi pago" a cobranca da LEBIANCO),
--           nao conta a pagar. Cadastro novo com o nome do cliente, porque a FK e obrigatoria.
--
-- Cadastro sk 4: legal_name volta a "LEBIANCO" (fim do casamento por razao social) e saem os
-- contatos alheios. Os que tem dono conhecido vao para ele, so onde o campo destino esta vazio.
-- noreply@gesttamail.com sai sem destino: e plataforma de tarefas contabeis, nao fornecedor.

SET client_encoding = 'UTF8';

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0) Travas — abortar aqui e o objetivo: UPDATE para o cadastro errado grava FK valida, sem erro
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supplier WHERE sk_supplier = 4 AND trade_name = 'LEBIANCO') THEN
    RAISE EXCEPTION '136: supplier 4 nao e o cadastro LEBIANCO — abortado';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supplier
                  WHERE sk_supplier = 1369 AND trade_name = 'Leadster' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION '136: supplier 1369 nao e o cadastro ativo Leadster — abortado';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supplier
                  WHERE sk_supplier = 154 AND cnpj = '47254461002289' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION '136: supplier 154 nao e a CIPATEX IMPREGNADORA ativa — abortado';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supplier
                  WHERE sk_supplier = 1182 AND cnpj = '51549301000100' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION '136: supplier 1182 nao e a ESPRO ativa — abortado';
  END IF;
  IF EXISTS (SELECT 1 FROM supplier WHERE cnpj = '30491515000100' AND sk_supplier <> 1369) THEN
    RAISE EXCEPTION '136: o CNPJ 30491515000100 ja pertence a outro cadastro — abortado';
  END IF;
  IF (SELECT count(*) FROM financial_account_control WHERE id IN (29, 337, 497, 978, 1474)) <> 5 THEN
    RAISE EXCEPTION '136: alguma das contas 29/337/497/978/1474 nao existe — abortado';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Cadastros de destino
-- ─────────────────────────────────────────────────────────────────────────────
-- Leadster: razao social e CNPJ do PRESTADOR das NFS-e enviadas pela Leadster (mesmo valor e
-- periodo das faturas) + os contatos que estavam no sk 4. Sem o CNPJ, o 1o boleto/NFS-e em PDF
-- criaria um cadastro "NEUROLOGIC" duplicado.
UPDATE supplier SET legal_name = 'NEUROLOGIC INTELIGENCIA ARTIFICIAL LTDA'
 WHERE sk_supplier = 1369 AND NULLIF(trim(COALESCE(legal_name, '')), '') IS NULL;
UPDATE supplier SET cnpj = '30491515000100'
 WHERE sk_supplier = 1369 AND NULLIF(trim(COALESCE(cnpj, '')), '') IS NULL;
UPDATE supplier SET email = 'financeiro@leadster.com.br'
 WHERE sk_supplier = 1369 AND NULLIF(trim(COALESCE(email, '')), '') IS NULL;
UPDATE supplier SET whatsapp1 = '4188174969'
 WHERE sk_supplier = 1369 AND NULLIF(trim(COALESCE(whatsapp1, '')), '') IS NULL;

-- Cipatex: telefone do rodape da cobranca (conta 497).
UPDATE supplier SET phone_ddd1 = '15', phone1 = '32849040'
 WHERE sk_supplier = 154 AND NULLIF(trim(COALESCE(phone1, '')), '') IS NULL;

-- ESPRO: chave PIX da fatura (conta 978).
UPDATE supplier SET pix_key1 = 'cobranca@espro.org.br'
 WHERE sk_supplier = 1182 AND NULLIF(trim(COALESCE(pix_key1, '')), '') IS NULL;

INSERT INTO supplier (legal_name, trade_name)
SELECT '1º TABELIÃO DE PROTESTO DE TÍTULOS', '1º TABELIÃO DE PROTESTO'
 WHERE NOT EXISTS (SELECT 1 FROM supplier WHERE legal_name = '1º TABELIÃO DE PROTESTO DE TÍTULOS');

INSERT INTO supplier (legal_name, trade_name)
SELECT 'NOVO MERCADO COMERCIO DE TECIDOS', 'CANTINHO DOS TECIDOS'
 WHERE NOT EXISTS (SELECT 1 FROM supplier WHERE legal_name = 'NOVO MERCADO COMERCIO DE TECIDOS');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Contas
-- ─────────────────────────────────────────────────────────────────────────────
-- A classificacao vem do CADASTRO de destino (nao de literal): e o que o pipeline teria gravado
-- com o fornecedor certo.
UPDATE financial_account_control f
   SET sk_supplier      = s.sk_supplier,
       cost_center_id   = s.cost_center_id,
       chart_account_id = s.chart_account_id,
       payment_method   = 'boleto',
       due_date         = DATE '2026-09-27',
       processing_notes = 'Vencimento presumido: o e-mail não informava a data'
                          || ' | 27/09/2026 inferido do ciclo das faturas anteriores (27/07 e 27/08);'
                          || ' o próximo lembrete do fornecedor confirma ou corrige'
  FROM supplier s
 WHERE s.sk_supplier = 1369 AND f.id = 1474 AND f.sk_supplier = 4;

UPDATE financial_account_control f
   SET sk_supplier = s.sk_supplier, cost_center_id = s.cost_center_id,
       chart_account_id = s.chart_account_id
  FROM supplier s
 WHERE s.sk_supplier = 154 AND f.id = 497 AND f.sk_supplier = 4;

UPDATE financial_account_control f
   SET sk_supplier = s.sk_supplier, cost_center_id = s.cost_center_id,
       chart_account_id = s.chart_account_id
  FROM supplier s
 WHERE s.sk_supplier = 1182 AND f.id = 978 AND f.sk_supplier = 4;

-- 29: so o fornecedor. A classificacao (14/463) foi curada e o cadastro novo nao tem default.
UPDATE financial_account_control f
   SET sk_supplier = s.sk_supplier
  FROM supplier s
 WHERE s.legal_name = '1º TABELIÃO DE PROTESTO DE TÍTULOS' AND f.id = 29 AND f.sk_supplier = 4;

-- 337: cancelada (remocao padrao de conta). A trigger de payment_date limpa a data ao sair de pago.
UPDATE financial_account_control f
   SET sk_supplier      = s.sk_supplier,
       status_id        = 9,
       processing_notes = concat_ws(' | ', NULLIF(trim(COALESCE(f.processing_notes, '')), ''),
                                    'Cancelada (migration 136): recebível, não conta a pagar —'
                                    || ' resposta do cliente à cobrança da LEBIANCO')
  FROM supplier s
 WHERE s.legal_name = 'NOVO MERCADO COMERCIO DE TECIDOS' AND f.id = 337 AND f.sk_supplier = 4;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Cadastro sk 4 — desmonta o ima (cada campo so sai se ainda tiver o valor alheio)
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE supplier SET legal_name = 'LEBIANCO'
 WHERE sk_supplier = 4
   AND normalize_search(legal_name) = normalize_search('TEXTIL E CONFECCOES OTIMOTEX LTDA');
UPDATE supplier SET email  = NULL
 WHERE sk_supplier = 4 AND lower(trim(email))  = 'cartoriooline@1tabeliao.sp.gov.br';
UPDATE supplier SET email2 = NULL
 WHERE sk_supplier = 4 AND lower(trim(email2)) = 'cantinhodostecidos@outlook.com';
UPDATE supplier SET email3 = NULL
 WHERE sk_supplier = 4 AND lower(trim(email3)) = 'financeiro@leadster.com.br';
UPDATE supplier SET email4 = NULL
 WHERE sk_supplier = 4 AND lower(trim(email4)) = 'noreply@gesttamail.com';
UPDATE supplier SET phone_ddd1 = NULL, phone1 = NULL
 WHERE sk_supplier = 4 AND phone1 = '32422200';
UPDATE supplier SET phone_ddd2 = NULL, phone2 = NULL
 WHERE sk_supplier = 4 AND phone2 = '32849040';
UPDATE supplier SET whatsapp1 = NULL
 WHERE sk_supplier = 4 AND whatsapp1 = '4188174969';
UPDATE supplier SET pix_key1 = NULL
 WHERE sk_supplier = 4 AND pix_key1 = 'cobranca@espro.org.br';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Sonda — aborta (e desfaz tudo) se o estado final nao for o esperado
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_destino int;
BEGIN
  -- P1: as 5 contas no destino, com o estado completo que a correcao promete.
  SELECT count(*) INTO v_destino
    FROM financial_account_control f
    JOIN supplier s ON s.sk_supplier = f.sk_supplier
   WHERE (f.id = 1474 AND f.sk_supplier = 1369 AND f.payment_method = 'boleto'
          AND f.due_date = DATE '2026-09-27'
          AND f.cost_center_id = s.cost_center_id AND f.chart_account_id = s.chart_account_id
          AND f.processing_notes LIKE 'Vencimento presumido: o e-mail não informava a data%')
      OR (f.id = 497 AND f.sk_supplier = 154
          AND f.cost_center_id = s.cost_center_id AND f.chart_account_id = s.chart_account_id)
      OR (f.id = 978 AND f.sk_supplier = 1182
          AND f.cost_center_id = s.cost_center_id AND f.chart_account_id = s.chart_account_id)
      OR (f.id = 29  AND s.legal_name = '1º TABELIÃO DE PROTESTO DE TÍTULOS')
      OR (f.id = 337 AND s.legal_name = 'NOVO MERCADO COMERCIO DE TECIDOS'
          AND f.status_id = 9 AND f.payment_date IS NULL);
  IF v_destino <> 5 THEN
    RAISE EXCEPTION '136/P1: esperado 5 contas no destino, obtido %', v_destino;
  END IF;

  -- P2: nenhum contato alheio nem a razao social da pagadora sobrou no sk 4.
  IF EXISTS (SELECT 1 FROM supplier
              WHERE sk_supplier = 4
                AND (   lower(concat_ws(' ', email, email2, email3, email4))
                          ~ '(leadster|tabeliao|cantinhodostecidos|gesttamail)'
                     OR COALESCE(phone1, '') IN ('32422200', '32849040')
                     OR COALESCE(phone2, '') IN ('32422200', '32849040')
                     OR COALESCE(whatsapp1, '') = '4188174969'
                     OR COALESCE(pix_key1, '') = 'cobranca@espro.org.br'
                     OR normalize_search(legal_name)
                          = normalize_search('TEXTIL E CONFECCOES OTIMOTEX LTDA'))) THEN
    RAISE EXCEPTION '136/P2: o cadastro 4 ainda carrega contato alheio ou a razao social da pagadora';
  END IF;

  -- P3: oraculo do defeito — a MESMA consulta que o pipeline usa (migration 134) resolve o
  -- e-mail da Leadster para o 1369. Antes desta migration ela devolvia o sk 4.
  IF public.find_supplier_by_email('financeiro@leadster.com.br') IS DISTINCT FROM 1369 THEN
    RAISE EXCEPTION '136/P3: financeiro@leadster.com.br nao resolve para o 1369 (obtido %)',
      public.find_supplier_by_email('financeiro@leadster.com.br');
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- VERIFICACAO (rodar apos aplicar):
--
--   SELECT id, sk_supplier, status_id, payment_method, due_date, cost_center_id,
--          chart_account_id, processing_notes
--     FROM financial_account_control WHERE id IN (29, 337, 497, 978, 1474) ORDER BY id;
--
--   SELECT * FROM supplier WHERE sk_supplier IN (4, 154, 1182, 1369);
--
--   -- idempotencia: reaplicar esta migration -> todos os UPDATE/INSERT com 0 linhas.
-- ============================================================================
