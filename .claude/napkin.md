# Napkin — pagamentos

Runbook curado de gotchas recorrentes. Leia antes de trabalhar; mantenha enxuto.

## Monorepo / dev

1. **`npm install` é na RAIZ** — npm workspaces, lockfile único. Nunca instalar dentro
   de um app (gera lockfile órfão; o `.gitignore` ignora `apps/*/package-lock.json`).
2. **Ordem de startup do fluxo de e-mail:** Flask (`python server\app.py`, :8000) ANTES
   de tudo. Frontend interno: `npm run dev:vite` (:5173) chama o Flask direto via proxy
   `/api`. Next API `npm run dev:api` (:3000) e portal `npm run dev:portal` (:3002) são
   opcionais para o fluxo atual.
3. **Matar processos Vite/Node órfãos no Windows** antes de mover/renomear pastas — um
   `esbuild.exe`/`vite.js` remanescente trava `git mv`/`Move-Item` com "Permission
   denied". `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` mostra a cmdline;
   `Stop-Process -Id <pid> -Force`.

## Backend híbrido

4. **Pipeline Python é a fonte única de leitura** — `run_reader()` em
   `skills/email-reader/scripts/read_emails.py`. Flask e CLI chamam ela; nunca duplicar.
   `read_emails.py` carrega o `.env` da raiz via `parents[3]` — **não mover `skills/`**.
5. **Ponte, não subprocess** — a Next API aciona o Python via HTTP
   (`apps/api-backend/lib/python-bridge.ts` → Flask), evitando descoberta de
   interpretador no Windows. `PYTHON_SERVICE_URL` no `.env.local` da api-backend.

## Dois envelopes REST (não misturar)

6. Flask → `{ "ok": bool, ... }` (legado). Next API → `{ success, data?, error?, meta? }`
   (`apps/api-backend/lib/response.ts`). Rotas novas de CRUD vão na Next API.

## TypeScript / testes

7. **Duas versões do React no monorepo:** React 18 (frontend-vite, hoisted na raiz) vs
   React 19 (apps Next, aninhado). Testes de componente nos apps Next quebram com
   "Objects are not valid as a React child" (mistura de cópias). `dedupe`/`alias` no
   Vitest não resolveram de forma confiável. **Follow-up:** alinhar versões de React ou
   setup de teste dedicado antes de testar componentes do portal/Next.
8. **`getErrorMessage(e)`** (`frontend-vite/src/lib/getErrorMessage.ts`) para `catch`
   em strict mode (o valor é `unknown`).
9. **Tipos compartilhados** vêm de `@sheild/shared` (schemas Zod). Resolução: Vite usa
   `vite-tsconfig-paths`; apps Next usam `transpilePackages: ['@sheild/shared']`.

## Next 16 (apps Next)

10. Turbopack por padrão; `params`/`cookies`/`headers` são async. Definir
    `turbopack.root` = raiz do monorepo no `next.config.ts` silencia o aviso de
    múltiplos lockfiles. Docs empacotados em `node_modules/next/dist/docs/`.
