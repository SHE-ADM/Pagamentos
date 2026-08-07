# Testes de acessibilidade em navegador (Playwright + axe)

Camada complementar à suíte jsdom (`*.a11y.test.tsx` + `tests/contrast*.a11y.test.ts`).
Roda o **axe-core no Chromium real**, então avalia o que o jsdom **não** consegue:
contraste de cor sob render real (WCAG 1.4.3 / 1.4.11), ordem de foco e autofill.

## Pré-requisitos (uma vez)

```powershell
npx playwright install chromium   # baixa o navegador (não vai para o git)
```

## Rodar

```powershell
npm run test:e2e            # headless — sobe o Vite dev (5173) automaticamente
npm run test:e2e:headed    # com janela do navegador
npm run test:e2e -- public-auth   # só as páginas públicas (login/forgot/reset)
```

O `playwright.config.ts` sobe o `npm run dev` sozinho (`webServer`) e o derruba ao fim.

## Rotas protegidas (/consulta, /emails, /erros)

Exigem sessão. Sem auto-cadastro: o admin cria um **usuário de teste** no Supabase
(`Authentication → Users → Add user`, "Auto Confirm User") e exporta as credenciais:

```powershell
$env:A11Y_TEST_EMAIL='teste-a11y@sheild.app.br'
$env:A11Y_TEST_PASSWORD='...'
npm run test:e2e
```

> 🔴 **O usuário PRECISA de `app_metadata.password_changed = true`** — criá-lo pelo Dashboard
> **não** define essa marca, e sem ela o `ProtectedRoute` manda o 1º login para
> `/auth/change-password`: os specs protegidos nunca chegam a `/consulta` e falham por um
> motivo que não tem nada a ver com acessibilidade. Criar pela Admin API já com a marca:
>
> ```
> POST {SUPABASE_URL}/auth/v1/admin/users     (Authorization: Bearer <service_role>)
> { "email": "...", "password": "...", "email_confirm": true,
>   "app_metadata": { "password_changed": true } }
> ```
>
> `app_metadata`, nunca `user_metadata` — a segunda é gravável pelo próprio cliente e não
> serve como marca de confiança (achado S1-1). **Verifique o login antes de cadastrar o
> secret**, com o mesmo grant que o app usa (`POST /auth/v1/token?grant_type=password`, com a
> anon key): criar o usuário não prova que ele loga.

Sem essas variáveis, o bloco de rotas protegidas é **pulado** (não falha a suíte).

## Escopo / limitação

- `public-auth.a11y.e2e.ts` — login (paleta `loginGreen`), esqueci a senha e
  redefinir senha (paleta `auth gradient`). Sem login.
- `protected.a11y.e2e.ts` — `/consulta`, `/emails`, `/erros` após login real.
- Os specs **não** rodam no `npm test` (Vitest) — são um runner separado, fora do
  `tsconfig`/ESLint do app (ignorados de propósito; ver `eslint.config.mjs`).
- Ambiente headless muito restrito (alguns CIs/containers) pode derrubar o renderer
  do Chromium ao carregar a SPA completa ("Page crashed"). Rodar em desktop ou em um
  runner de CI com recursos normais resolve.
