-- =============================================================
-- 134_find_supplier_by_email.sql
-- Lookup de fornecedor por E-MAIL que NUNCA cria fornecedor.
--
-- Projeto: pagamentos | Data: 2026-08-19
--
-- POR QUE EXISTE: o pipeline passa a poder identificar o fornecedor pelo REMETENTE
-- ORIGINAL de um bloco ENCAMINHADO no corpo. Caso de origem: conta id 1101 — o
-- despachante manda a guia da Junta Comercial para a funcionária, que a encaminha; o
-- PDF de guia de arrecadação NÃO traz favorecido e o remetente imediato é interno, de
-- modo que o "De:" da cadeia é o único sinal do credor real. Sem isto, a conta caía na
-- regra de imposto e era gravada sob a própria OTIMOTEX, com a classificação contábil
-- default dela (Recursos Humanos / Festas e Confraternizações) numa guia da Junta.
--
-- 🔴 ESSE ENDEREÇO É SINAL FRACO: diz "esta pessoa MANDOU o documento", não "esta
-- pessoa RECEBE o pagamento". Por isso ele só pode IDENTIFICAR um fornecedor JÁ
-- CADASTRADO E CURADO — jamais criar um. Usar `resolve_supplier_for_account` para isto
-- faria QUALQUER pessoa que encaminhasse uma guia virar fornecedor no primeiro e-mail,
-- pelo auto-insert no fim de `resolve_supplier_id` (migration 109). É essa separação —
-- CONSULTA aqui, CRIAÇÃO lá — que a função existe para tornar estrutural em vez de
-- disciplinar.
--
-- Mesma semântica do Passo 4 de `resolve_supplier_id`: comparação por lower(trim())
-- contra email/email2/email3/email4, com `_is_internal_email` (046) e
-- `_is_platform_email` (109) barrando endereço interno e de intermediário. As duas
-- funções são REUSADAS, não reescritas em Python: uma 2ª cópia divergiria no primeiro
-- ajuste e o pipeline passaria a discordar do banco sem erro nenhum.
--
-- DUAS DIFERENÇAS DELIBERADAS em relação ao Passo 4:
--   * filtra `deleted_at IS NULL` — cadastro removido por soft delete não volta a
--     receber conta (é o que faz a limpeza de fornecedores órfãos ter efeito aqui);
--   * `ORDER BY sk_supplier` antes do LIMIT 1 — o Passo 4 tem LIMIT sem ORDER BY, e o
--     vencedor de um empate varia com o plano de execução. Aqui a resposta é
--     determinística, porque ela decide sob qual fornecedor o dinheiro é lançado.
--
-- SECURITY DEFINER + REVOKE/GRANT explícitos (mesma disciplina da 072): a função lê
-- `supplier`, e sem o REVOKE o default do PostgreSQL a deixa executável por PUBLIC —
-- chamável com a anon key pública, sem login.
-- Idempotente (CREATE OR REPLACE). 🔴 NÃO trocar por DROP FUNCTION: apagaria os grants
-- abaixo e a função voltaria a nascer aberta (lição da 116, reincidente na 118/124/125).
-- =============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.find_supplier_by_email(p_email text)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_email TEXT := NULLIF(lower(trim(COALESCE(p_email, ''))), '');
  v_id    BIGINT;
BEGIN
  IF v_email IS NULL THEN
    RETURN NULL;
  END IF;

  -- E-mail interno (o funcionário que encaminhou) e e-mail de plataforma (SSW e afins,
  -- compartilhado por dezenas de fornecedores) identificam o INTERMEDIÁRIO, nunca o
  -- credor. Mesmo raciocínio das migrations 046 e 109.
  IF public._is_internal_email(v_email) OR public._is_platform_email(v_email) THEN
    RETURN NULL;
  END IF;

  SELECT s.sk_supplier
    INTO v_id
  FROM   public.supplier s
  WHERE  s.deleted_at IS NULL
    AND  v_email IN (lower(trim(s.email)),  lower(trim(s.email2)),
                     lower(trim(s.email3)), lower(trim(s.email4)))
  ORDER  BY s.sk_supplier
  LIMIT  1;

  -- NULL quando não encontrou. O chamador NÃO cria fornecedor: segue para a regra de
  -- imposto e para os demais fallbacks, exatamente como antes desta função existir.
  RETURN v_id;
END;
$function$;

COMMENT ON FUNCTION public.find_supplier_by_email(text) IS
  'Fornecedor JA CADASTRADO e ATIVO cujo email/email2/email3/email4 casa p_email '
  '(lower+trim). NUNCA insere — e essa e a diferenca em relacao a resolve_supplier_id, '
  'que termina em auto-insert. E-mail interno (046) e de plataforma (109) nao '
  'identificam fornecedor. Usada pelo pipeline para o remetente ORIGINAL de um bloco '
  'encaminhado no corpo do e-mail. Ver migration 134.';

REVOKE EXECUTE ON FUNCTION public.find_supplier_by_email(text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.find_supplier_by_email(text) TO service_role;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Sonda — a migration verifica a si mesma.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_alvo   BIGINT;
  v_email  TEXT;
  v_antes  BIGINT;
  v_depois BIGINT;
BEGIN
  -- P0 (anti-vacuidade): existe um fornecedor ATIVO com e-mail cadastrado para
  -- exercitar? Sem isso, os testes abaixo provariam apenas "NULL == NULL".
  SELECT s.sk_supplier, lower(trim(s.email))
    INTO v_alvo, v_email
  FROM   public.supplier s
  WHERE  s.deleted_at IS NULL
    AND  NULLIF(trim(COALESCE(s.email, '')), '') IS NOT NULL
    AND  NOT public._is_internal_email(s.email)
    AND  NOT public._is_platform_email(s.email)
  ORDER  BY s.sk_supplier
  LIMIT  1;

  IF v_alvo IS NULL THEN
    RAISE EXCEPTION 'sonda vazia: nenhum fornecedor ativo com e-mail externo para exercitar';
  END IF;

  -- P1: acha o cadastro pelo e-mail, e a comparacao e case/whitespace-INSENSITIVE
  -- (era o motivo de nao usar `eq` do PostgREST).
  IF public.find_supplier_by_email(v_email) IS DISTINCT FROM v_alvo THEN
    RAISE EXCEPTION 'P1: nao resolveu o fornecedor % pelo e-mail %', v_alvo, v_email;
  END IF;
  IF public.find_supplier_by_email('  ' || upper(v_email) || ' ') IS DISTINCT FROM v_alvo THEN
    RAISE EXCEPTION 'P2: comparacao sensivel a caixa/espaco — o Passo 4 usa lower(trim())';
  END IF;

  -- P3: entrada vazia/nula e e-mail interno devolvem NULL, nunca um cadastro qualquer.
  IF public.find_supplier_by_email(NULL) IS NOT NULL
     OR public.find_supplier_by_email('') IS NOT NULL
     OR public.find_supplier_by_email('   ') IS NOT NULL THEN
    RAISE EXCEPTION 'P3: entrada vazia devolveu fornecedor';
  END IF;
  IF public.find_supplier_by_email('qualquer.um@otimotex.com.br') IS NOT NULL THEN
    RAISE EXCEPTION 'P4: e-mail de dominio interno identificou fornecedor';
  END IF;

  -- P5: 🔴 A PROPRIEDADE CENTRAL — a funcao NAO cria fornecedor. Um e-mail que nao
  -- casa nada devolve NULL e a contagem de `supplier` fica INALTERADA.
  SELECT count(*) INTO v_antes FROM public.supplier;
  IF public.find_supplier_by_email('nao.cadastrado.jamais.134@example.invalid') IS NOT NULL THEN
    RAISE EXCEPTION 'P5: e-mail desconhecido resolveu um fornecedor';
  END IF;
  SELECT count(*) INTO v_depois FROM public.supplier;
  IF v_depois <> v_antes THEN
    RAISE EXCEPTION 'P5: a funcao CRIOU fornecedor (% -> %) — ela e consulta pura',
                    v_antes, v_depois;
  END IF;

  -- P6: os grants sairam como esperado (REVOKE do publico, GRANT so ao service_role).
  IF has_function_privilege('anon', 'public.find_supplier_by_email(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.find_supplier_by_email(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P6: funcao executavel por anon/authenticated — o REVOKE nao pegou';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.find_supplier_by_email(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P6: service_role sem EXECUTE — o pipeline nao conseguiria chamar';
  END IF;
END $$;
