-- =============================================================
-- 147_efi_plataforma_fornecedor_nome.sql
-- E-mail da Efí vira e-mail de PLATAFORMA; contas 766/1685 voltam ao fornecedor real e o
-- cadastro-lixo "Nome" (sk 1319) é desativado.
--
-- Projeto: pagamentos | Data: 2026-09-25
--
-- POR QUE EXISTE: a cobrança de assinatura da AGENCIA K1 DIGITAL (sk 1092) chega pela Efí
-- (ex-Gerencianet), de `naoresponda@notificacao.sejaefimail.com.br`. Desde julho a Efí manda
-- o bloco "Dados do emissor" como TABELA achatada ("Nome / Telefone / AGENCIA K1…"), e o
-- pipeline gravava o CABEÇALHO "Nome" como fornecedor:
--   - conta 766 (e-mail 1190, 31/07) — criou o cadastro sk 1319 "Nome"; cancelada à mão;
--   - conta 1685 (e-mail 2422, 25/09) — casou o mesmo sk 1319 "Nome", sem plano de contas.
-- O código foi corrigido (handler do link Efí + rótulo de campo nunca é fornecedor). Esta
-- migration fecha o que o código não alcança:
--
--   1. `_is_platform_email` passa a reconhecer `sejaefimail.com.br`. O endereço é da
--      PLATAFORMA, compartilhado por todo emissor que cobra pela Efí — mesma classe da SSW
--      (migration 109). Sem isto, a RPC gravou o e-mail no auto-insert do sk 1319 e o passo
--      por e-mail passaria a atribuir a ele QUALQUER cobrança Efí sem nome legível.
--   2. Contas 766 e 1685 → sk 1092, com a classificação default do cadastro (lida dele, não
--      escrita à mão). A 766 segue CANCELADA — só o fornecedor muda.
--   3. sk 1319 → soft delete (padrão do projeto; nunca hard delete) e e-mail limpo. O e-mail
--      já sairia pelo passo 1, mas a limpeza é explícita e verificada pela sonda.
--
-- Idempotente: CREATE OR REPLACE (mesma assinatura) e UPDATEs condicionados ao estado antigo
-- — reexecutar é UPDATE 0 e sondas verdes.
-- =============================================================

BEGIN;

-- Baseline congelado ANTES dos UPDATEs (a sonda não pode reavaliar o predicado alterado).
CREATE TEMP TABLE _m147_contas ON COMMIT DROP AS
SELECT id, status_id
FROM   public.financial_account_control
WHERE  sk_supplier = 1319;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) E-mail de plataforma — SSW (109) + Efí
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._is_platform_email(p_email text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT lower(trim(COALESCE(p_email, ''))) LIKE '%@sswsistemas.com.br'
      OR lower(trim(COALESCE(p_email, ''))) LIKE '%@ssw.inf.br'
      OR lower(trim(COALESCE(p_email, ''))) LIKE '%@sejaefimail.com.br'
      OR lower(trim(COALESCE(p_email, ''))) LIKE '%.sejaefimail.com.br';
$function$;

COMMENT ON FUNCTION public._is_platform_email(text) IS
  'E-mail de plataforma/intermediário de cobrança (SSW, Efí). Não identifica fornecedor: '
  'não casa no Passo 4 de resolve_supplier_id, não é armazenado no auto-insert e não é '
  'propagado por _add_supplier_email. Ver migrations 109 e 147.';

-- Os três chamadores são SECURITY DEFINER (rodam como dono): nenhum papel precisa de EXECUTE
-- direto. O default do PostgreSQL deixava a função executável por PUBLIC.
REVOKE EXECUTE ON FUNCTION public._is_platform_email(text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public._is_platform_email(text) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Contas do cadastro-lixo → fornecedor real, com a classificação default dele
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE public.financial_account_control f
SET    sk_supplier      = s.sk_supplier,
       cost_center_id   = s.cost_center_id,
       chart_account_id = s.chart_account_id
FROM   public.supplier s
WHERE  s.sk_supplier = 1092
  AND  s.cnpj        = '48720377000141'   -- confirma que o 1092 ainda é a AGENCIA K1
  AND  f.sk_supplier = 1319
  AND  f.id IN (766, 1685);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Cadastro-lixo "Nome" → soft delete + e-mail da plataforma removido
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE public.supplier
SET    email      = NULL,
       deleted_at = COALESCE(deleted_at, now())
WHERE  sk_supplier = 1319
  AND  legal_name  = 'Nome'
  AND  (email IS NOT NULL OR deleted_at IS NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- Sonda — DENTRO da transação: qualquer divergência desfaz a migration inteira.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  c_efi       CONSTANT TEXT := 'naoresponda@notificacao.sejaefimail.com.br';
  v_moved     INTEGER;
  v_left      INTEGER;
  v_status    INTEGER;
  v_class     INTEGER;
  v_sup       RECORD;
  v_raised    BOOLEAN := false;
  v_got       BIGINT;
BEGIN
  -- P0 (anti-vacuidade): numa 1ª execução o baseline tem as 2 contas; na reexecução, 0 —
  -- e então as contas já têm de estar no 1092 (P2 cobre).
  SELECT count(*) INTO v_moved FROM _m147_contas;

  -- P1: domínio de plataforma — Efí e subdomínio sim; SSW não regride; e-mail comum não.
  IF NOT public._is_platform_email(c_efi)
     OR NOT public._is_platform_email('x@sejaefimail.com.br')
     OR NOT public._is_platform_email('x@sswsistemas.com.br')
     OR NOT public._is_platform_email('x@ssw.inf.br') THEN
    RAISE EXCEPTION 'P1: e-mail de plataforma nao reconhecido';
  END IF;
  IF public._is_platform_email('comercial@k1digital.com.br')
     OR public._is_platform_email('x@evilsejaefimail.com.br')
     OR public._is_platform_email(NULL) THEN
    RAISE EXCEPTION 'P1: e-mail comum reconhecido como plataforma';
  END IF;

  -- P2: nenhuma conta sobra no 1319; 766 e 1685 estão no 1092 com a classificação dele.
  SELECT count(*) INTO v_left FROM public.financial_account_control WHERE sk_supplier = 1319;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'P2: % conta(s) ainda no cadastro-lixo 1319', v_left;
  END IF;
  SELECT count(*) INTO v_class
  FROM   public.financial_account_control f
  JOIN   public.supplier s ON s.sk_supplier = f.sk_supplier
  WHERE  f.id IN (766, 1685)
    AND  f.sk_supplier = 1092
    AND  f.cost_center_id = s.cost_center_id
    AND  f.chart_account_id = s.chart_account_id;
  IF v_class <> 2 THEN
    RAISE EXCEPTION 'P2: 766/1685 nao estao no 1092 com a classificacao default (% de 2)', v_class;
  END IF;

  -- P3: a situação das contas movidas NÃO mudou (a 766 segue cancelada) — oráculo = baseline.
  SELECT count(*) INTO v_status
  FROM   _m147_contas b
  JOIN   public.financial_account_control f ON f.id = b.id
  WHERE  f.status_id IS DISTINCT FROM b.status_id;
  IF v_status <> 0 THEN
    RAISE EXCEPTION 'P3: % conta(s) mudaram de situacao ao trocar o fornecedor', v_status;
  END IF;

  -- P4: o 1319 está desativado e sem e-mail.
  SELECT deleted_at, email, email2, email3, email4 INTO v_sup
  FROM   public.supplier WHERE sk_supplier = 1319;
  IF FOUND AND (v_sup.deleted_at IS NULL OR v_sup.email IS NOT NULL OR v_sup.email2 IS NOT NULL
                OR v_sup.email3 IS NOT NULL OR v_sup.email4 IS NOT NULL) THEN
    RAISE EXCEPTION 'P4: cadastro 1319 ainda ativo ou com e-mail';
  END IF;

  -- P5: nenhum cadastro guarda e-mail da Efí.
  IF EXISTS (SELECT 1 FROM public.supplier
             WHERE public._is_platform_email(email)  OR public._is_platform_email(email2)
                OR public._is_platform_email(email3) OR public._is_platform_email(email4)) THEN
    RAISE EXCEPTION 'P5: ha cadastro com e-mail de plataforma';
  END IF;

  -- P6: a RPC não resolve mais por e-mail da Efí — só com ele, recusa (e não insere).
  BEGIN
    v_got := public.resolve_supplier_id(NULL, NULL, NULL, c_efi);
  EXCEPTION WHEN OTHERS THEN
    v_raised := SQLERRM LIKE '%nenhum identificador valido%';
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'P6: e-mail da Efi ainda resolve fornecedor (devolveu %)', v_got;
  END IF;

  -- P7: o nome que o corpo agora extrai resolve o fornecedor real.
  v_got := public.resolve_supplier_id(NULL, NULL, 'AGENCIA K1 DIGITAL WEBSITES E MARKETING', c_efi);
  IF v_got IS DISTINCT FROM 1092 THEN
    RAISE EXCEPTION 'P7: nome do emissor resolveu % (esperado 1092)', v_got;
  END IF;

  -- P8: grants — só service_role executa.
  IF has_function_privilege('anon', 'public._is_platform_email(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._is_platform_email(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P8: _is_platform_email executavel por anon/authenticated';
  END IF;

  RAISE NOTICE 'sonda 147 ok: % conta(s) movidas nesta execucao', v_moved;
END $$;

COMMIT;
