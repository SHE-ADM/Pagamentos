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

## Banco / implantação

7. **Migration que cria coluna lida pelo TS: aplicar e conferir o CACHE DE SCHEMA do
   PostgREST ANTES de subir a API.** Leitura fail-closed (ex.: `lib/ai-chat/gate.ts`)
   trata "coluna não existe" como negação, então a ordem invertida derruba a feature
   para todos — inclusive para quem iria corrigir. Conferir pelo REST, não só por SQL.
   ❌ Nunca "resolver" transformando erro de coluna ausente em passe livre.

## TypeScript / testes

8. **React é UNIFICADO em 19 no monorepo** — medido em 2026-08-12: `19.2.7` em 23 nós do
   grafo e **uma só cópia física** em `node_modules/react`. O item antigo aqui descrevia
   um conflito 18×19 que a Fase 2 do upgrade resolveu, e prescrevia um follow-up já
   feito. Os `resolve.dedupe` nos Vitest/Vite configs ficam como defesa, não como
   contorno. Testar `react@` por substring engana (`lucide-react@1.21.0`,
   `@testing-library/react@16.3.2` casam) — medir por cópia em disco. Guarda:
   `tests/test_react_versao_unica.py`.
9. **`getErrorMessage(e)`** (`frontend-vite/src/lib/getErrorMessage.ts`) para `catch`
   em strict mode (o valor é `unknown`).
10. **Tipos compartilhados** vêm de `@sheild/shared` (schemas Zod). Resolução: Vite usa
   `vite-tsconfig-paths`; apps Next usam `transpilePackages: ['@sheild/shared']`.

## Next 16 (apps Next)

11. Turbopack por padrão; `params`/`cookies`/`headers` são async. Definir
    `turbopack.root` = raiz do monorepo no `next.config.ts` silencia o aviso de
    múltiplos lockfiles. Docs empacotados em `node_modules/next/dist/docs/`.
