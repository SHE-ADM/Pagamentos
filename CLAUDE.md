# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é este projeto

`pagamentos` é um **pipeline financeiro de contas a pagar**, não um app CRUD comum.
O fluxo central (entrada) é: e-mail (IMAP) → download de PDF → extração via Claude API →
gravação no Supabase → consulta/exportação pela interface web.

Há também um **segundo pipeline (saída): cobrança de títulos vencidos** — lê o Firebird e
**envia e-mails de cobrança por SMTP (Locaweb)**, com logs próprios. Ver "Pipeline de cobrança
de vencidos (skill `cobranca-vencidos`)".

> **Arquitetura: monorepo Sheild com backend híbrido.** Desde a reestruturação de
> 2026-06-09, o projeto adota o monorepo `apps/* + packages/shared` (npm workspaces),
> mas o backend é **híbrido** — pontos onde ainda diverge do padrão genérico:
> - **Pipeline Python permanece** (`server/` Flask + `skills/`): IMAP, extração de PDF
>   (Claude Vision via base64 + pdfplumber). Não há equivalente TS viável; é o coração
>   do sistema e não foi reescrito.
> - **`apps/api-backend`** (Next.js 16 + TypeScript, porta 3000) é a camada nova de
>   dados/CRUD. Aciona o pipeline Python via **ponte HTTP** (`lib/python-bridge.ts` →
>   Flask), não por subprocess.
> - **`apps/frontend-vite`** (React 19 + Vite 8, porta 5173) é o app interno, agora
>   **100% TypeScript** (`.tsx/.ts`), **sem shadcn/ui**. Continua lendo o Supabase via
>   **REST direto com `fetch`** (`src/services/supabase.ts`); só a sessão de auth usa o
>   SDK oficial (`src/lib/supabaseClient.ts`).
> - **`apps/portal-next`** (Next.js 16 + Tailwind v4, porta 3002) é o portal público
>   (scaffold).
> - **`packages/shared`** (`@sheild/shared`) — schemas Zod, fonte de verdade de tipos
>   entre frontends e API.
>
> **Stack atualizado (upgrade do stack — 5 fases + React Compiler transform, 2026-06-18):** Vite **8** (Rolldown) · Vitest **4** ·
> React **19** (unificado em todo o monorepo) · TypeScript **6** · ESLint **10** no
> frontend-vite (apps Next em ESLint **9** — carve-out, ver `eslint10-next-carveout` na
> memória) · **React Compiler** ativo — regras (`eslint-plugin-react-hooks@7`) **e transform
> de build** (`@rolldown/plugin-babel` + `reactCompilerPreset`) · Tailwind
> **v4 CSS-first** (`@theme`/`@utility` em `src/index.css`; **não há mais `tailwind.config.ts`**) ·
> Zod **4** (+ `@hookform/resolvers@5`, `react-hook-form@7.79`) · `tailwind-merge@3` ·
> `lucide-react@1`.
>
> Não aplique os templates Sheild Canvas nem shadcn aqui. O **fluxo de autenticação em
> 3 etapas** e a **regra de não-autorregistro** (`auth-specs.md`) foram seguidos,
> adaptados para `.tsx` com Tailwind. Mantenha o estilo existente do restante do projeto.
>
> **Desvio justificado:** migrations ficam em `supabase/migrations/` (não
> `server/db/migrations/`) — preserva a convenção numérica 001+ e o fluxo manual de
> aplicação no SQL Editor.

---

## Regras mandatórias

Estas regras se aplicam a **todo** código novo ou alterado neste projeto, sem exceção.

### 1 — Atomic Design + Tailwind (frontend)

- Todo componente de UI pertence a uma camada: `atoms/`, `molecules/` ou `organisms/`.
  - **Atom**: elemento sem filhos de domínio (input, botão, badge, texto expansível).
  - **Molecule**: composição de atoms (fileira de logos, mensagem inline, header de auth).
  - **Organism**: componente com estado e lógica de negócio (formulário completo, tabela paginada).
- Estilo **exclusivamente via classes Tailwind** — `style={{}}` inline é proibido quando
  existir token ou classe equivalente no Tailwind.
- **Tokens de cor**: usar `loginGreen-*` nas telas de auth e `status-*`
  (feedback, badges e banners — ver guia abaixo) no restante do app. Nunca use hex
  hardcoded **nem cores default do Tailwind** (`red-*`, `amber-*`, `emerald-*`, `blue-*`,
  `teal-*`…) para estados semânticos — o token semântico é a fonte de verdade única
  (paleta no bloco `@theme` de `src/index.css` — Tailwind v4 CSS-first).
- **Tokens de tamanho**: usar os tokens Tailwind mais próximos em vez de valores
  arbitrários (ex.: `text-sm` em vez de `text-[15px]`). Valores sem token equivalente
  (ex.: `object-[center_25%]`) são aceitos como exceção justificada.
- **Tailwind JIT**: usar strings estáticas completas em ternários —
  `${focused ? 'bg-loginGreen-fieldFocus' : 'bg-loginGreen-field'}` é correto.
  Nunca concatenar partes de nome de classe (`bg-loginGreen-${variavel}`) — o JIT
  não gera CSS para nomes computados.
- Preferir modificadores `hover:`, `disabled:`, `placeholder:`, `focus:` a handlers JS.
- **CVA para variantes**: componente com variação visual (variante, estado booleano)
  centraliza as classes em `cva()` (`class-variance-authority`) e aplica com o helper
  `cn()` (`src/lib/cn.ts` — `clsx` + `tailwind-merge`): `cn(badgeVariants({ variant }), className)`.
  Cada valor de variante continua sendo uma **string literal completa** (compatível com o
  JIT). Componentes-referência: `StatusBadge` (mapa em `statusBadge.variants.ts`),
  `Alert` (banner de página — error/success/warning/info), `InlineMessage`, `AuthInput`,
  `FilledTextField`, `AccentPillButton`, `GradientPillButton` e `DataGrid` (tema
  `default`/`silver` + estados de linha/cabeçalho em `dataGrid.variants.ts`).
  Mantenha as definições `cva` que não são componentes em arquivo separado (`*.variants.ts`)
  para não disparar `react-refresh/only-export-components`. A exceção aceita é um `cva`
  **local e não exportado** dentro do próprio componente (ex.: `navLink` em `Layout.tsx`),
  que não dispara a regra de Fast Refresh.

### 2 — Todo componente tem teste

- **Todo componente novo ou alterado de forma relevante deve ter ao menos um teste**
  cobrindo renderização e a interação principal (ex.: submit, expand/collapse, validação).
- **Suíte configurada (Vitest):** `apps/frontend-vite` (jsdom + Testing Library) e
  `apps/api-backend` (env node). Rode `npm test` na raiz (roda todos os workspaces) ou
  `npm run test --workspace=apps/<app>`. No `api-backend`, o `vitest.config.ts` resolve o
  alias `@` (espelhando `@/*`→`./*` do tsconfig) e coleta testes em `lib/**` **e** `app/**`
  (`*.test.ts`) — rotas têm teste co-locado (ex.: `app/api/emails/read/route.test.ts`
  cobre 422/200/502 mockando `triggerReader`).
- **Suíte Python (pytest):** `py -3 -m pytest tests/` (ex.: `test_link_extraction.py`,
  `test_email_body_extraction.py`, `test_body_amount.py`, `test_extract_pdf.py`). Cobre o
  pipeline de extração; rodar após mexer em `read_emails.py`/`extract_pdf.py` ou nos
  scripts de reprocessamento. Não é incluída no `npm test`.
- Referência de granularidade: `frontend-vite/src/components/StatusBadge.test.tsx`,
  `ExpandableText.test.tsx`, `organisms/LoginForm.test.tsx`.
- **`apps/portal-next`**: testado via **server rendering** (`react-dom/server`
  `renderToStaticMarkup`) em vez de jsdom + `@testing-library/react` (`app/page.test.tsx`).
  O React agora é **unificado em 19** em todo o monorepo (Fase 2 do upgrade), então o
  antigo conflito "duas versões do React" não existe mais; o `vitest.config.ts` ainda usa
  `resolve.dedupe: ['react','react-dom']` (defensivo). O `frontend-vite` também aplica esse
  dedupe no `vite.config.ts` — há `react@18` só como transitivo eventual, então o dedupe
  garante uma única cópia no bundle/teste. (Follow-up: com o React unificado, o portal pode
  voltar a usar jsdom + Testing Library — ainda não feito.)

### 3 — REST no backend

Duas camadas, dois envelopes — **não misturar**:

| Camada | Onde | Envelope |
|---|---|---|
| Flask (Python) | `server/app.py` | `{"ok": bool, ...}` — legado, manter |
| Next API (TS) | `apps/api-backend/app/api/**/route.ts` | `{ success, data?, error?, meta? }` (`lib/response.ts`) |

Regras comuns a toda rota nova:

| Decisão | Regra |
|---|---|
| URL | Substantivo no plural (`/api/contas`, `/api/contas/:id`) |
| Verbos | `GET` leitura · `POST` criação/ação · `PUT`/`PATCH` atualização · `DELETE` remoção |
| Status codes | `200`/`201` sucesso · `400`/`422` validação · `401`/`403` auth · `404` não encontrado · `5xx` servidor |
| Sessão | Stateless — autenticação via `Authorization: Bearer <token>` no header |

Rotas novas de CRUD/dados vão na **Next API** (envelope `{ success, ... }`, Repository →
Service → Route, conforme `monorepo-crud-spec.md`). A exceção aceita: a leitura de e-mails
(`POST /api/emails/read` síncrono · `POST /api/emails/read/start` assíncrono ·
`GET /api/emails/progress`) usa POST + corpo de parâmetros porque é uma **ação de disparo**,
não um recurso CRUD.

**CRUD de fornecedores (`apps/api-backend/lib/suppliers.ts` + `app/api/suppliers/**`):** primeiro
CRUD completo da Next API (Repository → Service → Route, escrita via `getSupabaseAdmin`).
`GET /api/suppliers` (paginado `page`/`limit`≤100 + `search` por nome/CNPJ/CPF/4 e-mails via
`ilike`, índices trgm da migration 029) · `GET/PATCH/DELETE /api/suppliers/:sk` (por
`sk_supplier`) · `POST /api/suppliers`. Validação Zod em `@sheild/shared`
(`supplierCreateSchema`/`supplierUpdateSchema` — CNPJ/CPF com strip de máscara; ao menos um
identificador, espelhando `chk_supplier_has_identifier`). `DELETE` é **soft delete**
(`deleted_at`, migration 045) e **bloqueia com 409** quando há contas vinculadas
(`financial_account_control.sk_supplier`) — fornecedor é PRESERVADO, nunca hard delete.
`sk_supplier`/`supplier_id` nunca entram no corpo (gerados pelo banco + trigger
`trg_supplier_mirror_id`). Status: `201` criação · `409` UNIQUE (23505) de CNPJ/CPF · `404` ·
`422` Zod · `400` sk inválido. Spec/template em `docs/prompts/api-supplier-crud-spec.md`.

**Auth das rotas Next (`apps/api-backend/middleware.ts` + `lib/auth.ts`):** o middleware
protege `/api/*` (matcher `/api/((?!health).*)` — `/api/health` fica público) exigindo
`Authorization: Bearer <token>`. O token é validado contra o Supabase Auth (`auth.getUser`)
com a **chave anon** (`SUPABASE_ANON_KEY`, nunca a service_role); sem token/ inválido →
`401`, falha de validação → `500` (envelope `fail`). A lógica fica em `lib/auth.ts`
(`requireAuth`/`getBearerToken`, testável). Isso **não** intercepta o caminho atual do
frontend (leitura de e-mails fala com o Flask direto); cobre a API de dados Next p/ a fase
do portal.

### 4 — Conventional Commits (todo o projeto)

**Todos** os commits — frontend, backend, scripts, infra — seguem o formato:

```
tipo(escopo): mensagem em português ou inglês
```

| Tipo | Quando usar |
|---|---|
| `feat` | nova funcionalidade |
| `fix` | correção de bug |
| `test` | adição/correção de testes |
| `docs` | documentação (incluindo CLAUDE.md) |
| `chore` | manutenção, deps, configs |
| `refactor` | refatoração sem mudança de comportamento |

Escopo = área afetada: `login`, `email-reader`, `consulta`, `scheduler`, `migrations`, etc.

### 5 — Lint limpo e análise estática

- **`npm run lint` na raiz deve passar com 0 erros e 0 warnings** em todos os workspaces
  (cobre `frontend-vite`, `api-backend`, `portal-next` **e `packages/shared`** — cada um com
  seu `eslint.config.mjs`). O `packages/shared` usa flat config type-aware **sem React**
  (`@eslint/js` + `typescript-eslint` `recommendedTypeChecked`, `globals.node`, glob `**/*.ts`
  para o próprio `eslint.config.mjs` ficar fora do lint type-aware) — binários resolvidos por
  hoist. O shared **não** tem `prune` (ver nota do ts-prune abaixo).
- **Versões de ESLint divergem por workspace (intencional):** `frontend-vite` usa **ESLint 10**
  (+ `typescript-eslint@8.61`); os apps Next ficam em **ESLint 9** porque o
  `eslint-config-next` depende de um `eslint-plugin-react` que quebra no ESLint 10 (`getFilename`
  removido). Carve-out documentado em `eslint10-next-carveout` (memória) — subir quando o
  upstream suportar ESLint 10.
- **Regras do React Compiler ativas** (`eslint-plugin-react-hooks@7` `recommended`): pureza de
  render, `set-state-in-effect`, etc. Disables justificados (`// eslint-disable-next-line
  react-hooks/...`) onde o effect é a ferramenta correta — `void load()` (fetch-on-change em
  `Consulta`/`Emails`/`Erros`), reconcile de prefs (`useGridPreferences`) e `incompatible-library`
  do `@tanstack/react-table` (`DataGrid`). Padrões corrigidos de verdade: sincronizar prop no
  render (não em effect) e não chamar funções impuras (`Date.now`) no escopo de render.
- **Transform de build do React Compiler HABILITADO** (`vite.config.ts`): memoiza
  componentes/hooks automaticamente. No `@vitejs/plugin-react@6` (oxc/Rolldown) entra via
  `@rolldown/plugin-babel` + `reactCompilerPreset()` (peers: `@rolldown/plugin-babel`,
  `@babel/core`, `babel-plugin-react-compiler@1`, `@types/babel__core`) — **não** pelo antigo
  `babel` option do plugin. Alvo React 19 (runtime embutido `react/compiler-runtime`); o
  compiler faz "bail out" seguro em código incompatível (ex.: `useReactTable` no `DataGrid`).
  Confirma-se no bundle pela presença de `useMemoCache`.
- **`frontend-vite`** usa flat config type-aware (`typescript-eslint` + `react-hooks` +
  `react-refresh`). Ajustes deliberados, **manter**: `no-misused-promises` com
  `checksVoidReturn: { attributes: false }` (handlers async em `onClick`/`onSubmit` são
  idiomáticos); regras `no-unsafe-*` desligadas só em `*.test.tsx` (mocks tipados `any`).
  Promessas fire-and-forget (`load()` em `useEffect`) levam `void` explícito.
- **`tsconfigRootDir`**: todo `eslint.config.mjs` ancora `parserOptions.tsconfigRootDir:
  import.meta.dirname` — não remover, é o que evita o erro "No tsconfigRootDir was set" no
  editor. Nos apps Next, **não** habilitar `projectService: true` (quebra o parsing dos
  `*.config.mjs`); apenas `tsconfigRootDir`.
- **`.vscode/settings.json` (não remover)**: o monorepo só tem flat config **por-app**
  (sem `eslint.config` na raiz). Sem `eslint.workingDirectories: [{ "mode": "auto" }]` a
  extensão ESLint roda com cwd na raiz, não acha config e acusa "couldn't find an
  eslint.config file" / "No tsconfigRootDir was set" nos componentes. O `mode: auto` faz a
  extensão rodar com cwd em cada app.
- **ts-prune (dead code / exports órfãos)**: `npm run prune` na raiz roda nos **3 apps**
  e **deve reportar 0**. `ts-prune` está declarado só em `frontend-vite` (resolvido por
  hoist nos apps Next). Os apps Next ignoram os defaults do framework via
  `--ignore "next.config|...|app.*(page|layout|route)"`. **`packages/shared` deliberadamente
  NÃO tem `prune`**: sendo um pacote de barrel (biblioteca pura cuja API é consumida
  cross-package via `@sheild/shared`), o ts-prune isolado reportaria **toda** export pública
  como órfã (falso positivo). A cobertura de uso real vem do `prune` dos apps consumidores;
  no shared fica só `lint` + `typecheck`. Export público intencional **sem
  consumidor** (scaffolding da camada CRUD ou contrato de tipo consumido por inferência —
  `getSupabaseAdmin`, `ApiResponse`/`ApiResponseMeta`, `ReaderSummary`/`TriggerReaderOptions`)
  leva `// ts-prune-ignore-next` na linha acima, documentando a intenção. Não deixar export
  morto de verdade: removê-lo (foi assim que saíram o hook `useGridColumns` e os
  `scripts/_check_*.py`).
- **Python — `vulture`** (`py -3 -m vulture server/ skills/ scripts/ --min-confidence 60`):
  caça funções/variáveis mortas. Rotas Flask decoradas (`@app.get`/`@app.post`) aparecem
  como "unused function" — **falsos positivos**, ignorar.
- **SonarLint** (engine da IDE, sem CLI): manter o código livre dos achados recorrentes —
  condições positivas em vez de negadas com `else` (S7735: `v == null ? '—' : …`), par
  `[x, setX]` no `useState` (S6754), sem ternário/template literal aninhado no JSX (S3358/
  S4624 — extrair para uma const antes do `return`), sem import não usado (S1128), sem
  seletor booleano que escolhe a ação dentro do método (S2301 — preferir uma única ação
  com valor por ternário, ex.: `setItem(key, on ? '1' : '0')` em vez de `if/else` com
  `setItem`/`removeItem`), e sem texto solto logo após um elemento inline em JSX (S6772 —
  envolver o texto em `<span>`, ex.: `<input … /><span>Lembrar-me</span>`).
  Também recorrentes: props de componente React como `Readonly<…>` (S6759 —
  `{ children }: Readonly<{ children: ReactNode }>`); função com complexidade cognitiva
  >15 (S3776 — extrair helpers, ex.: o laço de `reprocess_link_emails.py` virou
  `_process_row`/`_first_pdf`/`_store_pdf`); `logging.exception()` em vez de `logging.error()`
  dentro de `except` (S8572); e f-string sem campo de substituição (S3457 — usar string
  normal).

### 6 — Acessibilidade (WCAG 2.1 AA)

Alvo: **WCAG 2.1 Nível AA** em todas as telas. Regras práticas:

- **Todo controle de formulário tem nome acessível + `id`/`name`.** Inputs/selects de filtro
  recebem `aria-label` (nome para leitores de tela e para o axe) **e** `id`/`name` (resolve
  o alerta de autofill do Chrome). Campos com label visível usam `<label htmlFor>` ligado a
  um `id` — ver `FilledTextField`/`AuthInput`, que geram `id` via `useId` e associam o erro
  por `aria-invalid` + `aria-describedby`. Botão só-ícone leva `aria-label` (ex.: olho de
  senha).
- **Contraste**: pares texto/fundo cumprem AA — texto normal ≥4.5:1, texto grande/ícone de
  UI ≥3:1. Ao criar ou alterar um token de cor, **validar o ratio** (controles desabilitados
  são isentos pela 1.4.3). Em **superfícies escuras** (sidebar `bg-sidebar`) o texto deve ser
  **claro**: `slate-300/400`, não `slate-500/600` (estes invertem e reprovam). `text-white`
  sobre `bg-brand` sólido reprova (3,4:1) — usar `bg-brand-dark` quando houver texto branco.
- **Testes a11y automatizados (jest-axe, AA)**: matcher em `tests/setup.ts`
  (`expect.extend(toHaveNoViolations)`); runner configurado em `tests/axe.ts` (tags
  `wcag2a/2aa/21a/21aa`). Todo componente/página relevante ganha um `*.a11y.test.tsx` com
  `expect(await axe(container)).toHaveNoViolations()`. Páginas com serviços mockam os
  serviços (ver `pages/Consulta.a11y.test.tsx`, `pages/Emails.a11y.test.tsx`).
- **Contraste é travado por teste** em **dois guardas** que compensam o axe em **jsdom** não
  avaliar `color-contrast` (regra desligada em `tests/axe.ts`):
  - `tests/contrast.a11y.test.ts` — pares dos **tokens do projeto** (`loginGreen-*`, `status-*`),
    lendo os `--color-*` do bloco `@theme` em `src/index.css` (fonte de verdade v4 CSS-first;
    parse via regex) e falhando abaixo do mínimo AA.
  - `tests/contrast-usage.a11y.test.ts` — pares das **cores default do Tailwind em uso** como
    texto/ícone (`gray/slate/zinc/amber/orange…`) sobre seus fundos reais. Mantém um array
    `COMPLIANT` (asserção dura, não regride) e um padrão de **ratchet** documentado: uma nova
    cor de baixo contraste vai para um `KNOWN_VIOLATIONS` verificado com `it.fails` (suíte segue
    verde, dívida visível) e, ao corrigir, sobe para `COMPLIANT`. Texto AA ≥4.5:1 · ícone/UI ≥3:1;
    ao introduzir cor default escura, **subir o tom** (ex.: `*-400`→`*-500`/`amber-600`) em vez de
    relaxar o threshold.
- **Camada de acessibilidade em NAVEGADOR REAL** (Playwright + `@axe-core/playwright`) — cobre o
  que o jsdom não vê: contraste sob render efetivo, ordem de foco e autofill. Config em
  `playwright.config.ts`, specs em `e2e/*.a11y.e2e.ts` (`public-auth` = login/forgot/reset sem
  login; `protected` = `/consulta`/`/emails`/`/erros` atrás de `A11Y_TEST_EMAIL`/`A11Y_TEST_PASSWORD`,
  pulado sem credencial), helper `e2e/axe.ts` (tags AA). Scripts `test:e2e`/`test:e2e:headed`. Os
  specs **não** rodam no `npm test` (runner separado, fora do `tsconfig`/ESLint — `e2e/` está nos
  `ignores`). Ver `e2e/README.md`. O **workflow `.github/workflows/a11y.yml`** roda a camada a cada
  PR/push na `Features` (runner `ubuntu-latest`, Chromium provisionado) — **operacional e verde**,
  com os 4 secrets cadastrados (`VITE_SUPABASE_URL`/`ANON_KEY` + `A11Y_TEST_EMAIL`/`PASSWORD`, este
  último um usuário de teste só-leitura no Supabase). **Não rodar `npm run test:e2e` no sandbox do
  agente** — o renderer do Chromium crasha ao montar a SPA completa (limite de recursos do ambiente,
  não do código); validar na máquina do usuário ou no CI. A camada já **pegou e corrigiu 45 violações
  de contraste** nas páginas protegidas (sidebar/cabeçalhos/grid/toolbar) que os guardas por token e o
  jsdom não viam — ver "Guia de cores — grid de dados".

---

## Autenticação (Supabase Auth)

O acesso às rotas internas (`/emails`, `/consulta`, `/erros`) exige login.

- **Sem auto-cadastro**: usuários criados apenas pelo admin no Supabase Dashboard
  (`Authentication → Users → Add user`, com "Auto Confirm User" marcado).
  `supabase.auth.signUp()` nunca é chamado pelo frontend.
- **Três fluxos** (`apps/frontend-vite/src/pages/auth/`): `LoginPage` → `signInWithPassword`,
  `ForgotPasswordPage` → `resetPasswordForEmail`, `ResetPasswordPage` → `updateUser`.
- Estado de sessão: `AuthContext`/`useAuth` (`apps/frontend-vite/src/contexts/AuthContext.tsx`),
  via `supabase.auth.getSession()` + `onAuthStateChange`. Ao restaurar, primeiro aplica o
  early-out de inatividade (`isIdleExpired`, ver abaixo); se não expirou, valida a sessão no
  servidor com `getUser()`: 401/403 → desloga; falha de rede → mantém otimisticamente.
- **Persistência da sessão (storage híbrido — "Lembrar-me")**: `supabaseClient.ts` usa
  `storage: hybridAuthStorage` (`src/lib/authStorage.ts`), que roteia o token pelo checkbox
  "Lembrar-me" via flag `pag:remember` no localStorage (`'1'`/`'0'`): **marcado →
  `localStorage`** (sobrevive ao fechar o navegador), **desmarcado → `sessionStorage`**
  (reabrir sempre exige login). `LoginForm` chama `setRememberPreference(remember)` antes do
  `signIn`; o checkbox **inicializa refletindo a última preferência salva**
  (`getRememberPreference` no `useState`) — desmarcado na primeira vez e, uma vez marcado,
  permanece marcado nas próximas sessões até o usuário desmarcar. Refresh (F5) na mesma aba
  mantém em ambos os casos.
- **Logout por inatividade (teto de 10 min, vale em ambos os modos)**: `useIdleLogout`
  (`src/hooks/`) desloga após `VITE_SESSION_IDLE_MINUTES` sem atividade (padrão 10 min).
  Marcador de atividade em `localStorage` (`pag:last-activity`, compartilhado entre abas);
  reiniciado no `SIGNED_IN`, limpo no `SIGNED_OUT`. O helper `isIdleExpired(timeoutMs)`
  (exportado do mesmo hook) é usado no `AuthContext.init()` para deslogar já na reabertura
  quando o período ocioso herdado expirou — assim "Lembrar-me" mantém a sessão por **no
  máximo 10 min** entre reaberturas, sem flash de conteúdo protegido.
- **Suspensão durante processamento**: `suspendIdleLogout()`/`resumeIdleLogout()`
  (contador no `useIdleLogout`) pausam o teto de inatividade enquanto a leitura de
  e-mails roda (`Emails.handleRead` suspende no início e retoma no `finally`, ambos os
  modos). Evita logout no meio de um processamento longo; `resume` reinicia a janela.
- Rotas protegidas: `ProtectedRoute.tsx` redireciona para `/auth/login` sem sessão.
- RLS: migration `015` trocou policies de leitura de `TO anon` para `TO authenticated` —
  `services/supabase.ts` envia `access_token` no header `Authorization` (além do `apikey`).

## Arquitetura e fluxo de dados

Monorepo (npm workspaces): `apps/frontend-vite` (SPA interno, React 19/Vite 8/TS 6, :5173),
`apps/api-backend` (Next 16/TS, camada de dados, :3000), `apps/portal-next` (portal
público, Next 16, :3002), `packages/shared` (Zod) + camada Python (`server/`, `skills/`).

```
IMAP (Locaweb SSL)                  apps/frontend-vite (React+Vite TS, :5173)
      │                                        │
      │                          ┌─────────────┼────────────────────────────┐
      │                          │ /emails     │ /consulta      /erros       │
      │                          │ email_control  financial_account_control  errors   │
      │                          │   fetch direto Supabase REST              │
      │                          │   (apikey: anon + Authorization: token)   │
      │                          └─────────────┼────────────────────────────┘
      │                                        │ POST /read/start + GET /progress (poll)
      │                                        ▼  (proxy /api → Flask :8000)
read_emails.run_reader() ◄───────── server/app.py (Flask, porta 8000)
      │                                        ▲
      │ por e-mail:                            │ ponte HTTP (lib/python-bridge.ts)
      │  1. deduplica via email_control.message_id (UNIQUE) — pula já vistos
      │  2. SEM keyword no assunto → registra como 'ignorado' (sem baixar/extrair)
      │  3. COM keyword → salva PDF em data/pdfs_inbox/  apps/api-backend (:3000)
      │  4. in-process → extract_pdf.extract_to_csv (Claude API: pdf_text ou pdf_vision)
      │  5. UPSERT em email_control  +  fallback CSV em data/csv_output/
      ▼
Supabase (PostgreSQL)  ── financial_account_control (dados extraídos)
                       ├─ email_control     (controle/dedup)
                       ├─ email_processing_errors (log de falhas)
                       └─ supplier          (fornecedores — auto-criados + curadoria; preservado)
```

> **Topologia de portas (dev):** o frontend (`:5173`) chama o Flask (`:8000`) **direto**
> via proxy `/api` para a leitura de e-mails. A Next API (`:3000`) é camada de dados
> independente (CRUD futuro) e expõe a mesma ponte ao Flask; não intercepta o caminho
> atual do frontend.

## Comandos

Dependências dos apps: `npm install` na **raiz** (workspaces — lockfile único).

```powershell
# Tudo de uma vez: Flask (:8000) + os 3 apps Node (vite :5173, api :3000, portal :3002)
npm run dev            # via concurrently — serviços falham de forma INDEPENDENTE (ver nota)

# …ou individualmente, em terminais separados:
npm run dev:flask      # backend Flask (:8000) — leitura de e-mails (py -3 server/app.py)
npm run dev:vite       # frontend Vite interno (proxy /api → Flask :8000)
npm run dev:api        # Next API de dados — opcional p/ o fluxo atual
npm run dev:portal     # portal público — opcional
```

Scripts da raiz: `npm run dev` (sobe **flask+vite+api+portal** em paralelo via
`concurrently`) · `npm test` · `npm run typecheck` · `npm run lint` · `npm run prune`
(rodam em todos os workspaces via `--workspaces --if-present`). Builds:
`npm run build:vite|build:api|build:portal`. O `dev` raiz **inclui o Flask**
(`dev:flask` = `py -3 server/app.py`); requer Python com `pdfplumber` no PATH. Para
subir só os apps Node, use os `dev:vite|dev:api|dev:portal` individuais.

> **Nota de estabilidade do dev server (2026-06-19):** o `--kill-others-on-fail` foi
> removido do script `dev` — cada serviço agora falha de forma independente. Antes, uma
> falha do Flask (ex.: porta `:8000` ocupada de sessão anterior) derrubava o Vite junto.
> **Para sessões de trabalho exclusivamente de frontend, prefira `npm run dev:vite`** —
> o Vite sobe sem depender do Flask e não há risco de queda por serviços externos.

Acessibilidade em navegador (Playwright + axe) — **não** roda no `npm test`; runner
separado em `apps/frontend-vite` (sobe o Vite dev sozinho via `webServer`):

```powershell
cd apps\frontend-vite
npx playwright install chromium      # uma vez (baixa o navegador)
npm run test:e2e                     # todas (protegidas pulam sem credencial)
npm run test:e2e -- public-auth      # só login/forgot/reset (sem login)
npm run test:e2e:headed              # com janela do navegador
```

Para escanear as rotas protegidas, exporte `A11Y_TEST_EMAIL`/`A11Y_TEST_PASSWORD` (usuário de
teste no Supabase). No CI, o workflow `.github/workflows/a11y.yml` roda isso a cada PR/push na
`Features`. **Não executar daqui (sandbox do agente)** — o renderer crasha na SPA completa.

Leitura de e-mails:

```powershell
python skills\email-reader\scripts\read_emails.py --days 7
python skills\email-reader\scripts\read_emails.py --dry-run
python skills\email-reader\scripts\read_emails.py --all --mark-seen
```

Reprocessar PDFs pendentes (`status=pendente`: `attachment_saved=true`, `pdf_extracted=false`):

```powershell
py -3 scripts\retry_extraction.py          # usar py -3, não python
py -3 scripts\retry_extraction.py --dry-run
```

Reprocessar a fila de `falha` (rebusca o corpo no IMAP). Os dois são complementares —
rode primeiro o de **link** (boleto por URL), depois o de **corpo**:

```powershell
py -3 scripts\reprocess_link_emails.py --dry-run   # boleto por link (BRASPRESS/SIEG…)
py -3 scripts\reprocess_body_emails.py --dry-run   # conta no corpo do e-mail (sem anexo/link)
```

Reprocessar após **ampliar o filtro de assunto** (acrônimos de tributo) ou ajustar a regra
de NF-e. Fase A: `ignorado` que passou a casar keyword → rebusca no IMAP e extrai. Fase B:
NF-e pura sem conta a pagar → reclassifica para `ignorado` (só status, sem IMAP):

```powershell
py -3 scripts\reprocess_ignored_emails.py --dry-run
```

Extração isolada:

```powershell
py -3 skills\pdf-contas-pagar\scripts\extract_pdf.py --input data\pdfs_inbox\ --output data\csv_output\ --batch
```

Dependências:

```powershell
pip install -r server/requirements.txt   # deps Python do pipeline, pinadas com ~=
npm install                              # na raiz do monorepo — instala todos os workspaces
```

`server/requirements.txt` é a fonte de verdade das dependências Python (flask, python-dotenv,
pdfplumber, pypdf, Pillow, anthropic, pandas), com versões fixadas em `~=` para dev/prod não
divergirem — não rodar `pip install` solto sem atualizar o arquivo.

## Frontend — componentes e design system

### Estrutura Atomic Design

**Dois estilos visuais de auth coexistem** — não misturar componentes entre eles:

| Estilo | Páginas | Tokens | Componentes-chave |
|---|---|---|---|
| **v2 loginGreen** | `LoginPage` | `loginGreen-*`, `font-jakarta`, `border-[6px]` frame | `FilledTextField`, `AccentPillButton`, `SocialLinksBar` |
| **auth gradient** | `ForgotPasswordPage`, `ResetPasswordPage` | `bg-gradient-auth`, `auth-navy` | `AuthLayout`, `AuthInput`, `GradientPillButton`, `InlineMessage` |

Tudo em TypeScript (`.tsx/.ts`) sob `apps/frontend-vite/src/`:

```
apps/frontend-vite/src/components/
├── atoms/
│   ├── Alert.tsx              # (app) banner de página via cva — error/success/warning/info + ícone
│   ├── FilledTextField.tsx    # (v2) campo label + fundo verde + id (useId) + aria-invalid
│   ├── AccentPillButton.tsx   # (v2) botão primário verde + ArrowRight
│   ├── AuthInput.tsx          # (gradient) campo label + input + erro inline (aria-describedby)
│   ├── GradientPillButton.tsx # (gradient) botão pill com bg-gradient-auth
│   ├── CheckToggle.tsx        # checkbox de curadoria (NF/Boleto) — escreve no banco
│   └── SelectCheckbox.tsx     # checkbox de SELEÇÃO de linha (rowSelection) + indeterminate
├── molecules/
│   ├── SocialLinksBar.tsx     # (v2) círculos Otimotex/Lebianco/WhatsApp
│   ├── AuthHeroHeader.tsx     # (gradient) header decorativo com círculos sobrepostos
│   ├── InlineMessage.tsx      # (gradient) banner sucesso/erro — nunca alert()
│   ├── ColumnVisibilityMenu.tsx # (grid) popover mostrar/ocultar + fixar coluna (pin esq/dir)
│   └── GridToolbar.tsx        # (grid) barra: colunas + densidade + restaurar + ações de seleção
├── organisms/
│   ├── LoginForm.tsx          # (v2) estado + validação + supabase.auth.signInWithPassword
│   ├── ForgotPasswordForm.tsx # (gradient) resetPasswordForEmail + mensagem genérica
│   ├── ResetPasswordForm.tsx  # (gradient) updateUser + signOut + redirect
│   ├── DataGrid.tsx           # grid sobre TanStack Table v8 (+ DataGrid.test.tsx) — ver seção própria
│   └── dataGrid.variants.ts   # cva por slot (header/row/cell/skeleton/empty/pin/resize/grip/densidade) default|silver
├── AuthLayout.tsx             # (gradient) wrapper full-page para Forgot/Reset
├── AttachmentViewer.tsx       # visualizador de PDF (signed URL do Storage) em <dialog> nativo (showModal: role/foco/trap/Esc nativos) + iframe
├── Layout.tsx (+ Layout.test.tsx)   # sidebar; navLink = cva local (estado active); menu em 5 grupos (ver abaixo)
├── ProtectedRoute.tsx
├── StatusBadge.tsx (+ StatusBadge.test.tsx)   # componente; variantes em statusBadge.variants.ts
├── statusBadge.variants.ts    # cva(badgeVariants) + resolveBadge + badgeLabel + mapas de tipo/status
└── ExpandableText.tsx         # expansível "ver mais/ver menos" (+ ExpandableText.test.tsx)
```

**Menu da sidebar (`Layout.tsx`) — 5 grupos** (cabeçalho `uppercase`; itens `breve` são
`<span className="nav-link is-disabled">` com badge "breve", sem rota):

| Grupo | Itens (rota / estado) |
|---|---|
| **Recebimentos** | E-mails (`/emails`) · Log de erros (`/erros`) |
| **Envios** | E-mails (`/cobranca/envios`) · Log de erros (`/cobranca/erros`) — logs da cobrança automática de vencidos |
| **Contas** | Gestão de contas (`/consulta`) · Cadastro de contas (`breve`) |
| **Cadastros** | Cadastro de fornecedores (`breve`) |
| **Análise** | Dashboard (`breve`) |

> "Gestão de contas" aponta para `/consulta` (só o rótulo difere da rota). Ao promover um
> item `breve` a ativo, troque o `<span … is-disabled>` por `<NavLink>` e remova o badge.

Hooks em `src/hooks/`: `useContainerBreakpoint.ts` (faixa `sm`/`md`/`lg` pela largura
**real do container** via `ResizeObserver` — não da janela; usado pelo `DataGrid` p/ ocultar
colunas considerando sidebar/paddings), `useGridPreferences.ts` (estado de layout do grid —
ordem/visibilidade/larguras/fixação/densidade — persistido em `localStorage` por `gridId`;
setters no formato `OnChangeFn` do TanStack + `reset()`; ver seção do DataGrid) e
`useGridColumns.ts` (metadados de coluna — `ColumnDef` com `size?` opcional, `getConsultaColumns`,
`getEmailColumns`; é módulo de **definições**, não um hook,
apesar do nome). `getConsultaColumns(onToggleFlag, onStatusChange)` é factory porque as colunas
"NF" e "BOL" (curadoria) renderizam o atom `CheckToggle` (checkbox que escreve no banco) e a
coluna "Situação" renderiza o `StatusSelectCell` (dropdown inline que altera o status) — precisam
dos callbacks da página. Os cabeçalhos são abreviados (`NF`/`BOL`) para poupar
largura, mas o `aria-label` do checkbox continua descritivo (`Tem NF`/`Tem Boleto`). As colunas
**"Fornecedor" e "CNPJ/CPF" derivam do JOIN com `supplier`** (`r.supplier?.trade_name ??
legal_name` e `r.supplier?.cnpj ?? cpf`) — `financial_account_control` não guarda mais essas
colunas (migrations 040/041); por isso **não têm `sortKey`** (não são ordenáveis server-side: order
por recurso embutido no PostgREST é frágil) e seu `key` no `ColumnDef` é uma string sintética
(`ColumnDef.key` é `keyof T | (string & {})`; no `DataGrid` o `accessorFn` faz `row[key as keyof T]`,
inócuo pois o accessor só alimenta sort/filter client-side, que não usamos). Ordem
das colunas finais de `/consulta`: **… Valor → NF → BOL → Situação → Extração** (`Extração`
por último, após `Situação`). A coluna `Extração` mostra `extraction_source` (badge), mas foi
removida do painel de detalhe e da exportação CSV — aparece **apenas** como coluna do grid.
A coluna **"Situação" ordena alfabeticamente pelo texto** (`sortKey: 'status'`), **não** por
`status_id`: decisão de negócio — o ciclo de vida não é linear (de `a vencer` pode-se ir direto a
`cancelado`/`falha`), então a ordem alfabética é mais previsível (`status_name` só existe na
dimensão `status`, não é coluna ordenável deste endpoint). As **larguras (`size`) das colunas de
`/consulta` foram ajustadas** (soma ~1.459px, de ~1.673px) para caber no viewport desktop sem
estourar scroll horizontal (descontando a sidebar de 208px + padding `px-6`); o ajuste foi só nos
tamanhos — as regras `hideOn` (responsividade mobile/tablet) permanecem como o mecanismo de
ocultação por breakpoint.
`useIdleLogout.ts` e `useAuth` cobrem sessão (ver Autenticação).

Tipos compartilhados vêm de `@sheild/shared` (ex.: `FinancialEmail`, `EmailControl`).
Helpers em `src/lib/`: `getErrorMessage.ts` (erro em strict mode), `cn.ts` (merge de
classes Tailwind — `clsx` + `tailwind-merge`, base do padrão CVA), `supabaseClient.ts`
(SDK oficial, só para auth), `authStorage.ts` (storage híbrido da sessão +
`setRememberPreference`/`getRememberPreference` — preferência "Lembrar-me"; ver
seção Autenticação) e `getStatusExplanation.ts` (texto pt-BR no `Alert` do card de `/emails`
explicando por que um e-mail ficou em `falha` (error), `pendente` (warning) ou `ignorado`
(info); reusa `getFailureReason.ts` para o caso `falha`).

Infra de teste a11y em `tests/`: `setup.ts` (matcher `toHaveNoViolations`), `axe.ts`
(runner AA + `color-contrast` desligado), `contrast.a11y.test.ts` (guarda de contraste
dos tokens) e `contrast-usage.a11y.test.ts` (guarda das cores default do Tailwind em uso,
com ratchet `it.fails`). Camada de navegador em `e2e/` (Playwright + axe). Ver regra
mandatória 6.

### Guia de cores — paleta `loginGreen` (`@theme` em `apps/frontend-vite/src/index.css`)

Telas de auth usam **exclusivamente** estes tokens:

| Token | Hex | Uso |
|---|---|---|
| `loginGreen-ink` | `#0c1e14` | títulos, labels, texto de input |
| `loginGreen-inkMid` | `#2a3d30` | textos secundários ("lembrar-me") |
| `loginGreen-inkMuted` | `#4a6b55` | labels sociais, divisores |
| `loginGreen-inkFaint` | `#558a6d` | ícone olho — AA ≥3:1 sobre o campo (1.4.11) |
| `loginGreen-placeholder` | `#437355` | placeholder (`placeholder:text-loginGreen-placeholder`) — AA ≥4.5:1 sobre o campo |
| `loginGreen-field` | `#eef9f3` | fundo dos campos |
| `loginGreen-fieldFocus` | `#e4f6ec` | fundo em foco |
| `loginGreen-socialBg` | `#f4fcf7` | fundo dos círculos sociais |
| `loginGreen-border` | `#94D0AE` | borda principal (frame externo) |
| `loginGreen-borderLight` | `#c6e8d3` | borda secundária |
| `loginGreen-borderField` | `#b8dfc8` | borda dos campos |
| `loginGreen-borderFocus` | `#2d8a52` | borda em foco, `accent-color` do checkbox |
| `loginGreen-accent` | `#1e7a40` | botão, links |
| `loginGreen-accentHover` | `#165c30` | hover do botão (`hover:bg-loginGreen-accentHover`) |
| `loginGreen-accentMuted` | `#6aaa85` | botão desabilitado (`disabled:bg-loginGreen-accentMuted`) |

Paleta `brand` (verde dashboard) e `auth` (azul/petróleo) são usadas nas demais páginas — não misturar com `loginGreen`.

> **Contraste AA travado:** `loginGreen-inkFaint`/`-placeholder` foram escurecidos para
> cumprir AA sobre o campo verde (≥3:1 ícone / ≥4.5:1 placeholder). Não clarear sem
> revalidar em `tests/contrast.a11y.test.ts`.

### Guia de cores — paleta semântica `status` (`@theme` em `src/index.css`)

Fonte de verdade para **feedback, badges e banners** em todo o app — usar estes tokens em
vez de cores default do Tailwind. Cada grupo tem `bg` (fundo suave), `fg` (texto/ícone) e
`border`; `error` ainda tem `solid`/`solidBorder` (badge crítico de fundo cheio). Todos
cumprem WCAG AA (verificado em `tests/contrast.a11y.test.ts`).

| Token | fg / bg | Uso |
|---|---|---|
| `status-error-*` | `#b91c1c` / `#fef2f2` (border `#fecaca`) | erro, vencido, falha |
| `status-error-solid` | branco / `#dc2626` | badge crítico (`erro_api`) |
| `status-success-*` | `#15803d` / `#f0fdf4` | sucesso, pago, **extraído + recebido** (verde) |
| `status-warning-*` | `#b45309` / `#fffbeb` | atenção (cartório, erros de extração) |
| `status-info-*` | `#1d4ed8` / `#eff6ff` | informativo, a vencer, prorrogado, baixado |
| `status-source-*` | `#0f766e` / `#f0fdfa` | origem da extração (teal) |
| `status-neutral-*` | `#475569` / `#f8fafc` | neutro, cancelado, documento, **pendente + ignorado + duplicidade** (cinza slate-600) |

Aplicação **sempre via `cva`**: `StatusBadge` (`statusBadge.variants.ts`), `Alert` (banner
de página) e `InlineMessage`. As quatro paletas — `brand` (verde dashboard), `auth`
(azul/petróleo), `loginGreen` (auth v2) e `status` (semântica) — **não se misturam**; cada
uma no seu contexto.

**Cards de KPI em `/emails` espelham o badge** (`CARD_TONE` em `Emails.tsx`): ícone + número
de cada card usam a mesma cor do `StatusBadge` do status; o card ativo (filtro) ganha anel +
fundo no tom. Esquema (decisão de UI): **Total**=preto (`text-gray-900`) · **Extraídos +
Recebidos**=verde · **Falha**=vermelho · **Pendente + Ignorados + Duplicidades**=cinza
(`neutral`). Ordem dos cards: Total · Extraídos · Recebidos · Pendente · Duplicidades ·
Ignorados · Falha. Ao mudar a cor de um status, mexer **só** no `STATUS_VARIANT`
(`statusBadge.variants.ts`) — o card herda pelo `CARD_TONE` apontando o mesmo token.

### Guia de cores — grid de dados (`DataGrid`, `dataGrid.variants.ts`)

O `DataGrid` é **chrome de tabela neutro**, não estado semântico — por isso usa as escalas
neutras default do Tailwind (exceção explícita à regra "não usar cores default" da Regra 1,
que vale só para **estados semânticos**). Dois temas via `variant`:

| Tema | Uso | Neutro | Header/célula |
|---|---|---|---|
| `default` | `/consulta` | `slate-*` | `.table-header` / `.table-cell` |
| `silver` | `/emails` | `zinc-*` | `.table-header-silver` / `.table-cell-silver` |

Linha selecionada usa o acento `brand` (`bg-brand/10 border-l-2 border-brand`); o **hover** é
cinza neutro (`hover:bg-slate-100` no tema `default`, `hover:bg-zinc-200` no `silver`) para
contrastar com o verde da selecionada. Quando há coluna **fixada à esquerda** (ex.: a de
seleção), a 1ª célula fixada opaca cobriria o `border-l` do `<tr>`, então o acento é repintado
nela via box-shadow inset brand (variante `selected` do `pinnedCell`, aplicada só à primeira
célula left-pinned da linha selecionada). O `StatusBadge` dentro das células continua na paleta
`status`. Cada slot (header, row, cell, skeleton, empty, sub-linha de detalhe) é um `cva`
próprio com a base + o neutro do tema — string literal completa.

> **Contraste AA do texto do grid (não regredir):** o "chrome neutro" vale para
> **fundos/bordas e ícones SVG** (grip, sort, skeleton) — o axe `color-contrast` checa **só
> texto**, então ícone claro não é flagado. Mas **todo TEXTO** do grid precisa cumprir AA: a
> varredura em navegador (`e2e/`) reprovava `slate/zinc-300/400` na sub-linha de detalhe e nos
> cabeçalhos. Mínimos travados: `table-header`/`-silver` = `slate-600`/`zinc-600`;
> `secondText` (sub-linha) `label`/`sep` = `*-500`, `value` = `*-600`; `emptyText` = `*-500`.
> Botão/badge com **texto branco** usa `bg-brand-dark` (não `bg-brand` sólido, que dá só
> 3,4:1) — ver `DensityButton`/`PinButton`. Foi o axe em navegador que provou que a antiga
> "exceção" cobria texto demais.

### Guia de tamanhos — tokens Tailwind em uso

Usar o token mais próximo; valor arbitrário só como exceção documentada (ver abaixo).
A login passou por compactação para centralizar melhor o card — os valores abaixo são
os **atuais** (não os do design original).

> **Snap aplicado em todo o app (não só na login):** tamanhos arbitrários de fonte foram
> eliminados — `text-[9px]/[10px]/[11px]` → `text-xs`, `text-[13px]`/`body` → `text-sm`,
> `tracking-[0.15em]` → `tracking-widest`. **Não reintroduzir `text-[Npx]`**; o corpo
> (`body` em `index.css`) é `text-sm` (14px) e as classes utilitárias `.table-header*` /
> badge base usam `text-xs`. As únicas exceções arbitrárias aceitas seguem sendo as de
> layout (ver abaixo) — nunca tipografia.

**Tipografia:**

| Classe | Tamanho | Uso no projeto |
|---|---|---|
| `text-xs` | 12px | labels sociais ("fale com a gente"), rótulos dos círculos |
| `text-sm` | 14px | labels de campo, "lembrar-me", erro inline, links |
| `text-base` | 16px | corpo padrão do restante do app |
| `text-lg` | 18px | subtítulo do login + texto do botão primário (`AccentPillButton`) |
| `text-3xl` | 30px | h1 do login ("Login") — reduzido de `text-4xl` nesta sessão |

**Espaçamento e dimensões recorrentes (login page):**

| Classe | px | Uso |
|---|---|---|
| `h-10` | 40px | altura dos campos de input (`FilledTextField`) |
| `h-12` | 48px | altura do botão primário (`AccentPillButton`) |
| `h-56` | 224px | altura do banner da login page |
| `h-1` | 4px | divisor verde entre banner e card |
| `w-12 h-12` | 48px | círculos sociais |
| `w-7 h-7` | 28px | ícone dentro do círculo social |
| `w-4 h-4` | 16px | checkbox "lembrar-me" (a escala Tailwind **não tem `4.5`** — não usar) |
| `border-[6px]` | 6px | frame externo + moldura interna do banner (exceção arbitrária) |
| `border-2` | 2px | borda dos campos e círculos |
| `ring-4` | 4px | anel interno do card (`ring-inset ring-loginGreen-border/25`) |
| `rounded-2xl` | 16px | border-radius do card/frame |
| `rounded-lg` | 8px | border-radius de campos e botão |
| `gap-3` | 12px | espaçamento entre seções do formulário |
| `gap-1.5` | 6px | label↔campo e círculo↔rótulo social |
| `gap-8` | 32px | espaçamento entre círculos sociais |
| `my-3` | 12px | folga vertical extra do botão Login (acima/abaixo, somada ao `gap-3`) |
| `px-6` | 24px | padding horizontal do card |
| `pt-2.5` / `pb-3` | 10px / 12px | padding vertical do card (topo/base) |
| `px-3.5` | 14px | padding horizontal dos campos |

**Exceções de valor arbitrário aceitas (login page):**

- `border-[6px]` — 6px não existe na escala (`border-2`/`-4`/`-8`); usado no frame e na
  moldura do banner por decisão visual.
- `object-[center_25%]` — enquadramento do banner sem token equivalente.
- `w-[calc(100%+2px)] max-w-none -ml-px` no `<img>` do banner — "sangra" 1px para cada
  lado, recortado pelo `overflow-hidden` do frame, para **eliminar o risco escuro** que a
  coluna de pixels da borda da imagem deixava contra a moldura verde.

**Fonte customizada:**

`font-jakarta` → `Plus Jakarta Sans` (Google Fonts, carregada em `app/index.html`).
Aplicada no div raiz de `LoginPage.tsx`; herda por cascata para todos os filhos.

## Pontos-chave que exigem ler vários arquivos

### `run_reader()` é a única fonte de verdade da leitura

`skills/email-reader/scripts/read_emails.py` — tanto o CLI quanto `server/app.py`
chamam `run_reader()`. Edite só ali — nunca duplique lógica no Flask.

`read_emails.py` carrega o `.env` da raiz (`load_dotenv(parents[3]/".env")`).
`server/app.py` insere o caminho no `sys.path` e importa o módulo.

### Robustez da leitura e da extração (não regredir)

Proteções aprendidas "na dor" — manter:

- **IMAP com timeout** (`_connect_imap`, `IMAP_TIMEOUT_SECONDS`, env `IMAP_TIMEOUT` default
  120s): sem timeout de socket, um `fetch` que estanca (mensagem grande, hiccup do servidor)
  **congela o run síncrono para sempre**. Com timeout, levanta `socket.timeout`, o e-mail é
  pulado/erra e o run segue. **Nunca** criar `IMAP4_SSL` sem `timeout`.
- **IMAP com retry/backoff** (`_connect_and_search`, `IMAP_MAX_ATTEMPTS` default 3,
  `IMAP_RETRY_BACKOFF` default 5s): connect + select + search são uma **unidade resiliente** —
  uma falha transitória (timeout de socket, `imaplib.IMAP4.abort`) refaz a sequência (nova
  conexão) com espera crescente. Erro de protocolo/login (`imaplib.IMAP4.error` puro) **não**
  repete (retry ali é inútil). Esgotadas as tentativas, levanta `RuntimeError` → o caller HTTP
  devolve `502`. `run_reader` monta o `criteria` **antes** de chamar `_connect_and_search`.
- **Claude API com timeout** (`extract_pdf.py`, `CLAUDE_API_TIMEOUT_SECONDS`, env
  `CLAUDE_API_TIMEOUT` default 90s): mesma classe de falha do IMAP. Sem `timeout` explícito o
  SDK Anthropic usa ~10 min/request; num run síncrono que processa muitos PDFs, **um request
  travado congela o pipeline inteiro**. As 3 instâncias `anthropic.Anthropic(...)`
  (`_try_barcode_vision`, `extract_with_vision`, `extract_fields_with_claude`) **sempre** passam
  `timeout=CLAUDE_API_TIMEOUT_SECONDS`. **Nunca** criar o client sem `timeout`.
- **Extração IN-PROCESS (não regredir — 2026-06-22)**: `run_extraction` chama
  `extract_pdf.extract_to_csv()` **no mesmo processo**, via import lazy — **não** mais um
  subprocesso `python extract_pdf.py`. Motivo: na busca geral de 2026-06-22, **100% das
  extrações falharam** com `rc=0xC0000142` (STATUS_DLL_INIT_FAILED) quando o spawn de
  subprocesso partia do processo do Flask — o subprocesso nem inicializava (DLLs nativas de
  pandas/Pillow não carregavam naquele contexto de *desktop heap*). O caminho do corpo
  (in-process) seguia funcionando; só o de PDF (subprocesso) caía. Chamar a função direto
  **elimina a criação de processo** → funciona idêntico no app (Flask), no CLI e no scheduler,
  e ainda evita reimportar pdfplumber/pandas/anthropic por PDF. **Nunca** voltar a
  `subprocess.run([sys.executable, extract_pdf.py])`. Ver memória `pdf-extraction-dll-init-fail`.
- **`run_extraction` resiliente**: retorna `(csv_path, motivo)`. `_run_extraction_once`
  classifica a falha — **transitória** (exceção de I/O/runtime → repete com backoff;
  `EXTRACTION_MAX_ATTEMPTS=3`/`EXTRACTION_RETRY_BACKOFF`) vs **definitiva** (extração não gerou
  registros → não repete). O `motivo` é gravado em `email_processing_errors.raw_payload`
  (`detalhe`) e fica **visível em `/erros`** — antes só ia para o console do Flask, fazendo um
  blip transitório parecer "tudo quebrado".
- **FETCH RFC822 robusto** (`_rfc822_from_fetch`): o `imaplib` pode **intercalar** respostas
  (um `FLAGS`/`UID` isolado como item `bytes`) no retorno do `fetch`. Aí `data[0]` não é a
  tupla `(meta, raw)` e `data[0][1]` indexa um `bytes`, devolvendo um **int** — e
  `email.message_from_bytes(int)` quebra com `'int' object has no attribute 'decode'`
  (crash intermitente). `process_message` usa `_rfc822_from_fetch(data)`, que varre `data`
  e pega a primeira tupla cujo 2º elemento sejam bytes. **Nunca** voltar a `data[0][1]` direto.
- **Reprocesso sem perda de dado** (`scripts/reprocess_ignored_emails.py`): a Fase A **não
  apaga** a linha de `email_control` antes de reprocessar — roda `process_message` (que
  re-registra com `ignore-duplicates` e cria a conta) e só então faz `PATCH` do status. Apagar
  antes arriscava perder o e-mail se a extração falhasse.

Testes: `tests/test_run_extraction.py`, `tests/test_imap_timeout.py`, `tests/test_imap_retry.py`,
`tests/test_status_for_result.py`, `tests/test_rfc822_fetch.py`, `tests/test_extract_pdf_timeout.py`,
`tests/test_pdf_amount_validation.py`.

### Deduplicação por `message_id`

Gravado em `email_control.message_id` (UNIQUE). `register()` usa
`Prefer: resolution=ignore-duplicates` — mensagens já processadas são ignoradas sem
atualizar o registro existente. Fallback local em CSV quando Supabase indisponível
(`SupabaseControl._available`).

### Dedup de conteúdo + reemissão (`financial_account_control`)

Além do dedup por `message_id`, `find_financial_duplicate(payload)` evita gravar o
**mesmo documento** chegado em e-mails diferentes. Casa por 3 impressões: (1) barcode;
(2) **`sk_supplier`** + `invoice_number` (≥6) + valor — pega **guia/DAS reemitida** com o mesmo
número e vencimento novo; (3) **`sk_supplier`** + valor + vencimento + tipo. Quando encontra
duplicata, `extract_and_store_accounts` **não cria outra conta**: se a reemissão tem
vencimento **mais recente**, chama `update_financial` para atualizar `due_date` + boleto
(`barcode`, `amount_charged`, `fine_interest`, `other_additions`) na conta existente — uma
guia paga uma vez, sempre com o boleto válido. A trigger recalcula a situação em `status` no
UPDATE (só quando em aberto — migration 034).

**A dedup casa por `sk_supplier`, não por texto do fornecedor** (migrations 040/041/042): o
fornecedor é resolvido ANTES da dedup por `_finalize_supplier` (RPC
`resolve_supplier_for_account` → `SupabaseControl.resolve_supplier`), que grava
`payload['sk_supplier']` e **remove** as colunas brutas `supplier_name`/`supplier_cnpj`/
`supplier_cpf` do payload. Como a resolução já normaliza nome/CNPJ (via `resolve_supplier_id`:
CNPJ → CPF → e-mail → `normalize_search(legal_name/trade_name)` → auto-insert), a antiga dedup
por nome (RPC `financial_dup_by_name` / `_dup_by_name`) foi **removida** — "EFE Displays" e
"EFE DISPLAYS" deduplicam por já resolverem o mesmo `sk_supplier`. Teste:
`tests/test_dup_by_supplier_id.py`.

### Duas chaves Supabase, dois papéis

- **`anon`** (`VITE_SUPABASE_ANON_KEY`): frontend — leitura REST, respeita RLS `TO authenticated`.
- **`service_role`** (`SUPABASE_SERVICE_KEY`): scripts Python/Flask — escrita, ignora RLS.

### Normalização de `document_type`

`extract_pdf.py` usa `_ns()` (strip de acentos + lowercase) para lookup em `_DOC_TYPE_NORM`.
CHECK constraint em `financial_account_control.document_type` usa `lower()` (migrations 014,
017, **024**, **026** e **043**). Tipos aceitos incluem: `boleto`, `cte`, `nfe`, `nfse`, `tributo`,
`das`, `pix`, `seguro`, `fatura`, `recibo`, `contrato`, `honorários`, `container`, `outro`
(DAS de Simples Nacional → `das`; PIX → `pix`). `container` = frete/demurrage/movimentação de
contêineres (keyword de assunto + classificação no corpo e PDF; migration 026).
`SKIP_ACCOUNT_TYPES = ['nfe', 'nfse']` — não geram conta a pagar.

**Contas de concessionária** (migration 043): `conta de água`, `conta de luz` e
`conta de telefone / internet` (com barra, estilo `dam / duam`). Classificadas em `read_emails.py`
por **duas regras** (palavra inteira via `_has_word`, sem acento via `_ns_body`), ambas com
**precedência máxima** sobre boleto/fatura/PIX:
- **Frase do assunto/corpo** — `_UTILITY_DOC_KEYWORDS` + `_classify_utility_doc_type(*texts)`:
  água=`conta (de) água`; luz=`conta (de) luz`; telefone/internet=`conta (de) telefone|internet`,
  `(conta) vivo`, `vivo (conta)`, `vivo`, `fibra`.
- **Marca no NOME DO FORNECEDOR** — `_UTILITY_SUPPLIER_BRANDS` +
  `_classify_utility_by_supplier(supplier_name)`: `enel`/`eletropaulo`→luz;
  `vivo`/`claro`/`tim`→telefone-internet; `sabesp`→água. **Escopo restrito ao `supplier_name`** de
  propósito: `claro`/`tim`/`vivo` são palavras comuns no corpo ("está claro", "ao vivo") — casar no
  corpo livre geraria falso positivo.

Aplicadas no corpo (`extract_from_email_body`, recebe `subject`) e no PDF
(`build_financial_payload`, recebe `subject` — `extract_pdf.py` é cego ao assunto, então o override
é em `read_emails.py`); a frase tem precedência sobre a marca (`frase or marca`). `payment_method`
permanece o detectado (não é forçado). Geram conta a pagar (não entram em `SKIP_ACCOUNT_TYPES`).
Teste: `tests/test_doc_type_utilities.py`.

**Captura do nº de documento no corpo** (migration 043 / `_BODY_DOCNUM_RE`): além de
`_BODY_INVOICE_RE` (NF/fatura + dígitos), o rótulo **explícito** `Número do documento` captura
valores **alfanuméricos** (ex.: Sabesp `SOR202659903949`, CATAGUASES `014696-001`) como fallback,
antes do SIEG e antes do nº sintético `{tipo}_{ddmmyy}`. Conservador de propósito — rótulos
frouxos (`documento nº`) capturavam lixo ("Banco"). Backfill da migration 043 corrigiu os ids 5,
18 e 171.

**Regra honorários** (migration 024): e-mail de honorários (keyword de assunto `honorário`;
termo `honorário(s)` no corpo ou recibo) é gravado com `document_type='honorários'` e
`payment_method='pix'` — honorários têm **precedência sobre o override de PIX** do tipo, e o
pagamento é forçado a `pix` tanto no corpo (`extract_from_email_body`) quanto no PDF
(`build_financial_payload`).

### Auto-resolução de fornecedor

O pipeline resolve o fornecedor **antes do INSERT** via RPC `resolve_supplier_for_account`
(`migration 040`; `_finalize_supplier` → `SupabaseControl.resolve_supplier`), que chama
`resolve_supplier_id(cnpj, cpf, name, email)` + `_add_supplier_email`. Ordem de busca
(**corrigida na `migration 046`**): **CNPJ → CPF → nome normalizado → e-mail exato → auto-insert**
em `supplier`. **O e-mail só é usado para busca na AUSÊNCIA TOTAL de nome de fornecedor** — antes
(027/028) o e-mail vinha antes do nome, o que fazia pagamentos internos encaminhados por
remetentes internos (ex.: `ester@otimotex.com.br`) colapsarem todos num único fornecedor,
ignorando o NOME do corpo/anexo. **Domínios internos não viram fornecedor** (`migration 046`):
`_is_internal_email` (`%@otimotex.com.br`/`%@lebianco.com.br`) bloqueia esses e-mails tanto no
`_add_supplier_email` quanto no auto-insert do `resolve_supplier_id`. A precedência **anexo → corpo**
do nome é garantida antes, no pipeline Python (o corpo só alimenta o resolver quando o anexo não
gera conta). Função `normalize_search()` é SECURITY DEFINER. `financial_account_control`
referencia o fornecedor **apenas pela FK `sk_supplier`** (surrogate key snowflake, NOT NULL —
`migration 042`): a RPC e as funções de resolução retornam/keyam `sk_supplier`; `supplier_id`
virou **chave de negócio** e ficou só na tabela `supplier` (NOT NULL UNIQUE, igualada ao `sk`
nos fornecedores criados pela extração via trigger de espelho, podendo divergir em cargas
externas). As antigas colunas denormalizadas `supplier_name`/`supplier_cnpj`/`supplier_cpf` e
o trigger `trg_fe_supplier_id` foram **removidos** (`migration 041`); nome/CNPJ vêm do JOIN com
`supplier`. A extração (`extract_pdf.py`/corpo) ainda **produz** nome/CNPJ — são a **entrada**
do resolver, descartados por `_finalize_supplier` depois de obter o `sk_supplier`.

- **Reconhecimento por e-mail** (`027`): na falta de CNPJ/CPF, o **remetente** (`sender_email`)
  é a chave — regra de negócio: o e-mail é estável por fornecedor e raramente um fornecedor
  tem o e-mail como `trade_name`/`legal_name`. Por isso, ao casar, um nome cadastrado em
  formato de e-mail é **promovido** ao nome real quando este chega (`_enrich_supplier_name`).
  Match por **e-mail exato** (case-insensitive) — seguro até em domínios públicos; match por
  **domínio** foi deliberadamente evitado (risco com `gmail.com`/`hotmail.com`).
- **Múltiplos e-mails** (`028`): `supplier` tem `email`, `email2`, `email3`, `email4` e o
  match considera os quatro. O trigger **acrescenta** o remetente no primeiro campo vazio
  (`_add_supplier_email`) em vez de sobrescrever `email` — sem duplicar (dedup case-insensitive);
  com os 4 cheios, o excedente é ignorado. A extração grava
  `financial_account_control.sender_email` (de `email_control.sender_email`) e o trigger o
  propaga ao resolver/criar o fornecedor.

### `extraction_source` — origem dos dados

| Valor (banco) | Origem | Rótulo exibido (badge/UI) |
|---|---|---|
| `pdf_text` | PDF digital (pdfplumber) | `pdf anexado` |
| `pdf_vision` | PDF escaneado (Claude Vision via base64 — não exige poppler) | `pdf anexado` |
| `email_body` | Corpo do e-mail (sem PDF válido) | `corpo email` |
| `falha` | Falha na extração | `falha` |

> O rótulo amigável em pt-BR é resolvido por `badgeLabel()` (`statusBadge.variants.ts`),
> usado pelo `StatusBadge` e pelo painel de detalhe de `/consulta` — `pdf_text` e `pdf_vision`
> compartilham "pdf anexado" (para o usuário ambos são um PDF anexado; a distinção é interna).
> Valores não mapeados caem no próprio texto.

### Boleto por link (sem anexo) — prioridade anexo → link → corpo

A prioridade de extração vale também para **links**: e-mail **sem anexo PDF mas com link**
deve usar o link para encontrar o boleto, antes de cair no corpo. Em `process_message`,
quando `save_attachments` não traz nada, o fluxo chama `extract_pdf_links(body_text,
body_html)` e tenta `download_pdf_from_url` em cada candidato; os PDFs obtidos entram em
`saved_pdfs` e seguem o caminho normal — inclusive **upload no Storage** (todo PDF salvo
passa por `upload_attachment` dentro de `extract_and_store_accounts`, anexo ou link).

- **Reconhecimento do link** (`extract_pdf_links`): âncora/URL com termos de cobrança
  (`_LINK_TEXT_RE`/`_LINK_URL_RE`, que inclui `protocolo`) ou caminho `.pdf`.
- **Página HTML intermediária** (`download_pdf_from_url`): se o link abre uma landing/portal
  HTML, varre os `<a>` (1 nível) atrás de um link de boleto (âncora/URL de cobrança ou
  `.pdf`) e baixa o PDF. Hrefs são **desescapados** (`html.unescape`, `&amp;`→`&`) para os
  parâmetros não quebrarem.
- **SIEG — QUEBROU em 2026-06-16 (handler deferido — decisão A1):** a SIEG migrou
  `app.sieg.com/faturas` para **ASP.NET WebForms com boleto gerado por JS/ajax**
  (`financeiro.min.js`). O scan genérico (sem JS) não acha mais o PDF → loop em HTML +
  `TimeoutError` → cai no corpo (NFE) → `falha`. **Não foi regressão nossa** (caminho de link
  intocado). Mecanismo mapeado p/ o futuro handler: `POST /ajax/BillsDetails.aspx/GetDetailsBills`
  body `{bill:'<bill>',companyid:''}` → `d.Charges[0].PrintUrl` quando `PaymentMethod.Code`
  contém `bank_slip` (`bill`/`branchid` vêm da query da URL). Reprodução server-side dá HTTP 500
  (exige sessão/JS do navegador). **Adiado até entrar uma fatura SIEG em aberto** para validar o
  download de verdade (as atuais estão "Pago"). Detalhes na memória `link-boleto-pipeline`.
- **Portal BRASPRESS** (`download_pdf_from_url` + `_braspress_download_url`): caso que o scan
  genérico não cobre, pois o link do PDF é montado por JS. O link do e-mail
  (`/protocoloweb?protocolo=CHAVE`) abre uma página cujo botão chama `faturaPDF(chave)`, que
  baixa de `/fatura/download?protocolo=CHAVE&protocoloWeb=true`. Exige **cookie de sessão**
  (`JSESSIONID`) — por isso `download_pdf_from_url` usa um `http.cookiejar`/opener
  compartilhado entre a página e o download (`_fetch_url` aceita `opener`). Outros portais
  com link de PDF montado por JS seguem esse padrão (handler dedicado).
- **Lmed/mdnet (portal ScriptCase) — adiado por CAPTCHA (decisão do usuário, 2026-06-17):**
  `srv2.mdnet.com.br/lmedseg/vExternoFatura` pede os "primeiros 3 dígitos do CPF/CNPJ"
  (campo `m_veri`) **e um CAPTCHA com imagem**. O prefixo do CNPJ viria de `company.cnpj`
  (`company_id=1`, tentar 5 e depois 3 primeiros dígitos), mas o captcha bloqueia o download
  automático → fatura fica em `falha` p/ download manual. **Regra de prefixo de CNPJ ainda
  não implementada** — fazer quando houver um portal que peça só o prefixo (sem captcha).
  Detalhes na memória `link-boleto-pipeline`.
- **Links suspeitos são ignorados** (`_is_suspicious_link`, regra Locaweb): redirecionadores/
  rastreadores ofuscados — `bing.com/ck/a?…&u=a1<base64>`, Microsoft SafeLinks, Proofpoint
  URL Defense — **nunca** viram candidatos a download (evita baixar malware de phishing).
  Esta é a **defesa primária**: detecta no corpo o próprio link que faz a Locaweb exibir o
  aviso "Tem certeza que deseja acessar este link?" (modal de webmail mostrado **após** o
  clique, logo ausente do corpo bruto). Como rede secundária, `_body_has_suspicious_warning`
  descarta todos os links se esse texto de aviso aparecer citado no corpo.

Testes: `tests/test_link_extraction.py` (reconhecimento, unescape, filtro de suspeito, URL BRASPRESS).

**Reprocessar histórico**: `scripts/reprocess_link_emails.py` (com `--dry-run`) varre os
e-mails `status='falha'`, rebusca o corpo no IMAP, baixa o boleto pelo link e grava em
`financial_account_control` + atualiza `email_control` (`falha`→`extraído`); duplicatas
(original + encaminhado) deduplicam para uma conta e ambos os e-mails viram `extraído`.

### Caminho `email_body`

Acionado em `process_message()` **só quando `accounts_saved == 0`** (o anexo não gerou
conta válida) — assim o corpo nunca conflita com um arquivo anexado válido.
`extract_from_email_body()` faz parsing por regex. **Fornecedor** (`_BODY_NAME_RE`): rótulo no
início da linha — `fornecedor`/`responsável`/`prestador`/`nome` (+ `favorecido`/`beneficiário`/
`cedente`/`razão social`/`empresa`). O **separador `:`/`-` é OPCIONAL** (aceita só espaço,
ex.: "Nome MATEUS JAE WON AHN"); para não capturar continuação de frase ("Responsável **pela**
compra"), o valor **deve começar por maiúscula/dígito** (char class `[A-ZÀ-Þ0-9]` case-sensitive;
só o rótulo é case-insensitive via `(?i:...)`), e `\b` evita casar prefixo ("Nomeação"). **Cuidado
CRLF:** o fim da linha é `[ \t\r]*$` — o `\r` do `\r\n` bloqueia o `$` se esquecido (bug já
corrigido; teste usa `\r\n`). **Sem rótulo nem documento**, tenta sinais (`_supplier_from_signals`):
assinatura titulada (`Prof./Dr. <Nome>`) e destinatário do pagamento (`pix/pagar p/|para <Nome>`,
com stopwords cortando a captura). Depois o **mapa por remetente** (`_supplier_from_sender`/
`_SENDER_SUPPLIER_MAP`: `correios.com.br` → `Correios`) e só então cai para `sender_email`.
**Valor** (`_extract_body_amount`): (1) "Total"/"Valor Total" com `R$` tem precedência; (2) valores
`R$` somados; (3) **fallback sem `R$`** (`_BODY_LABELED_AMT_RE`) — número rotulado por `Valor`/`Total`
no formato BR com **exatamente 2 casas** (`Valor 50,00`, `Total 1.250,00`), usado só quando não há
nenhum `R$` (exige rótulo + centavos p/ não pegar número solto/`NF 1087`; "Total" tem precedência
sobre "Valor"). `payment_method='pix'` se o termo aparecer (ou sempre, p/ honorários). **Valida
fornecedor+valor**: sem valor → não grava conta (vira `falha`). `email_body_excerpt` (migration 016)
guarda o corpo completo. O **barcode do corpo**
é normalizado por `_normalize_body_barcode`, que reusa `extract_pdf.normalize_barcode` (import
lazy) — mesma regra canônica do caminho de PDF (44/48 dígitos mantidos, 47 → 44, outros →
None), em vez de um `re.sub` solto que aceitava qualquer sequência de 44-48 (F2).

**Corpo SÓ-HTML** (ex.: Correios — `noreply_componentes@correios.com.br`, assunto "Pagamento
Boleto Fatura"): quando o anexo não vem e o link é portal HTML sem PDF, `get_body_text()`
volta vazio. `process_message` então usa `_html_to_text(get_body_html(msg))` (remove tags,
desescapa, colapsa espaços) para alimentar a extração — recupera "Fatura nº: 3918439"
(→ `invoice_number`), "Valor da fatura R$ 1.530,47" (→ `amount`) e classifica
`document_type='fatura'` (keyword `fatura` em `_BODY_DOC_KEYWORDS`, fallback antes de
`outro`). Prioridade segue **anexo → link → corpo**. O status da conta do corpo é **sempre
`pendente`** — a baixa/atualização é feita pelo usuário, mesmo quando o corpo diz "pagamento
realizado com sucesso". Dedup do corpo (`find_financial_duplicate`) evita duplicar conta já
registrada. Testes: `tests/test_body_html_extraction.py`.

**Fallbacks de campo (corpo E PDF — `build_financial_payload`):** `issue_date` vazio →
data do e-mail (`received_at`); `due_date` vazio → `issue_date` → hoje; `invoice_number`
vazio → `"{document_type}_{ddmmyy(vencimento|emissão)}"`. Um **identificador de fornecedor**
extraído (nome **ou** CNPJ **ou** CPF) e `amount` são obrigatórios para gerar conta — o nome/CNPJ
extraído alimenta a resolução do `sk_supplier` (`_finalize_supplier`) e depois é descartado;
não vira coluna em `financial_account_control`.

### Registrar TODOS os e-mails + filtro de assunto (`KEYWORDS_DEFAULT`)

`run_reader()` registra **todos** os e-mails da caixa em `email_control` — `/emails`
espelha o webmail inteiro (o app substitui abrir a caixa). O filtro de keyword decide
**o que extrair**, não o que registrar:

- **Dedup primeiro** (`message_id` em `known_ids`) → pula.
- **Sem keyword** no assunto → `ctrl.register({... status:'ignorado'})` sem baixar/
  extrair (`has_attachment` fica NULL). Respeita `--dry-run` (não grava).
- **Com keyword** → `process_message` (baixa + extrai) define o status via `status_for_result`,
  por **prioridade**: conta do PDF (`accounts_saved>0`) → `extraído` · **NF-e pura sem conta**
  (`subject_is_pure_nfe`) → `ignorado` · CSV do PDF → `extraído` · conta do corpo → `recebido`
  (**vale mesmo com anexo** cujo PDF não gerou CSV — antes virava um falso `pendente`) ·
  **duplicidade** (pagável do corpo duplica conta já registrada) → `duplicidade` · anexo
  salvo sem conta → `pendente` · **notificação sem anexo/conta** (`subject_is_ignorable_notification`)
  → `ignorado` · nada → `falha`. Ver migrations 022/031 e `tests/test_status_for_result.py`.
- **Regra de DUPLICIDADE** (`try_extract_from_body` → `BODY_CREATED`/`BODY_DUPLICATE`/`BODY_NONE`):
  quando o pagável extraído do corpo casa uma conta já existente (`find_financial_duplicate`),
  a conta **não** é recriada e o e-mail vira `duplicidade` (status próprio, migration 031) — não
  `falha`. Cobre a thread original + seu `RES:`/encaminhamento. `email_rec['duplicate_of']` guarda
  o id da conta; `notes` registra "Duplicata — conta já registrada (id N)". Vale no pipeline e no
  `scripts/reprocess_body_emails.py`. Testes: `tests/test_body_duplicate.py`.
- **Corpo é fallback só quando o anexo NÃO gera conta** (`accounts_saved==0`) — havendo
  conta de arquivo anexado válido, o corpo é ignorado (sem conflito).

**Matching de keyword (`match_keyword`, `tests/test_match_keyword.py`)** — comparação
**sem acento** (NFD + lowercase). Dois modos:
- **Acrônimos de tributo/câmbio** (`WORD_KEYWORDS`: `darf, das, dae, dam, duam, gps, gru,
  gnre, gare, ipva, iptu, iss, itbi, cambio`) casam por **palavra inteira** (`\b…\b`) —
  evita falso positivo de substring (`das` em "ca**das**tro"/"executa**das**", `iss` em
  "em**iss**ão", `gru` em "**gru**po", `cambio` em "inter**câmbio**").
- **Demais termos** (frases e siglas distintivas: `boleto, nota fiscal, nf-e, conhecimento
  de transporte, dacte`…) seguem **substring**.
- **Câmbio**: lê `cambio` **ou** `câmbio` (sem acento), mas a keyword gravada/retornada é
  sempre `câmbio` (forma gramatical correta na lista).

**Remetente de SISTEMA → `ignorado`** (`is_ignored_sender`, `IGNORED_SENDER_LOCALPARTS`,
`tests/test_match_keyword.py`): e-mails cujo **local-part** do remetente está na lista
(hoje `postmaster`) — NDR/bounce/aviso de servidor (ex.: "Undeliverable: …") — viram
`ignorado` **sem baixar nem extrair**, e o filtro roda **antes** do match de keyword (no loop
de `run_reader`), então vale **mesmo que o assunto case uma palavra-chave**. Motivo: um aviso
de não-entrega frequentemente cita o corpo da cobrança original (com valor), e sem esse filtro
o pipeline criava uma conta a pagar **falsa** a partir do bounce. Match por local-part
(case-insensitive, qualquer domínio); a lista é um `set` extensível. O registro `ignorado` é
compartilhado com o filtro de assunto via `_register_ignored`.

Lista padrão em `KEYWORDS_DEFAULT`, **sobrescrita por `EMAIL_KEYWORDS` no `.env`** (fonte de
verdade usada hoje). **NF-e "pura"** (`subject_is_pure_nfe`): assunto com `nota fiscal/nfe/
nf-e/nfse/nfs-e` **por palavra inteira** (não casa "co**nfe**cções") e **sem** indício de
pagável (`boleto/fatura/vencimento/`acrônimos…) que **não** gera conta a pagar vira
`ignorado` em vez de `falha` — notificação fiscal não é conta a pagar.

**Notificações → `ignorado`** (`subject_is_ignorable_notification`, `tests/test_match_keyword.py`):
e-mails de aviso/confirmação **sem anexo e sem conta no corpo** (gatilho no lugar do antigo
`falha`) viram `ignorado`. Termos: palavra inteira `nfe, nf-e, informe, sieg`; frases
`informativo, confirmado (o) pagamento, confirmação de/do pagamento, pagamento confirmado,
pagamento processado, aviso de vencimento, título a vencer, lembrete de vencimento, títulos
próximos do vencimento, comprovante de pix, protesto, protestado, cartório, comunicado`.
Avisos sem termo generalizável (oferta de frete, "nova área do cliente", "taxa de
agendamento") são marcados por **Message-ID** em `EXPLICIT_IGNORE_IDS`
(`scripts/reprocess_ignored_emails.py`). **Não** há exclusão por boleto/fatura aqui — o
gatilho já exige ausência de anexo/conta (sem anexo nem dado no corpo ⇒ é só um aviso); com
anexo, o PDF vira `pendente` (revisão), nunca `ignorado`. Reprocesso histórico (e Message-IDs
avulsos marcados à mão, ex.: alerta de protesto SPC/Serasa) via
`scripts/reprocess_ignored_emails.py`. **SIEG** (atualizado 2026-06-17): avisos/confirmações
da SIEG **sem pagável** (ex.: "identificamos o pagamento", NF-e) seguem `ignorado`; já as
**faturas SIEG** (mensalidade R$ 426,80, link JS quebrado — ver A1) **geram conta `recebido`
pelo corpo** (fornecedor SIEG, valor, vencimento). O `bill=NNN` do link SIEG
(`_BODY_SIEG_BILL_RE`) vira `invoice_number` (`sieg_<bill>`), fazendo os dois lembretes
("Vencimento Próximo" + "Hoje") da mesma fatura **deduplicarem** (antes geravam 2 contas/mês
porque o nº saía de data relativa e divergia). Isso **revoga** a regra anterior de manter
faturas SIEG em `ignorado`; o handler A1 (baixar o boleto real) segue como melhoria futura.

### Frontend — rotas e serviços

| Rota | Componente | Tabela |
|---|---|---|
| `/emails` | `Emails.tsx` | `email_control` + `financial_account_control` por `message_id` |
| `/consulta` | `Consulta.tsx` | `financial_account_control` (paginado, filtros, CSV client-side) |
| `/erros` | `Erros.tsx` | `email_processing_errors` |
| `/cobranca/envios` | `cobranca/CobrancaEnvios.tsx` | `cobranca_envios_log` (ver "Pipeline de cobrança de vencidos") |
| `/cobranca/erros` | `cobranca/CobrancaErros.tsx` | `cobranca_erros_log` |

- `services/supabase.ts` — fetch direto REST, `Prefer: count=exact` + `Content-Range` para paginação.
  O total é parseado por `parsePaginationTotal` (resiliente): quando o PostgREST devolve a contagem
  indisponível (`*/*` ou `0-19/*`), **não zera** — estima `offset + itens + (página cheia ? pageSize : 0)`
  e marca `totalIsEstimate` em `Paginated<T>` (evita prender o usuário na página 1). `Consulta.tsx`
  trata a estimativa de forma transparente (sem mudança visual no footer).
- `services/emailReader.ts` — leitura IMAP **assíncrona com progresso** (proxy Vite → Flask):
  `startEmailRead` faz `POST /api/emails/read/start` (Flask dispara `run_reader` numa **thread**
  e responde na hora) e `getEmailReadProgress` faz `GET /api/emails/progress`. `Emails.handleRead`
  faz **poll a cada ~1,5s** mostrando um banner com fase + barra `done/total` + contadores +
  cronômetro (`elapsed`), e recarrega KPIs/tabela a cada ~5 polls. **Por que assíncrono:** o
  modelo síncrono antigo segurava um request por minutos — o proxy derrubava a conexão e o botão
  "voltava" antes do fim (parecia travado). `run_reader(on_progress=...)` é a fonte do progresso
  (callback best-effort, não derruba o run); o estado vive em `server/app.py` (dict + lock, **um
  job por vez**). O `POST /api/emails/read` síncrono permanece só para a ponte da Next API.
  **Reconexão ao job (não regredir):** o poll vive em `trackJob` (idempotente via `trackingRef`),
  reusado por `handleRead` **e** por um efeito no mount que consulta `GET /progress` e, se houver
  job **rodando**, retoma banner + poll. Sem isso, atualizar a aba no meio do processamento perdia
  o estado e o botão parecia "pronto" enquanto o backend seguia registrando (total subia a cada
  refresh). O card **"Total de e-mails"** (sub-rótulo "na caixa de entradas") = contagem de
  `email_control`, que converge para o total do INBOX **quando o job termina** (não antes).
  **`/consulta` reusa o mesmo motor:** o botão **"Atualizar"** (topo direito) dispara
  `startEmailRead({ days: 7 })` + poll de progresso (mesmo padrão: banner `info` "Buscando
  e-mails dos últimos 7 dias…", recarrega o grid ao vivo a cada ~5 polls e no `finally`, e
  suspende/retoma o logout por inatividade) — assim traz e-mails novos **sem abrir `/emails`**.
  O **label permanece "Atualizar"** (só ganha spinner + disabled enquanto processa); a guarda
  `readingRef` evita disparos concorrentes. Não há reconexão ao job aqui (escopo do `/emails`).
- **Busca textual com debounce (form vs. aplicado) — padrão em `/consulta` e `/emails`:** o input de
  busca escreve num estado de **formulário** (`f.supplier` / `senderInput`), separado do valor
  **aplicado** que dispara o fetch (`applied.supplier` / `filters.sender`). Um `useEffect` com debounce
  de **350ms** e `cleanup` (`clearTimeout`) commita form→aplicado — **fonte única, sem `ref`** — com
  guarda `if (form === aplicado) return` (cobre o mount). Enter/Buscar commitam na hora; o `cleanup`
  cancela o timeout pendente quando o aplicado muda por outra via (Enter, card, limpar), eliminando a
  corrida em que um debounce antigo sobrescreveria o valor recém-aplicado. Isso evita o refetch a cada
  tecla (antes `/emails` recarregava por caractere porque `load` dependia de `filters` inteiro).
- **Fornecedor vem do JOIN com `supplier` (migrations 040/041/042):** `financial_account_control`
  não guarda mais nome/CNPJ/CPF — só a FK `sk_supplier` (surrogate key snowflake).
  `getFinancialAccountControl` e `getAccountsByMessageId` usam
  `select=*,supplier(trade_name,legal_name,cnpj,cpf)`; o grid, o card de detalhe e a exportação CSV
  exibem `r.supplier?.trade_name ?? r.supplier?.legal_name` e `r.supplier?.cnpj ?? r.supplier?.cpf`.
  As colunas "Fornecedor" e "CNPJ/CPF" **não são ordenáveis** server-side (order por recurso embutido
  no PostgREST é frágil). A **busca por fornecedor** resolve antes os `sk_supplier` que casam o termo
  na tabela `supplier` (nome/CNPJ/CPF + 4 e-mails, via `findSupplierIdsByTerm`) e filtra
  `sk_supplier=in.(...)` — o `applyFinancialFilters` casa ainda `invoice_number`/`subject`/
  `sender_email`, que são colunas próprias da conta.
- **`/consulta` — `cancelado` oculto por padrão (consistência grid ↔ KPIs):** `applyFinancialFilters`
  aplica `status=neq.cancelado` quando **não** há filtro de situação. `getFinancialStats` usa o
  **mesmo** filtro, então o rodapé "N registros", o KPI "Total de registros", o "Valor total" e
  "Vencidas" batem com o grid — contas canceladas só aparecem se o usuário escolher `cancelado`
  no filtro de situação (que sobrescreve o `neq`). Ao criar nova query/KPI sobre
  `financial_account_control`, replicar esse padrão para não divergir.
- **Grid compartilhado sobre TanStack Table v8** (`organisms/DataGrid.tsx`): `/consulta` (tema
  `default`) e `/emails` (tema `silver`) usam o mesmo grid, com as colunas de `useGridColumns.ts`
  (`getConsultaColumns` / `getEmailColumns`). O TanStack é **headless**: fornece row model (core),
  header groups e os estados de layout. A interface pública `DataGridProps<T>` é retrocompatível —
  features novas são **opt-in** via props.
  - **Sort, filtro e paginação seguem SERVER-SIDE** (Supabase): `manualSorting` ligado, sort via
    `onSort`/`sortCol`/`sortDir`, filtros e paginação nas páginas. **Nunca** ligar
    `getSortedRowModel`/`getFilteredRowModel`/`getPaginationRowModel` nem virtualização: o grid só
    recebe a página atual (~20 linhas), então esses modelos client-side agiriam sobre um subconjunto
    = bug. Virtualização fica como opção futura **se** migrar para scroll infinito/páginas grandes.
  - **Camadas responsivas** (própria, não do TanStack): (1) breakpoint pela largura **real do
    container** (`useContainerBreakpoint`/`ResizeObserver`) oculta `hideOn` e desce `secondLine`
    para a sub-linha; (2) truncagem (`truncate`) com `title`; (3) rolagem horizontal no viewport.
    **Visibilidade efetiva = (usuário não ocultou via menu) E (breakpoint não escondeu).**
    `getVisibleLeafColumns()` já exclui as ocultas pelo usuário; o filtro de breakpoint vem por cima.
  - **Gestão de colunas (opt-in `enableColumnManagement` + `gridId`)**: `GridToolbar` expõe
    mostrar/ocultar e **fixar** colunas (`ColumnVisibilityMenu`), **densidade** (confortável/compacto),
    **restaurar layout**; **redimensionar** (resize handle) e **reordenar por arraste** (@dnd-kit nos
    cabeçalhos — grip separado do clique de ordenação e da alça de resize). Layout persiste em
    `localStorage` por `gridId` (`useGridPreferences`). Nesse modo a `<table>` vira `table-fixed` com
    larguras de `column.getSize()` (default 160 ou `ColumnDef.size`) e `width = getTotalSize()` — daí
    o **cabeçalho fixo** (`maxBodyHeight` cria viewport rolável) e a **fixação** (sticky + offset via
    `column.getStart/ getAfter`) funcionarem; sem gestão, mantém o layout `w-full` antigo.
  - **Seleção múltipla (opt-in `enableSelection`)**: coluna de checkbox (`SelectCheckbox`, sempre 1ª e
    fixada à esquerda) + barra de ações com **"Exportar selecionadas"** (`onExportSelected` — em
    `/consulta` reusa o `exportCsv`) e **alteração de situação em lote** (`bulkStatusOptions` +
    `onBulkStatusChange` → select de situação + botão **"Aplicar"**; em `/consulta` chama
    `setFinancialAccountStatusBulk` (PATCH com filtro `id=in.(…)`, uma requisição) + update otimista
    das linhas e `refreshStats()` dos KPIs). A coluna de seleção (`__select__`) é injetada na
    ordem/fixação efetivas mas **nunca** gravada nas preferências (que ficam data-only) — evita
    duplicar o id. `/emails` **não** liga seleção (sem ação em lote de e-mail).
  - **Render das células sem `flexRender`**: o renderer do `cell` é chamado direto (helper
    `cellValue`) para preservar o **valor cru** (string) que o `title` da truncagem exige — `flexRender`
    o envolveria num componente. Não regredir.
  A **sidebar** (`Layout.tsx`) colapsa em drawer com hambúrguer abaixo de `lg`; em `lg+` é estática.
  Dependências do grid: `@tanstack/react-table`, `@dnd-kit/core|sortable|modifiers`.

### Build e code-splitting (`frontend-vite`)

- **Rotas lazy** (`App.tsx`): só `LoginPage` entra no bundle inicial; as três telas de
  dados (`Emails`/`Consulta`/`Erros`) e os fluxos de auth secundários (`Forgot`/`Reset`)
  são `React.lazy` + `Suspense` (fallback "Carregando…"; um `Suspense` interno mantém o
  `Layout`/sidebar visível enquanto a página carrega). **Toda rota/página nova segue esse
  padrão** `lazy(() => import(...))`.
- **`manualChunks`** (`vite.config.ts`): `react-vendor` (react/-dom/router) e `supabase`
  (SDK) em chunks próprios — melhora cache e download paralelo e elimina o aviso `>500 kB`
  do Vite. O código de cada rota lazy vira um chunk à parte automaticamente. **No Vite 8
  (Rolldown) o `manualChunks` é uma FUNÇÃO** (o objeto não é mais aceito) — um regex casa os
  pacotes exatos por segmento de `node_modules` (não pega `react-hook-form`/`lucide-react`/
  `@tanstack/react-table`). O `vite.config.ts` também tem `resolve.dedupe: ['react','react-dom']`
  para garantir uma única cópia do React (hoje **defensivo** — `npm ls react` confirma o
  monorepo unificado em react@19.2.7; mantido contra um futuro transitivo react@18).
- **Resolução de `paths` do tsconfig é NATIVA do Vite 8** (`resolve.tsconfigPaths: true`) — o
  plugin `vite-tsconfig-paths` foi **removido** (era redundante e pesava no build, alerta
  `PLUGIN_TIMINGS` do Rolldown; o build caiu ~3.1s→1.3s). Os aliases `@/` e `@shared/` saem do
  `tsconfig.json`. **Não reintroduzir** o plugin.
- **`skipLibCheck: true` é obrigatório** nos 4 `tsconfig.json`: sem ele o `typecheck` quebra
  com erros de tipos de **terceiros** não acionáveis — `@supabase/auth-js` (`webauthn.dom.d.ts`),
  `@tanstack/table-core` (`ColumnMeta`) e os `.next/types/*` gerados pelo Next. Testado na
  auditoria pós-upgrade (2026-06-19); **não remover**.

## Banco de dados (Supabase)

Migrations em `supabase/migrations/`, aplicadas **manualmente no SQL Editor** em ordem
numérica (`001` → `046`). Não há migration automática. (A `046` corrige a **ordem de resolução de
fornecedor** — nome antes do e-mail; e-mail só sem nome — e bloqueia e-mails de domínio interno
(`otimotex.com.br`/`lebianco.com.br`) em `supplier`; ver "Auto-resolução de fornecedor". A `045`
adiciona `supplier.deleted_at`
+ índice parcial — soft delete do CRUD de fornecedores, ver "CRUD de fornecedores (Next API)".
A `037` cria as tabelas de log da
cobrança de vencidos — ver "Pipeline de cobrança de vencidos". A `040` cria a RPC
`resolve_supplier_for_account`; a `041` dropa o trigger de resolução, a RPC
`financial_dup_by_name` e as colunas `supplier_name`/`supplier_cnpj`/`supplier_cpf`. A `042`
introduz a **surrogate key snowflake** `sk_supplier`: vira a PK auto-incremental de `supplier`
e o alvo de toda FK; `supplier_id` passa a chave de negócio (NOT NULL UNIQUE, só em `supplier`);
`financial_account_control.supplier_id` é substituída por `sk_supplier` — **ver "Auto-resolução
de fornecedor"**. A `043` adiciona os tipos `conta de água`/`conta de luz`/`conta de telefone /
internet` ao CHECK de `document_type` e faz backfill — ver "Normalização de `document_type`".)

| Tabela | Propósito |
|---|---|
| `email_control` | Dedup/controle. `status` ∈ (`extraído`, `recebido`, `pendente`, `falha`, `ignorado`, `duplicidade`) — **migrations 022/031**. `extraído`=PDF extraído (CSV gerado); `recebido`=sem PDF, conta via corpo; `pendente`=PDF salvo sem CSV (substitui `baixado`); `falha`=casou keyword mas sem PDF e sem conta no corpo; `ignorado`=não-financeiro (sem keyword) **ou NF-e pura sem conta a pagar** (`subject_is_pure_nfe`); `duplicidade`=pagável do corpo duplica conta já registrada por outro e-mail (**migration 031**; card/filtro próprios em `/emails`). O status é calculado em `process_message` pelo resultado real (conta/CSV/corpo/duplicata), não por `pdf_extracted` |
| `financial_account_control` | Tabela principal de contas a pagar — uma linha por documento; alimentada pelo pipeline de e-mail **e** por CRUD manual (baixas, consolidações, dashboards). Substitui a antiga `financial_emails` (dropada na migration 020). O fornecedor é referenciado **só pela FK `sk_supplier`** (surrogate key snowflake, NOT NULL — **migration 042**, antes era `supplier_id`) — nome/CNPJ vêm do JOIN com `supplier` (colunas denormalizadas dropadas na **migration 041**). Tem `sender_email` (migration 023; backfill em 025) usado na resolução p/ alinhar `supplier.email`, e `subject` (migration 025) — exibidos/buscados em `/consulta` |
| `email_processing_errors` | Log de falhas com `raw_payload` JSON |
| `supplier` | Fornecedores. PK = `sk_supplier` (surrogate key snowflake auto-incremental — **migration 042**); `supplier_id` é **chave de negócio** (NOT NULL UNIQUE, só nesta tabela; = `sk_supplier` nos fornecedores criados pela extração, via trigger de espelho `trg_supplier_mirror_id`, podendo divergir em cargas externas). Auto-criados pelo trigger de resolução, mas **cadastro PRESERVADO** (curadoria manual de `email`/`email2`/`email3`/`email4`) — **nunca truncar** em limpezas (ver "Limpeza / reset de dados"). Reconhecimento por **e-mail** em `email`/`email2`/`email3`/`email4` (migrations 023/027/028) — ver "Auto-resolução de fornecedor". **Soft delete** via `deleted_at` (migration 045) — a baixa pelo CRUD da Next API marca `deleted_at` (nunca hard delete) e é bloqueada quando há contas vinculadas; ver "CRUD de fornecedores (Next API)" |
| `company` | Empresa pagadora (**cadastro**, tem campo `email`). Auto-resolvida pelo trigger `resolve_company_id` a partir de `payer_cnpj`/`payer_name`. **Preservada em limpezas** (ver abaixo) |
| `status` | **Dimensão** de situação (`status_id`, `status_name`, `status_short_name`, `has_opened`/`has_closed`/`has_invoiced`). 10 linhas = domínio de `financial_account_control.status`. A trigger resolve `financial_account_control.status_id` por `status_name` (migration 035). **Cadastro/configuração — preservar em limpezas** |
| `cobranca_envios_log` | Cobranças de vencidos **enviadas com sucesso** (migration 037). `document_id` (= TÍTULO no Firebird) **UNIQUE** = chave de deduplicação: `already_sent()` consulta aqui antes de enviar. Exibida em `/cobranca/envios`. Alvo de limpeza (dados de teste) |
| `cobranca_erros_log` | **Falhas** da cobrança (migration 037), **sem UNIQUE** (reprocessável — o mesmo título pode falhar em execuções distintas). `error_type` ∈ (`email_ausente`, `email_invalido`, `smtp_falha`, `smtp_bloqueio`, `supabase_falha`, `firebird_falha`, `erro_inesperado`); `error_message` = motivo em linguagem leiga (exibido em `/cobranca/erros`), `error_detail` = traceback técnico. Alvo de limpeza |

**Características físicas de `supplier`** (tabela pré-existente, **não criada por migration**;
introspecção em 2026-06-23): colunas `sk_supplier` (PK, bigint), `supplier_id` (bigint, chave de
negócio), `cnpj CHAR(14)`, `cpf CHAR(11)`, `legal_name`, `trade_name`, `email`/`email2`/`email3`/
`email4`. CHECK `chk_supplier_has_identifier` (ao menos um de cnpj/cpf/legal_name/trade_name).
Índices GIN trigram nos 4 e-mails (migration 029); RLS `authenticated_select_supplier`.
- **Estado original (pré-042):** `supplier_id` era **`GENERATED ALWAYS AS IDENTITY`**
  (`pg_attribute.attidentity = 'a'`), backed por `supplier_supplier_id_seq`; PK `supplier_pkey`.
- **Pós-042:** a `042` faz `DROP IDENTITY` em `supplier_id` (remove a `supplier_supplier_id_seq`
  junto) e cria uma **sequence nova** `supplier_sk_supplier_seq` (semeada em `max(sk_supplier)+1`)
  como `DEFAULT` de `sk_supplier`; a PK `supplier_pkey` passa a ser `(sk_supplier)`; `supplier_id`
  vira `NOT NULL UNIQUE` (`uq_supplier_supplier_id`), gravado pelo trigger de espelho
  `trg_supplier_mirror_id` quando o INSERT não o informa.

`financial_account_control.status` é a **coluna única de situação/ciclo de vida** (migration
**034** fundiu o antigo `due_status` aqui). Default `pendente`; domínio pt-BR de **10 valores**
(migration **035** alinhou o CHECK à tabela de dimensão `status` — removeu `pago protesto`,
`pago cartório`, `não pago`): `pendente, vencido, a vencer, prorrogado, baixado, protestado,
cartório, pago, cancelado, falha`. A coluna **`status_id`** (smallint, FK `fk_fac_status` →
`status.status_id`) é mantida em sincronia pela mesma trigger, que resolve
`status_id = status.status_id WHERE status_name = status` (035). A trigger
**`fn_set_status_from_due_date`** (`trg_fe_status_vencimento`, BEFORE INSERT/UPDATE) grava
`'a vencer'`/`'vencido'` a partir de `due_date` **apenas quando o status está em aberto**
(`NULL`/`pendente`/`a vencer`/`vencido`) — preserva `falha` (extração) e baixas/CRUD manual
(`pago`/`baixado`/`cancelado`/`prorrogado`/…). Antes da 034 havia `due_status` separado e o
grid mostrava `due_status` enquanto o filtro filtrava `status` (inconsistente); agora ambos
usam `status`. `payment_method` aceita `boleto, pix, ted, cartão, depósito, duplicata,
bancário, carteira, vale, crédito, débito, dinheiro, transferência, cheque, outro`;
`extraction_source` ∈ (`email_body, pdf_text, pdf_vision, falha`).

**Schemas Zod (`packages/shared`) = fonte única de tipos.** **Zod 4** (upgrade Fase 5):
e-mail usa a API top-level `z.email('…')` (não mais `z.string().email()`); demais APIs
(`z.enum`, `.refine`, `z.coerce.number`, `.default`, `.safeParse`, `error.issues`)
inalteradas. O `zodResolver` vem do `@hookform/resolvers@5` (Standard Schema, compatível
com Zod 4). Os tipos TS são `z.infer` dos
schemas (não há tipo escrito à mão para divergir); os `z.enum` espelham 1:1 os CHECK do
banco — ao alterar um CHECK, **atualizar o enum correspondente**. `status` usa
`ACCOUNT_STATUSES` (domínio completo de 10 valores — migration 035 removeu `pago protesto`, `pago cartório`, `não pago`) — a trigger grava `'a vencer'/'vencido'`
e baixas/CRUD manual definem os demais (`pago`/`baixado`/`cancelado`/…).
O frontend consome os schemas de dados (`FinancialAccountControl`, `EmailControl`,
`ProcessingError`) **apenas como `import type`** (sem `.parse()` em runtime — `services/supabase.ts`
faz cast); só os schemas de **auth** rodam em runtime via `zodResolver`.

**Fornecedor no schema (migrations 040/041/042):** `financialAccountControlSchema` **não** tem mais
`supplier_name`/`supplier_cnpj`/`supplier_cpf` — só `sk_supplier` (`z.number().int()`, NOT NULL — a
FK surrogate; `supplier_id` ficou só na tabela `supplier`) e um recurso embutido opcional `supplier`
(`supplierEmbeddedSchema`: `trade_name`/`legal_name`/`cnpj`/`cpf`), presente quando o select inclui
`supplier(...)`. O `financialAccountControlInputSchema` **inclui `sk_supplier`** (entrada obrigatória
— o pipeline resolve via RPC, que devolve o surrogate, antes de gravar) e omite o recurso `supplier`
(leitura).

**Schema base vs. criação manual:** `amount` é `nullable` no schema base (o pipeline pode
gravar sem valor → vira erro `sem_valor`, não cria conta). A criação manual via API usa
`financialAccountControlCreateSchema` (`= ...InputSchema.extend({ amount: money.positive() })`),
que **exige valor > 0** — para o futuro `POST /api/contas`. Não relaxar o `.positive()` nesse
schema: lançar conta a pagar de R$ 0 não é válido.

RLS habilitado em todas as tabelas. Policies de leitura são `TO authenticated`
(migrations 015/018/019); escrita em `financial_account_control` é `TO service_role`
(CRUD via Next API). Toda nova tabela deve seguir o mesmo padrão. **Exceção pontual
(migration 030):** `email_control` tem policy de UPDATE `TO authenticated`, mas com
**grant restrito à coluna** `reviewed_at` (`GRANT UPDATE (reviewed_at)`) — o frontend só
consegue marcar "revisado", não alterar outras colunas. `reviewed_at` é setado em `/emails`
ao abrir o card de detalhes de um e-mail com `status='falha'` (`markEmailReviewed`), exibindo
um check verde ao lado do badge de status (compartilhado entre usuários). **Exceção análoga
(migration 033):** `financial_account_control` tem policy de UPDATE `TO authenticated` com
**grant restrito às colunas** `has_invoice`/`has_bank_slip` (`GRANT UPDATE (has_invoice,
has_bank_slip)`) — flags de curadoria "Tem NF ?"/"Tem Boleto" editadas como checkbox
(`CheckToggle`) no grid de `/consulta` via `setFinancialAccountFlag` (update otimista). O
frontend não pode alterar nenhuma outra coluna; o pipeline (`service_role`) escreve a tabela
inteira.

### Limpeza / reset de dados (SEMPRE preservar os cadastros)

Ao limpar a base para uma nova busca geral, **SEMPRE preserve estas tabelas de
cadastro/configuração** — não são alimentadas pelo pipeline e nunca devem ser apagadas:

- `company`
- `status` (dimensão de situação — domínio de `status` + alvo da FK `status_id`)
- `supplier` (cadastro com curadoria manual — nome/CNPJ/CPF + `email`/`email2`/`email3`/`email4` são a **fonte da busca por fornecedor em `/consulta`**, que resolve `sk_supplier` na tabela `supplier` via `findSupplierIdsByTerm`; truncá-lo destruiria os e-mails cadastrados à mão **e** quebraria a exibição/busca, já que `financial_account_control` só guarda a FK `sk_supplier`. **Atenção:** truncar `supplier` com `RESTART IDENTITY` zeraria a sequence de `sk_supplier` e desalinharia das contas — mais um motivo para nunca truncá-lo)
- `financial_account`
- `financial_bank`
- `financial_chart_of_account`
- `financial_chart_of_account_group`
- `financial_chart_of_account_subgroup`
- `financial_cost_center`

**Alvos da limpeza** (truncar com `RESTART IDENTITY CASCADE`): `email_control`,
`financial_account_control`, `email_processing_errors`, `audit_log` — e, para os testes da
cobrança de vencidos, `cobranca_envios_log` + `cobranca_erros_log` — mais o
bucket **`attachments`** do Storage e o cache local (`data/pdfs_inbox`, `data/csv_output`).
`supplier` **não** é mais alvo: embora seja auto-criado pelo trigger, acumula curadoria
manual (e-mails `email2`/`email3`/`email4`) que seria perdida na truncagem; no
reprocessamento o `resolve_supplier_id` reutiliza os fornecedores existentes (casa por
CNPJ/CPF/e-mail/nome) sem duplicar. A `company` e o `supplier` preservados continuam
resolvendo `company_id`/`sk_supplier` das novas contas.

> **Storage:** `DELETE` direto em `storage.objects` é bloqueado (`protect_delete`). Esvaziar
> o bucket via **Storage API** (`POST object/list/attachments` → `DELETE object/attachments`
> com `{prefixes:[…]}`), usando `SUPABASE_SERVICE_KEY` do `.env` da raiz.

## Pipeline de cobrança de vencidos (skill `cobranca-vencidos`)

Segundo pipeline do projeto — **saída** (envio), paralelo ao de entrada (leitura de e-mails).
Lê títulos vencidos no **Firebird**, monta um e-mail HTML e **envia por SMTP (Locaweb)**,
registrando sucesso/falha no Supabase. Roda por `py -3` (Task Scheduler), **independente** do
Flask/Next.

```
Firebird (VW_PSQ_FIN_REC_BAN + _004)  →  run.py  →  SMTP Locaweb (email-ssl.com.br)
   títulos vencidos (STFI='VENCIDO',          │         To: cliente · Cc: representante
   DTVC >= hoje-7)                            │
                                              ├─ dedup: already_sent() consulta cobranca_envios_log (UNIQUE document_id)
                                              ├─ sucesso → cobranca_envios_log  (+ limpa erros antigos do título)
                                              ├─ falha   → cobranca_erros_log   →  UI /cobranca/erros
                                              └─ ao fim: resumo por CC das falhas DEFINITIVAS (failure_notify)
```

**Scripts** (`skills/cobranca-vencidos/scripts/`, importados como **módulos irmãos** via
`sys.path` no próprio dir — a pasta tem hífen, inválido como pacote Python; mesmo padrão de
`server/app.py` com `read_emails`):

| Arquivo | Papel |
|---|---|
| `run.py` | Entry-point do **batch diário** (`py -3 run.py [--dry-run]`). Lê o Firebird, abre **uma `SmtpSession` por lote** e, por título, chama `send_core.send_and_log` (passando a sessão). Loop com **rede de segurança** (`_process_titulo_safe`): falha de um e-mail **nunca** trava os demais. Throttle entre envios (`COBRANCA_SEND_DELAY_SECONDS`, default 10s). **Limpa erros resolvidos:** ao enviar com sucesso (ou pular um título já enviado) que **antes tinha erro** (`fetch_error_document_ids` no início → `delete_erro_rows_by_document_id`), remove as linhas antigas dele de `cobranca_erros_log` — assim um `email_ausente` corrigido no Firebird volta ao fluxo no dia seguinte e a falha some sozinha (best-effort; vale dentro da janela `DTVC >= hoje-7`) |
| `send_core.py` | **Núcleo compartilhado** por `run.py` (batch) e `resend.py` (reenvio manual): `validate_email`, `classify_smtp_error` e `send_and_log` (render→envia→loga; sucesso→`cobranca_envios_log`, falha→`cobranca_erros_log`; **nunca propaga exceção SMTP**). Centraliza a lógica num só lugar — não duplicar entre os fluxos |
| `resend.py` | **Reenvio manual** de falhas a partir de `/cobranca/erros` (`resend_erros(ids, on_progress)`). Ver subseção "Reenvio manual" abaixo |
| `db_firebird.py` | Conexão Firebird (driver **`fdb`**, fixado em `server/requirements.txt`) + `_QUERY` (UNION das views `VW_PSQ_FIN_REC_BAN` e `_004`). Linha **sem e-mail SEGUE** o fluxo (vira `email_ausente`); só descarta linha sem `document_id` |
| `email_sender.py` | Monta e envia. **To primeiro; se o principal falhar, o Cc NÃO é enviado** (2 `sendmail` na mesma conexão). **`SmtpSession`**: conexão **reaproveitada no lote** (lazy no 1º envio; reconecta+reenvia 1× se cair). `send_cobranca` (avulso) é wrapper de compat. **Atenção:** `smtplib.SMTPException` herda de `OSError` — o catch de queda usa `(SMTPServerDisconnected, ConnectionError, TimeoutError)`, **nunca** `OSError`, para não reenviar recusa definitiva (451/5xx/auth) |
| `supabase_log.py` | `already_sent` (dedup), `log_envio_sucesso`, `log_envio_erro`, `fetch_company_smtp`, `fetch_erro_rows` (linhas de erro para o reenvio), `delete_erro_rows`/`delete_erro_rows_by_document_id`/`fetch_error_document_ids` (limpeza de resolvidos) |
| `template.py` | HTML do e-mail de cobrança (`render_html`) |
| `failure_notify.py` | **Notificação ao representante (CC)** das falhas **definitivas** (`DEFINITIVE_ERROR_TYPES` = email_ausente/email_invalido/smtp_bloqueio): `group_by_cc` (resumo por CC, ignora falha sem CC) + `render_failure_digest` (HTML com cliente/título/vencimento/valor/motivo) + `build_subject`. Só no batch (`run.py`) |

**SMTP (não óbvio — não regredir):** remetente = `company.email` (`company_id=1` =
`financeiro@otimotex.com.br`), **o mesmo mailbox do recebimento (IMAP)**. Por isso o envio
**reaproveita as credenciais IMAP** do `.env`: host → `SMTP_HOST` ou `IMAP_HOST`
(**`email-ssl.com.br`** — `smtp.locaweb.com.br` dá timeout nesta conta); senha → `SMTP_PASSWORD`
ou **`IMAP_PASS`** (senha nunca no banco); porta 587 STARTTLS. `fetch_company_smtp` só lê colunas
existentes (`email,legal_name,trade_name`) — a tabela `company` **não** tem colunas `smtp_*`.
A conexão é **reaproveitada no lote** (`SmtpSession`) — não mais uma conexão por e-mail — para
aliviar a pressão sobre o relay (`451 queue file write error`). **Migração para SMTP transacional
da Locaweb** (`smtp.locaweb.com.br`, produto de alto volume com credencial/token próprios, não a
senha do mailbox): é **só `.env`** — setar `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASSWORD`
(têm prioridade sobre os `IMAP_*` em `_load_smtp_config`), sem mudança de código.

**Classificação de falha (regra de negócio):** `smtp_falha` = **instabilidade** (timeout,
queda, 450/451/452) → o próximo run **retenta**; `smtp_bloqueio` = **negação** (auth 535, 421,
5xx, destinatário recusado) → exige **ação humana** (limite de envios / conta bloqueada na
Locaweb). `_classify_smtp_error` decide pelo código/exceção. Mensagens em `error_message` são
**leigas** (coluna "Motivo" da UI); o técnico vai em `error_detail`.

**Notificação ao representante (CC) — só batch:** ao fim do `run.py`, as falhas **definitivas**
(`DEFINITIVE_ERROR_TYPES`: email_ausente/email_invalido/smtp_bloqueio — exigem ação humana) são
agrupadas por **CC** (representante do título, `CV_EMAIL` do Firebird) e cada CC recebe **um
resumo** (`failure_notify`) com cliente/título/vencimento/valor/motivo dos seus títulos que
falharam. Transitórias (`smtp_falha`/timeout) **não** notificam (re-tentam sozinhas). Falha sem
CC não tem para quem notificar (logada). `send_and_log` retorna **`SendResult`** (status +
error_type + motivo) para o `run.py` filtrar as definitivas sem reclassificar. Envio best-effort
(falha na notificação não derruba o run) e reusa a `SmtpSession` do lote (respeita DEV_MODE). O
reenvio manual (`resend.py`) **não** notifica (o usuário já vê os erros na tela).

**`.env` (raiz):** `FB_HOST/FB_PORT/FB_DATABASE/FB_USER/FB_PASSWORD/FB_CHARSET`;
`DEV_MODE=true` + `DEV_OVERRIDE_EMAIL` (To de teste) + `DEV_OVERRIDE_CC_EMAIL` (Cc de teste);
`COBRANCA_SEND_DELAY_SECONDS` (throttle anti-bloqueio Locaweb, default 10s, `0` desliga).
Em **DEV_MODE** todos os envios vão para as caixas de teste (To→`DEV_OVERRIDE_EMAIL`,
Cc→`DEV_OVERRIDE_CC_EMAIL`); em produção, To/Cc reais do Firebird. **Em produção desde 2026-06-22
(`DEV_MODE=false`): envia para os clientes reais (To/Cc do Firebird).** As variáveis
`DEV_OVERRIDE_*` ficam **comentadas** no `.env` (desativadas) — para um teste pontual, defina
`DEV_MODE=true` e descomente ambas. Spec completa: `skills/cobranca-vencidos/references/env_reference.md`.

**Entregabilidade (DNS, fora do código):** SPF ✅ (`include:_spf.locaweb.com.br`); DMARC ⚠️
`p=none`; **DKIM ❌ a configurar** no painel Locaweb (melhora caixa-de-entrada em Gmail/Outlook).
O envio **funciona** sem DKIM (SPF já autentica); é melhoria, não pré-requisito.

**Reenvio manual de falhas (tela `/cobranca/erros`):** o usuário **seleciona** linhas de erro
(1 ou em lote) e reenvia **sem depender do Firebird** — `resend.py` (`resend_erros(ids)`)
reconstrói o e-mail a partir dos campos **já gravados** em `cobranca_erros_log` (via
`fetch_erro_rows`) e reusa `send_core.send_and_log` (mesma dedup, throttle e classificação de
erro do batch). Teto `MAX_IDS=500`; throttle `COBRANCA_SEND_DELAY_SECONDS` (default **10s** no
reenvio — ver memória `cobranca-smtp-bottleneck`) só **entre envios reais** (não após skip/
no_email nem após o último). Status por título (consumido pela UI): `sent` (enviado agora) ·
`skipped` (já em `cobranca_envios_log` — dedup, **não** reenvia) · `no_email` (sem e-mail/
inválido → novo registro de erro) · `error` (falha SMTP → novo registro).

**Endpoints Flask (assíncronos, **um job por vez** — dict + lock em `server/app.py`):**
`GET /api/cobranca/resend/health` (prontidão: `resend_ready()` checa Supabase + SMTP/IMAP +
DEV_MODE/override → a UI **desabilita o botão** quando `ready=false`, com o motivo no `title`) ·
`POST /api/cobranca/resend/start` (dispara em **thread**, responde na hora) ·
`GET /api/cobranca/resend/progress` (poll do progresso).

**Frontend:** rotas lazy `/cobranca/envios` e `/cobranca/erros` (`App.tsx`), páginas
`pages/cobranca/CobrancaEnvios.tsx` + `CobrancaErros.tsx` sobre o **`DataGrid` do projeto**
(colunas em `cobrancaColumns.ts` no `ColumnDef<T>` de `useGridColumns`, **não** o do TanStack),
serviço `services/cobrancaService.ts` (REST direto, paginado; + `startResend`/`getResendProgress`/
health do reenvio), tipos `types/cobranca.ts` (`ErrorType` + `ERROR_TYPE_LABEL` — **não** ficam
em `@sheild/shared`). O grid de `/cobranca/erros` liga **seleção** + a ação
`organisms/ResendErrosAction.tsx` (botão "Reenviar e-mails (N)" na barra de seleção;
**confirmação inline** antes de disparar — são e-mails reais; poll de progresso a cada 1,5s;
**desabilitado** quando o backend não está pronto). Sidebar: grupo **Envios**.

## Windows Task Scheduler

`scheduler/run_reader.ps1` — intervalo de 5 min (`$INTERVAL_MIN` em
`scheduler/setup-task.ps1`). Detecta Python com `pdfplumber` (ordem: `py -3.12`,
`-3.13`, `-3.11`, `-3.10`, `-3`, PATH). Logs em
`logs/scheduler/reader_YYYYMMDD.log`, retidos 30 dias. Instalação em outra
máquina: `scheduler/INSTALL.md` (setup detecta executor `pwsh.exe`/`powershell.exe`
e checa o `.env`).

Checkout de **desenvolvimento**: `C:\Sheild\Projetos\Claude\Contas a pagar\Pagamentos`
(branch `Features`, sincronizado com `main`) — clone git completo onde todo o trabalho acontece.

**Produção dos recebimentos (outra máquina):** o scheduler roda de
`C:\Sheild\API\Pagamentos`, um **deploy mínimo** (NÃO é clone git) com apenas o
necessário para o pipeline de leitura: `scheduler\` + `skills\` + `.env` + `data\` +
`logs\`. Não tem `apps\`, `server\`, `supabase\`, `packages\` nem `.git`. Como os
scripts `.ps1` usam caminhos relativos a `$PSScriptRoot`, funcionam nesse caminho sem
ajuste. **Atualizar produção = copiar manualmente** os arquivos alterados (ex.: os 2
scripts de `scheduler\`) — não há `git pull` lá. Requer Python 3.12 + `pdfplumber`
instalados na máquina. Guia: `scheduler/INSTALL.md`.

### Deploy manual do Email Reader em produção (caso específico — não regredir)

O usuário **prefere atualizar/validar a produção manualmente** (cópia de arquivos + comando
de validação), **não** pelo `scheduler/deploy-prod.ps1`. Ao orientar, dê o passo a passo
manual direto. Dois cuidados **não óbvios** ao copiar o pipeline de leitura:

- **Caminho correto = `skills\email-reader\scripts\`, NÃO `scheduler\`.** O `run_reader.ps1`
  executa `$PROJECT_ROOT\skills\email-reader\scripts\read_emails.py` (variável `$SCRIPT`).
  Copiar `read_emails.py` para `scheduler\` deixa o código **antigo** rodando.
- **São 2 arquivos INTERDEPENDENTES — copiar só um quebra a extração.** O `read_emails.py`
  novo chama `extract_pdf.extract_to_csv()` (extração **in-process**), função que só existe
  na versão nova de `extract_pdf.py`. Com o `extract_pdf.py` antigo → `AttributeError` →
  toda extração de PDF falha.

| De (dev/bundle) | Para (produção) |
|---|---|
| `skills\email-reader\scripts\read_emails.py` | `C:\Sheild\API\Pagamentos\skills\email-reader\scripts\read_emails.py` |
| `skills\pdf-contas-pagar\scripts\extract_pdf.py` | `C:\Sheild\API\Pagamentos\skills\pdf-contas-pagar\scripts\extract_pdf.py` |

Validar (com o Python que o scheduler usa) — esperado `True True`:

```powershell
cd C:\Sheild\API\Pagamentos
py -3 -c "import sys; sys.path.insert(0,'skills/email-reader/scripts'); import read_emails; print('subprocess' not in dir(read_emails), hasattr(read_emails,'is_ignored_sender'))"
```

**Não precisa reiniciar nada**: a tarefa agendada inicia um processo novo a cada execução e
lê os arquivos do disco. Nenhuma dependência nova (as libs de extração já estavam instaladas,
pois o subprocesso antigo usava o mesmo Python).

### Deploy manual da Cobrança de vencidos (envios) em produção (caso específico — não regredir)

Mesma máquina/pasta dos recebimentos (`C:\Sheild\API\Pagamentos`); o scheduler de **envios**
executa `skills\cobranca-vencidos\scripts\run.py` (`run_cobranca.ps1` `$SCRIPT`).

> **PREFERÊNCIA DO USUÁRIO (não regredir):** atualização de produção é **cópia manual dos
> arquivos + validação manual** — **NÃO** propor nem usar scripts de deploy (o `scheduler\
> deploy-prod.ps1` existe, mas o usuário NÃO quer usá-lo; só executar se ele pedir
> explicitamente). Fluxo preferido: (1) backup do que será sobrescrito; (2) copiar os arquivos
> `.py` alterados; (3) validar com `Select-String` (confirmar que o código novo chegou) +
> `import ...` + `run.py --dry-run`. Mesmos cuidados do reader:

**O QUE COPIAR para produção (regra geral — vale p/ reader e cobrança):**

| Mudou… | Copiar | Re-registrar tarefa? |
|---|---|---|
| **Lógica do pipeline** (`.py` em `skills\…\scripts\`) | os `.py` alterados (conjunto interdependente) | Não |
| **Wrapper/agendador funcional** (`.ps1` em `scheduler\` — horário, timeout, runner) | o `.ps1` alterado | Só se mudou `setup-*.ps1` (rodar como Admin) |
| **Só comentário/doc** (`.ps1`/`.md` sem efeito funcional) | nada | Não |

> Cada **caso de atualização** (esta sessão, p.ex.) deve dizer explicitamente de quais pastas
> copiar. Ex.: mudança que mexe só em `skills\cobranca-vencidos\scripts\` **não** exige tocar em
> `scheduler\`. A tarefa agendada lê o disco a cada execução — nunca precisa "reiniciar".

- **Caminho correto = `skills\cobranca-vencidos\scripts\`, NÃO `scheduler\`.**
- **7 scripts INTERDEPENDENTES — copiar só um quebra.** `run.py` (batch) **e** `resend.py`
  (reenvio) dependem de **`send_core.py`** (`from send_core import send_and_log, validate_email`
  — dependência **nova** do `run.py`); `send_core.py` → `email_sender`/`supabase_log`/`template`.
  Copiar `run.py`/`resend.py` sem `send_core.py` → `ImportError`. **Na dúvida, copie o conjunto
  inteiro**: `db_firebird.py`, `email_sender.py`, `resend.py`, `run.py`, `send_core.py`,
  `supabase_log.py`, `template.py`.
- **Pré-requisitos da máquina (diferente do reader):** driver Firebird **`fdb`** (fallback
  `firebirdsql`) instalado; `.env` com **`FB_HOST/FB_PORT/FB_DATABASE/FB_USER/FB_PASSWORD/
  FB_CHARSET`** (Firebird) + SMTP (reusa `IMAP_*` quando `SMTP_*` ausente; host
  `email-ssl.com.br`) + `COBRANCA_SEND_DELAY_SECONDS` (throttle, **10s** em produção — ver
  `cobranca-smtp-bottleneck`) + `DEV_MODE`/`DEV_OVERRIDE_EMAIL`/`DEV_OVERRIDE_CC_EMAIL`.

Validar (esperado: `imports OK`):

```powershell
cd C:\Sheild\API\Pagamentos
py -3 -c "import sys; sys.path.insert(0,'skills/cobranca-vencidos/scripts'); import send_core, run, resend; print('imports OK')"
```

Ou melhor — `py -3 skills\cobranca-vencidos\scripts\run.py --dry-run` valida imports **e** a
conexão Firebird **sem enviar e-mail**. **Não precisa reiniciar nada** (a tarefa inicia processo
novo). A cobrança está **em produção** (`DEV_MODE=false` — envia para clientes reais); ainda
assim, rode um `--dry-run` após alterar o pipeline antes de confiar na próxima execução real.

