# S1 — AuthZ / middleware (criação de usuário + defesa em profundidade)

> Base: `docs/review/seguranca/RELATORIO-SEGURANCA.md` §1. Branch `Features`, raiz do monorepo.

```xml
<objetivo>
  Fechar o escalonamento de privilégio na criação de usuários (A-1) e alinhar a defesa em
  profundidade das rotas de ação, sem quebrar o login público nem o fluxo de auth documentado.
</objetivo>

<read_first>
  - CLAUDE.md (Autenticação; "Usuários / autenticação"); .claude/rules/auth-specs.md (SEM AUTO-REGISTRO)
  - apps/api-backend/middleware.ts
  - apps/api-backend/lib/auth.ts (requireAuth/getAuthenticatedUser)
  - apps/api-backend/lib/users.ts (register/createAuthUser)
  - apps/api-backend/app/api/users/route.ts, app/api/users/me/route.ts, app/api/auth/login/route.ts
  - apps/api-backend/app/api/emails/read/route.ts
</read_first>

<achados>
  - ALTO  A-1: POST /api/users sem checagem REAL de admin — qualquer sessão cria contas via auth.admin.createUser (service_role). Vetor: Bearer válido de usuário comum. app/api/users/route.ts:9-24 + lib/users.ts:79-91. Agravado pela exposição pública (vercel.json /data-api).
  - MÉDIO M-1: toda sessão = poder total no CRUD; segregação de papéis ausente e NÃO documentada. lib/auth.ts:37-65, middleware.ts:11-20.
  - BAIXO B-1: POST /api/emails/read sem requireAuth no handler (só middleware). app/api/emails/read/route.ts.
</achados>

<correcao>
  1. A-1 — adicionar checagem de papel admin em POST /api/users:
     - Em lib/auth.ts, criar `requireAdmin(req)` que reusa getAuthenticatedUser e verifica um claim de papel
       (`user.app_metadata?.role === 'admin'` OU `user.user_metadata?.is_admin === true` — escolher o que o
       admin grava no Supabase Dashboard ao criar o usuário; documentar a escolha). Retorna 403 (envelope fail) se não-admin.
     - Em app/api/users/route.ts (POST), chamar requireAdmin ANTES de userService.register. Manter 201/409/422.
     - NÃO mudar POST /api/auth/login (público) nem GET /api/users/me.
  2. M-1 — decisão explícita: como esta é ferramenta single-org, documentar em CLAUDE.md ("Auth das rotas Next")
     que toda sessão autenticada é confiável para o CRUD, MAS a criação de usuário é admin-only (item 1). Se o
     cliente quiser papéis no CRUD, abrir tarefa separada — não é escopo desta correção mínima.
  3. B-1 — adicionar `const denied = await requireAuth(req); if (denied) return denied;` no início do POST de
     app/api/emails/read/route.ts (consistência com as outras rotas).
  4. Testes: app/api/users/route.test.ts — caso 403 (sessão não-admin) e 201 (admin). Mockar getAuthenticatedUser
     retornando user com/sem o claim. Atualizar o teste existente que assumia "admin-only = só estar logado".
</correcao>

<restricoes>
  - NÃO chamar supabase.auth.signUp no frontend (regra SEM AUTO-REGISTRO). NÃO expor service_role.
  - NÃO quebrar o matcher /api/((?!health|auth/login).*) — health e login seguem públicos.
  - Token sempre validado com a chave ANON (lib/auth.ts), nunca service_role.
</restricoes>

<validacao>
  - npm run lint && npm run typecheck && npm test
  - npm run prune
  - Vetor (descrever no PR, NÃO executar contra prod): curl -X POST .../api/users com Bearer de usuário comum → 403; com admin → 201.
</validacao>

<criterio_de_aceite>
  - POST /api/users retorna 403 para sessão não-admin e 201 só para admin (teste cobre ambos).
  - /api/emails/read exige requireAuth no handler.
  - Gate verde; decisão de papéis documentada no CLAUDE.md.
</criterio_de_aceite>
```
