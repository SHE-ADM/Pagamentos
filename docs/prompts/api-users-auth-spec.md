# Template de prompt — Módulo Auth / Usuários (apps/api-backend)

> Template de spec alinhado à arquitetura real do projeto Pagamentos (Supabase Auth, sem
> Docker/ORM/JWT customizado, sem auto-registro). Use como ponto de partida ao pedir a
> implementação do módulo de usuários/autenticação. Ver também
> `docs/prompts/api-supplier-crud-spec.md` (template de entidade CRUD).

```xml
<context>
  Monorepo: C:\Sheild\Projetos\Claude\Contas a pagar\Pagamentos
  Target app: apps/api-backend (Next.js 16, porta 3000, TypeScript 6)
  Pattern: Route Handlers (app/api/**) + lib/ helpers (Repository → Service → Route)
  Envelope: { success, data?, error?, meta? } via lib/response.ts (ok/fail)
  Banco + Auth: Supabase (PostgreSQL gerenciado). service_role em lib/supabase-admin.ts;
                anon em lib/auth.ts. NÃO usar ORM, Postgres avulso, Docker ou JWT customizado.
  Auth existente: lib/auth.ts (requireAuth valida o access_token via Supabase auth.getUser
                  com a chave anon) + middleware.ts (protege /api/* exceto /api/health)
  Schemas Zod 4: packages/shared/src/schemas/** (já existe loginSchema em auth.schema.ts)
  Testes: Vitest (environment node, mock de @supabase/supabase-js — ver lib/auth.test.ts)
  REGRAS MANDATÓRIAS (CLAUDE.md do projeto):
    - Auth SEMPRE via Supabase Auth — NUNCA JWT customizado, bcrypt ou hashing próprio
    - SEM AUTO-REGISTRO — usuários criados só por admin; supabase.auth.signUp nunca é chamado
    - REST: substantivo plural, status codes, Bearer token stateless, envelope ok/fail
</context>

<read_first>
  Ler ANTES de gerar código:
  - apps/api-backend/lib/response.ts            — envelope ok()/fail()
  - apps/api-backend/lib/auth.ts                — requireAuth() + getBearerToken() + getAnonClient (privado)
  - apps/api-backend/lib/supabase-admin.ts      — getSupabaseAdmin() (service_role)
  - apps/api-backend/middleware.ts              — matcher que protege /api/*
  - apps/api-backend/app/api/emails/read/route.ts e route.test.ts — padrão de rota + teste
  - apps/api-backend/lib/auth.test.ts           — padrão de mock do @supabase/supabase-js
  - packages/shared/src/schemas/auth.schema.ts  — loginSchema (reusar)
</read_first>

<task>
  Implementar o módulo de usuários em apps/api-backend SOBRE o Supabase Auth já configurado,
  reusando os helpers existentes (getSupabaseAdmin, requireAuth/getBearerToken, ok/fail).
  NÃO introduzir Docker, ORM, bcrypt nem jsonwebtoken.
</task>

<endpoints>
  POST /api/users       — cadastro ADMIN-ONLY (já protegido pelo middleware; via auth.admin.createUser)
                          → 201 + { success, data: { id, name, email } }
  POST /api/auth/login  — autenticação PÚBLICA via signInWithPassword
                          → 200 + { success, data: { access_token, expires_in } }
  GET  /api/users/me    — perfil do usuário autenticado → 200 + { success, data: { id, name, email, created_at } }
</endpoints>

<auth_implementation>
  - Cadastro: getSupabaseAdmin().auth.admin.createUser({ email, password, email_confirm: true,
    user_metadata: { name } }). NUNCA hashing manual. E-mail já existente → 409.
  - Login: getAnonClient().auth.signInWithPassword(...) → access_token + expires_in da session
    (a expiração é configurada no painel Supabase, não em env). Credencial inválida → 401.
  - /me: expor getAuthenticatedUser(req) em lib/auth.ts (reusa getBearerToken + auth.getUser)
    para obter o User — NÃO reimplementar requireAuth.
  - 1º usuário (bootstrap): criado no Supabase Dashboard (fluxo admin do auth-specs.md).
  - "Admin-only" = qualquer usuário autenticado (sem modelo de papéis). Opcional: exigir
    app_metadata.role === 'admin' em POST /api/users.
  - NUNCA retornar password_hash (o Supabase sequer o expõe).
</auth_implementation>

<structure>
  app/api/users/route.ts        — POST (cadastro admin-only)
  app/api/users/me/route.ts     — GET (perfil)
  app/api/auth/login/route.ts   — POST (login público)
  lib/users.ts                  — UserRepository (sobre auth.admin) + UserService + JSDoc
                                  + UserServiceError (mapeada por instanceof na rota, padrão de PythonBridgeError)
  lib/users.test.ts             — Vitest
  middleware.ts                 — liberar /api/auth/login no matcher: ['/api/((?!health|auth/login).*)']
  packages/shared/src/schemas/auth.schema.ts — adicionar createUserSchema (name/email/password)
</structure>

<test_cases>
  lib/users.test.ts (mock de @supabase/supabase-js):
  - register: sucesso → { id, name, email } SEM password_hash
  - register: e-mail duplicado → 409
  - login: credencial inválida → 401
  - /me: token expirado/inválido (getUser devolve error) → 401
  Testes co-locados de rota (convenção do projeto): users/route.test.ts, users/me/route.test.ts,
  auth/login/route.test.ts — smoke de status/envelope mockando o UserService.
</test_cases>

<constraints>
  - Envelope via ok()/fail(); estender ok() com status opcional para 201
  - Status: 201 criação · 401 não autenticado/credencial inválida · 409 duplicado · 422 Zod
  - Validação Zod 4 em packages/shared (z.email(), não z.string().email())
  - Sem shadcn/NestJS/Express/ORM/JWT customizado — só Next Route Handlers + @supabase/supabase-js
  - Vitest (não Jest); branch Features (não main)
  - npm run lint/typecheck/prune com 0 erros; exports órfãos → // ts-prune-ignore-next
  - Sem migration nova, sem .env nova (SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY já existem)
</constraints>

<documentation>
  - JSDoc nos métodos públicos de lib/users.ts
  - Atualizar CLAUDE.md (seção REST/arquitetura) com as 3 rotas + reforço SEM AUTO-REGISTRO
  - Não gerar Swagger/OpenAPI
</documentation>

<validation_commands>
  cd "C:\Sheild\Projetos\Claude\Contas a pagar\Pagamentos"
  npm run typecheck --workspace=apps/api-backend
  npm run lint --workspace=apps/api-backend
  npm run test --workspace=apps/api-backend
  npm run prune --workspace=apps/api-backend
</validation_commands>
```

## Por que este template diverge do template genérico

| Removido/alterado | Motivo |
|---|---|
| Docker `postgres:16-alpine`, ORM (Drizzle/Prisma), `bcrypt`, `jsonwebtoken`, `DATABASE_URL`, `JWT_EXPIRES_IN` | DB e Auth são o Supabase; JWT custom **falha** o `requireAuth` (valida JWT do Supabase). Viola "never custom JWT/hashing". |
| `POST /api/users` aberto (autocadastro) | Regra mandatória "SEM AUTO-REGISTRO" → admin-only via `auth.admin.createUser`. |
| `users.service.spec.ts` / array em memória | Terminologia de template NestJS — não existe neste projeto. |
| (adicionado) ajuste do `middleware.ts` | O matcher protege todo `/api/*`; o login precisa ser exceção pública. |
