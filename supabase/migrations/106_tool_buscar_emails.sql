-- 106_tool_buscar_emails.sql
--
-- ONDA 2 (item 2.4) do roadmap — docs/roadmap-enriquecimento-dados.md
--
-- A migration 105 passou a guardar o corpo completo, mas dado guardado não vira resposta sozinho:
-- o modelo só enxerga o que pode CHAMAR. Esta é a 8ª tool — e a PRIMEIRA que sai da tabela de
-- contas e alcança a caixa de e-mails.
--
-- O QUE ELA DESTRAVA
-- Perguntas hoje impossíveis em qualquer camada do sistema: "em qual e-mail o fornecedor X falou
-- em reajuste?", "quais e-mails mencionam contrato?". Também é o primeiro passo para responder
-- "qual a taxa de sucesso da extração" (§4 do documento de auditoria), que ficou de fora da Onda 1
-- justamente porque as falhas vivem aqui, e não em financial_account_control.
--
-- ---------------------------------------------------------------------------
-- SEGURANÇA — a RLS desta tabela usa OUTRA chave, e isso importa
-- ---------------------------------------------------------------------------
-- `email_control` é recortada pela migration 078: o grupo com `sees_only_own_accounts` (hoje só o
-- Comercial) enxerga apenas os e-mails de que é REMETENTE — `lower(sender_email) = lower(auth.email())`.
-- É uma chave diferente da usada em contas (`created_by`, UUID). Como esta função é SECURITY
-- INVOKER, o recorte vem de graça e permanece correto; trocar para DEFINER exporia a caixa inteira.
--
-- PII: o corpo de e-mail carrega dados pessoais. Por isso a função devolve um TRECHO
-- (`ts_headline`), não o corpo inteiro — o suficiente para o modelo entender o contexto e citar,
-- sem despejar mensagens completas no contexto (e no log de auditoria).

CREATE OR REPLACE FUNCTION analytics.buscar_emails(
    p_termo      text,
    p_date_from  date    DEFAULT NULL,
    p_date_to    date    DEFAULT NULL,
    p_sender     text    DEFAULT NULL,
    p_status     text[]  DEFAULT NULL,
    p_limit      integer DEFAULT 20
)
RETURNS TABLE (
    email_id     bigint,
    received_at  timestamptz,
    sender_email text,
    subject      text,
    status       text,
    trecho       text,
    tem_anexo    boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT
        e.id,
        e.received_at,
        e.sender_email,
        e.subject,
        e.status,
        -- Trecho com o termo destacado, não o corpo inteiro: limita PII no contexto do modelo e
        -- mantém a resposta legível. MaxFragments=2 dá contexto sem virar parede de texto.
        --
        -- ⚠️ O texto passado aqui tem de ser o MESMO que o tsvector indexa (assunto + corpo). A
        -- primeira versão passava só o corpo, e o resultado foi medido: para o termo "boleto",
        -- 104 de 255 e-mails (41%) vinham SEM destaque — 50 deles não têm corpo algum e casaram
        -- apenas pelo assunto, devolvendo trecho vazio. O trecho precisa refletir o que a busca
        -- casou; caso contrário o modelo recebe linha sem contexto e não sabe por que ela veio.
        --
        -- ⚠️ O `COALESCE(e.subject, '')` não é redundante: em SQL, `NULL || texto` devolve **NULL**,
        -- então um e-mail sem `Subject` faria a concatenação inteira virar NULL e o `trecho` sair
        -- nulo — linha sem contexto para o modelo. Hoje há 0 e-mails sem assunto, mas mensagem sem
        -- Subject é comum no mundo real.
        ts_headline(
            'portuguese'::regconfig,
            left(COALESCE(e.subject, '') || ' — ' || COALESCE(e.body_full, e.body_preview, ''), 4000),
            plainto_tsquery('portuguese'::regconfig, p_termo),
            'MaxFragments=2, MaxWords=35, MinWords=10, StartSel=<<, StopSel=>>'
        ),
        COALESCE(e.has_attachment, false)
    FROM public.email_control e
    WHERE e.body_search @@ plainto_tsquery('portuguese'::regconfig, p_termo)
      AND (p_date_from IS NULL OR e.received_at >= p_date_from)
      -- +1 dia porque received_at é timestamptz e o parâmetro é date: sem isso, o e-mail das 14h
      -- do próprio dia final ficaria de fora (>= 00:00 do dia seguinte é o fim do dia informado).
      AND (p_date_to   IS NULL OR e.received_at < (p_date_to + 1))
      AND (p_sender    IS NULL
           OR public.normalize_search(COALESCE(e.sender_email, ''))
              LIKE '%' || public.normalize_search(p_sender) || '%')
      AND (p_status    IS NULL OR e.status = ANY(p_status))
    ORDER BY e.received_at DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
$$;

COMMENT ON FUNCTION analytics.buscar_emails(text, date, date, text, text[], integer) IS
  'Busca textual nos e-mails recebidos (assunto + corpo), via tsvector/GIN da migration 105. '
  'Devolve um TRECHO destacado, não o corpo inteiro (PII). SECURITY INVOKER: a RLS da 078 recorta '
  'por REMETENTE para o grupo restrito. Tool: buscar_emails.';

-- GRANT explícito + REVOKE explícito — guardrail confirmado na Onda 1: o PostgreSQL concede
-- EXECUTE a PUBLIC por default e o ALTER DEFAULT PRIVILEGES da 098 não persiste neste schema.
GRANT  EXECUTE ON FUNCTION analytics.buscar_emails(text, date, date, text, text[], integer) TO authenticated;
REVOKE EXECUTE ON FUNCTION analytics.buscar_emails(text, date, date, text, text[], integer) FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO (executar após aplicar; esperado em prosa — SQL comentado reprova o SonarCloud)
-- ---------------------------------------------------------------------------
--
--   1. `buscar_emails('boleto')` devolve linhas, e a contagem bate com a query de controle
--      `WHERE body_search @@ plainto_tsquery('portuguese','boleto')`.
--   2. O `trecho` traz o termo entre << >> — prova de que o ts_headline casou o texto certo.
--   3. `authenticated` tem EXECUTE; `anon` NÃO tem.
--   4. Com o papel `authenticated` de um usuário do grupo Comercial, a busca devolve MENOS linhas
--      que para um irrestrito — prova de que o security_invoker propagou a RLS da 078.
--   5. O EXPLAIN usa `ix_email_control_body_search` (GIN), não seq scan.
