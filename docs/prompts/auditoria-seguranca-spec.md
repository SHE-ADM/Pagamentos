# Auditoria de Segurança — pré-produção (pagamentos)

> Prompt-irmão do code review. Foco EXCLUSIVO em segurança. Modelo: **claude-opus-4-8**
> (cross-layer). Branch `Features`, raiz do monorepo. Entrega: relatório `.md` +
> prompts XML de correção. Sessão READ-ONLY no código de produção — escreve só em
> `docs/review/seguranca/`.

```xml
<task>
  Faça uma auditoria de segurança completa do monorepo `pagamentos`, do banco ao
  frontend, com o olhar de quem vai colocar o sistema para enviar e-mails reais e
  manipular contas a pagar em produção. Modelo de ameaça: (a) usuário autenticado
  mal-intencionado tentando escalar privilégio ou ler/escrever o que não deve;
  (b) atacante externo (sem login) na superfície pública; (c) conteúdo HOSTIL entrando
  pelo pipeline (e-mail/PDF/link de remetente desconhecido). NÃO é pentest de
  infraestrutura — é revisão de código e de configuração do banco.

  Trabalhe em DUAS FASES: diagnóstico (Fase 1) e prompts de correção (Fase 2).
</task>

<hard_rules>
  - NÃO altere código de produção. Escrita só em `docs/review/seguranca/`.
  - Leia o arquivo REAL antes de afirmar. Toda afirmação cita `arquivo:linha`.
  - NUNCA escreva segredo real no relatório. Ao citar `.env`, use o NOME da variável
    (`SUPABASE_SERVICE_KEY`), nunca o valor. Se encontrar segredo commitado, reporte o
    arquivo:linha e a AÇÃO (rotacionar + remover do histórico) — sem transcrever o valor.
  - Severidade por CVSS-like: CRÍTICO | ALTO | MÉDIO | BAIXO | INFO. CRÍTICO/ALTO
    bloqueiam produção. Justifique com o impacto concreto (o que o atacante consegue).
  - Para cada achado, dê: vetor, pré-condição, impacto, e correção mínima.
  - CLAUDE.md é a fonte de verdade do desenho pretendido. Confirme que o desenho de
    segurança documentado está REALMENTE implementado — divergência entre o documentado
    e o código é, por si só, um achado.
</hard_rules>

<read_first>
  - CLAUDE.md  (seções Autenticação, RLS, "Duas chaves Supabase", limpeza, cobrança)
  - supabase/migrations/*.sql   (001→054 — RLS, policies, GRANTs, triggers, SECURITY DEFINER)
  - apps/api-backend/middleware.ts
  - apps/api-backend/lib/auth.ts
  - apps/api-backend/lib/supabase-admin.ts
  - apps/api-backend/lib/response.ts
  - apps/api-backend/lib/users.ts
  - apps/api-backend/lib/python-bridge.ts
  - apps/api-backend/lib/{suppliers,contas,cost-centers,banks,financial-accounts,chart-accounts,chart-account-groups,chart-account-subgroups,lookups}.ts
  - apps/api-backend/app/api/**/route.ts
  - apps/frontend-vite/src/lib/{supabaseClient,authStorage,featureFlags}.ts
  - apps/frontend-vite/src/contexts/AuthContext.tsx
  - apps/frontend-vite/src/services/{supabase,dataApi,emailReader,cobrancaService}.ts
  - apps/frontend-vite/vite.config.ts        (proxy /api, /data-api — alvo, CORS)
  - server/app.py                            (rotas Flask, CORS, validação de input, threads)
  - skills/email-reader/scripts/read_emails.py   (_is_suspicious_link, _is_internal_email, download de URL)
  - skills/pdf-contas-pagar/scripts/extract_pdf.py
  - skills/cobranca-vencidos/scripts/{run,send_core,email_sender,supabase_log,db_firebird}.py
  - server/requirements.txt, package.json (deps com CVE conhecido)
</read_first>

<phase_1_auditoria>
  Produza `docs/review/seguranca/RELATORIO-SEGURANCA.md` com estas seções:

  ## 1. AuthN/AuthZ (Supabase Auth)
  - Middleware: o matcher `/api/((?!health|auth/login).*)` realmente deixa público SÓ
    `/api/health` e `/api/auth/login`? Há rota sensível caindo fora do guard? Bypass por
    encoding/case/trailing-slash/método?
  - `requireAuth`/`getAuthenticatedUser`: o token é validado com a chave ANON (nunca
    service_role); 401 em ausente/inválido; sem confiar em claim não verificada.
  - Sem auto-registro: `auth.admin.createUser` é inalcançável sem already-admin? `signUp`
    nunca é chamado no frontend? Quem pode chamar `POST /api/users` — há checagem de papel
    de admin de verdade, ou "admin-only" depende só do guard genérico?
  - Sessão no frontend: storage híbrido "Lembrar-me", logout por inatividade (teto 10 min),
    e o early-out de `isIdleExpired` na reabertura — alguma janela que mantém sessão além
    do previsto? Token em localStorage exposto a XSS (ver seção 5)?

  ## 2. RLS e privilégio no banco
  - Para CADA tabela: RLS habilitado? Toda tabela com RLS tem ALGUMA policy (sem
    default-deny silencioso nem, pior, sem RLS)? Leitura `TO authenticated`, escrita
    `TO service_role`?
  - GRANTs por COLUNA: `email_control.reviewed_at` (mig 030) e
    `financial_account_control.has_invoice/has_bank_slip` (mig 033) — o usuário
    autenticado consegue, na prática, escrever ALÉM dessas colunas? Teste a hipótese de
    um PATCH REST direto do frontend em outra coluna.
  - Funções `SECURITY DEFINER` (normalize_search, resolve_supplier_*): rodam com search_path
    fixado? Recebem input não sanitizado que poderia virar injeção dentro da função?
  - Sentinela id 0 e FKs: dá pra um usuário apagar/alterar cadastro protegido via REST
    direto (contornando o "DELETE removido só da UI")? A proteção é no BANCO ou só na UI?

  ## 3. Superfície da Next API (por recurso)
  - service_role só é instanciado server-side (`supabase-admin.ts`) e NUNCA chega ao
    bundle do cliente? Nenhum import de `supabase-admin` em código que vaza pro frontend?
  - IDOR: `GET/PATCH /:sk|:id` confiam só no id da URL — algum recurso deveria escopar por
    empresa/usuário e não escopa? (mapear o que HOJE é multi-tenant-cego e se isso é risco.)
  - Mass assignment: campos derivados (status_id, sk_supplier, *_id IDENTITY, created/updated_at,
    supplier_id) são REJEITADOS no corpo? O Zod faz strip ou passa adiante?
  - `python-bridge.ts`: o que a Next manda pro Flask é validado? Dá pra forjar um disparo?

  ## 4. Pipeline Python como superfície hostil
  - SSRF no download de boleto por link: `_is_suspicious_link` cobre redirecionadores
    (bing/ck, SafeLinks, Proofpoint)? E IP literal / `localhost` / `169.254.169.254`
    (metadata) / esquema não-http / porta interna? O opener/cookiejar compartilhado vaza
    cookie pra domínio terceiro no redirect?
  - Injeção no e-mail de cobrança: nome/assunto/valor vindos do Firebird entram no HTML
    (`template.py`) escapados? Header injection (CRLF em To/Cc/Subject) no `email_sender`?
  - Path traversal ao salvar PDF (nome de arquivo derivado do e-mail) em `data/pdfs_inbox/`.
  - Confiança no conteúdo extraído: o CHECK do banco é a última barreira — algum payload do
    PDF/corpo chega ao SQL sem passar por validação?
  - Flask: CORS aberto demais? Endpoint de leitura/reenvio sem auth na frente (só vale na
    LAN?) — documentar o pressuposto de rede e se ele se sustenta em produção.

  ## 5. Frontend / XSS / config
  - Qualquer `dangerouslySetInnerHTML` ou render de HTML não sanitizado (corpo de e-mail,
    `email_body_excerpt`, AttachmentViewer)?
  - Variáveis `VITE_*` no bundle: só contêm o que pode ser público (anon key, URL)? Nenhuma
    `SERVICE_KEY`/segredo vazando via `import.meta.env`?
  - Proxy do Vite (`/api`→Flask, `/data-api`→Next): alvo fixo, sem open-proxy?
  - featureFlags: o disparo IMAP oculto em produção é defesa de UI — o ENDPOINT continua
    acessível? (defesa em profundidade vs. só esconder o botão.)

  ## 6. Segredos e dependências
  - `.env`/segredo no histórico do git ou em arquivo versionado? (reporte sem transcrever.)
  - `.gitignore` cobre `.env`, `data/`, `logs/`?
  - Deps com CVE conhecido (npm + requirements.txt) — listar pacote@versão e severidade.

  ## 7. Veredito + matriz de risco
  Tabela achado × severidade × esforço; veredito PASSA/NÃO PASSA para produção; top 5
  riscos a fechar antes do go-live.

  ## 8. Não-achados (confirmações positivas)
  O que foi verificado e está CORRETO (para dar confiança e evitar re-trabalho).
</phase_1_auditoria>

<phase_2_prompts_de_correcao>
  Gere, em `docs/review/seguranca/prompts/`, só os prompts cujas áreas tiveram achado:
  - `S1-authz-middleware.md`
  - `S2-rls-banco.md`        (se exigir migration, numerar a partir de 055)
  - `S3-api-idor-massassign.md`
  - `S4-python-ssrf-injection.md`
  - `S5-frontend-xss-config.md`
  - `S6-segredos-deps.md`
  Cada um com: <objetivo>, <read_first>, <achados> (arquivo:linha + severidade + vetor),
  <correcao> (passo a passo, correção MÍNIMA e segura), <restricoes> (não quebrar o
  pressuposto de rede da LAN, não alterar decisões documentadas), <validacao> (comandos
  abaixo + teste manual do vetor) e <criterio_de_aceite>.
</phase_2_prompts_de_correcao>

<comandos_de_validacao>
  - npm run lint && npm run typecheck && npm test
  - npm run prune
  - py -3 -m pytest tests/ -q
  - py -3 -m vulture server/ skills/ scripts/ --min-confidence 60
  - npm audit --omit=dev            (CVEs npm; registrar saída)
  - py -3 -m pip list --outdated    (deps Python desatualizadas)
  Teste de vetor (quando aplicável, descrever — NÃO executar contra produção):
  curl de PATCH REST direto numa coluna não concedida para provar/refutar a RLS por coluna.
</comandos_de_validacao>

<entregaveis>
  1. docs/review/seguranca/RELATORIO-SEGURANCA.md
  2. docs/review/seguranca/prompts/SX-*.md (só os necessários)
  Resumo final no chat: contagem por severidade, veredito, e os 5 itens que MAIS importam
  fechar antes de produção.
</entregaveis>
```
