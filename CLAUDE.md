# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é este projeto

`pagamentos` é um **pipeline financeiro de contas a pagar**, não um app CRUD comum.
O fluxo central é: e-mail (IMAP) → download de PDF → extração via Claude API →
gravação no Supabase → consulta/exportação pela interface web.

> **Arquitetura: monorepo Sheild com backend híbrido.** Desde a reestruturação de
> 2026-06-09, o projeto adota o monorepo `apps/* + packages/shared` (npm workspaces),
> mas o backend é **híbrido** — pontos onde ainda diverge do padrão genérico:
> - **Pipeline Python permanece** (`server/` Flask + `skills/`): IMAP, extração de PDF
>   (Claude Vision via base64 + pdfplumber). Não há equivalente TS viável; é o coração
>   do sistema e não foi reescrito.
> - **`apps/api-backend`** (Next.js 16 + TypeScript, porta 3000) é a camada nova de
>   dados/CRUD. Aciona o pipeline Python via **ponte HTTP** (`lib/python-bridge.ts` →
>   Flask), não por subprocess.
> - **`apps/frontend-vite`** (React 18 + Vite, porta 5173) é o app interno, agora
>   **100% TypeScript** (`.tsx/.ts`), **sem shadcn/ui**. Continua lendo o Supabase via
>   **REST direto com `fetch`** (`src/services/supabase.ts`); só a sessão de auth usa o
>   SDK oficial (`src/lib/supabaseClient.ts`).
> - **`apps/portal-next`** (Next.js 16 + Tailwind v4, porta 3002) é o portal público
>   (scaffold).
> - **`packages/shared`** (`@sheild/shared`) — schemas Zod, fonte de verdade de tipos
>   entre frontends e API.
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
  (paleta no `tailwind.config.ts`).
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
  `npm run test --workspace=apps/<app>`.
- **Suíte Python (pytest):** `py -3 -m pytest tests/` (ex.: `test_link_extraction.py`,
  `test_email_body_extraction.py`, `test_body_amount.py`, `test_extract_pdf.py`). Cobre o
  pipeline de extração; rodar após mexer em `read_emails.py`/`extract_pdf.py` ou nos
  scripts de reprocessamento. Não é incluída no `npm test`.
- Referência de granularidade: `frontend-vite/src/components/StatusBadge.test.tsx`,
  `ExpandableText.test.tsx`, `organisms/LoginForm.test.tsx`.
- **Follow-up:** `apps/portal-next` ainda sem testes — bloqueado pelo conflito de duas
  versões do React no monorepo (18 em frontend-vite hoisted vs 19 nos apps Next).
  Resolver alinhando versões ou com setup de teste dedicado.

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
Service → Route, conforme `monorepo-crud-spec.md`). A exceção aceita: `POST /api/emails/read`
usa POST + corpo de parâmetros porque é uma **ação de disparo**, não um recurso CRUD.

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
  (cobre `frontend-vite`, `api-backend`, `portal-next` — cada um com seu `eslint.config.mjs`).
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
- **ts-prune (dead code / exports órfãos)**: `npm run prune` na raiz roda nos 3 workspaces
  e **deve reportar 0**. `ts-prune` está declarado só em `frontend-vite` (resolvido por
  hoist nos apps Next). Os apps Next ignoram os defaults do framework via
  `--ignore "next.config|...|app.*(page|layout|route)"`. Export público intencional **sem
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
  são isentos pela 1.4.3).
- **Testes a11y automatizados (jest-axe, AA)**: matcher em `tests/setup.ts`
  (`expect.extend(toHaveNoViolations)`); runner configurado em `tests/axe.ts` (tags
  `wcag2a/2aa/21a/21aa`). Todo componente/página relevante ganha um `*.a11y.test.tsx` com
  `expect(await axe(container)).toHaveNoViolations()`. Páginas com serviços mockam os
  serviços (ver `pages/Consulta.a11y.test.tsx`, `pages/Emails.a11y.test.tsx`).
- **Contraste é travado por teste** em `tests/contrast.a11y.test.ts`: lê os tokens reais do
  `tailwind.config.ts` e falha se algum par cair abaixo do mínimo AA. Cobre a lacuna do axe
  em **jsdom**, que **não avalia `color-contrast`** (regra desligada em `tests/axe.ts`).
- **Limitação conhecida (follow-up)**: contraste sob render real só por axe em navegador
  (Lighthouse/Playwright). O Lighthouse roda em Chrome e pega o que o jsdom não pega
  (contraste real, ordem de foco, autofill) — usar para auditoria periódica.

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

Monorepo (npm workspaces): `apps/frontend-vite` (SPA interno, React 18/TS, :5173),
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
      │                                        │ POST /api/emails/read
      │                                        ▼  (proxy /api → Flask :8000)
read_emails.run_reader() ◄───────── server/app.py (Flask, porta 8000)
      │                                        ▲
      │ por e-mail:                            │ ponte HTTP (lib/python-bridge.ts)
      │  1. deduplica via email_control.message_id (UNIQUE) — pula já vistos
      │  2. SEM keyword no assunto → registra como 'ignorado' (sem baixar/extrair)
      │  3. COM keyword → salva PDF em data/pdfs_inbox/  apps/api-backend (:3000)
      │  4. subprocess → extract_pdf.py (Claude API: pdf_text ou pdf_vision)
      │  5. UPSERT em email_control  +  fallback CSV em data/csv_output/
      ▼
Supabase (PostgreSQL)  ── financial_account_control (dados extraídos)
                       ├─ email_control     (controle/dedup)
                       ├─ email_processing_errors (log de falhas)
                       └─ supplier          (fornecedores auto-criados)
```

> **Topologia de portas (dev):** o frontend (`:5173`) chama o Flask (`:8000`) **direto**
> via proxy `/api` para a leitura de e-mails. A Next API (`:3000`) é camada de dados
> independente (CRUD futuro) e expõe a mesma ponte ao Flask; não intercepta o caminho
> atual do frontend.

## Comandos

Dependências dos apps: `npm install` na **raiz** (workspaces — lockfile único).

```powershell
# Tudo de uma vez: Flask (:8000) + os 3 apps Node (vite :5173, api :3000, portal :3002)
npm run dev            # via concurrently — substitui os comandos abaixo

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

Extração isolada:

```powershell
py -3 skills\pdf-contas-pagar\scripts\extract_pdf.py --input data\pdfs_inbox\ --output data\csv_output\ --batch
```

Dependências:

```powershell
pip install pdfplumber pypdf anthropic pandas python-dotenv Pillow flask
npm install   # na raiz do monorepo — instala todos os workspaces
```

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
│   └── GradientPillButton.tsx # (gradient) botão pill com bg-gradient-auth
├── molecules/
│   ├── SocialLinksBar.tsx     # (v2) círculos Otimotex/Lebianco/WhatsApp
│   ├── AuthHeroHeader.tsx     # (gradient) header decorativo com círculos sobrepostos
│   └── InlineMessage.tsx      # (gradient) banner sucesso/erro — nunca alert()
├── organisms/
│   ├── LoginForm.tsx          # (v2) estado + validação + supabase.auth.signInWithPassword
│   ├── ForgotPasswordForm.tsx # (gradient) resetPasswordForEmail + mensagem genérica
│   ├── ResetPasswordForm.tsx  # (gradient) updateUser + signOut + redirect
│   ├── DataGrid.tsx           # grid responsivo genérico (+ DataGrid.test.tsx); tema via cva
│   └── dataGrid.variants.ts   # cva por slot (header/row/cell/skeleton/empty/…) tema default|silver
├── AuthLayout.tsx             # (gradient) wrapper full-page para Forgot/Reset
├── AttachmentViewer.tsx       # visualizador de PDF (signed URL do Storage) em iframe/modal
├── Layout.tsx (+ Layout.test.tsx)   # sidebar; navLink = cva local (estado active)
├── ProtectedRoute.tsx
├── StatusBadge.tsx (+ StatusBadge.test.tsx)   # componente; variantes em statusBadge.variants.ts
├── statusBadge.variants.ts    # cva(badgeVariants) + resolveBadge + mapas de tipo/status
└── ExpandableText.tsx         # expansível "ver mais/ver menos" (+ ExpandableText.test.tsx)
```

Hooks em `src/hooks/`: `useContainerBreakpoint.ts` (faixa `sm`/`md`/`lg` pela largura
**real do container** via `ResizeObserver` — não da janela; usado pelo `DataGrid` p/ ocultar
colunas considerando sidebar/paddings) e `useGridColumns.ts` (metadados de coluna —
`ColumnDef`, `CONSULTA_COLUMNS`, `getEmailColumns`; é módulo de **definições**, não um hook,
apesar do nome). `useIdleLogout.ts` e `useAuth` cobrem sessão (ver Autenticação).

Tipos compartilhados vêm de `@sheild/shared` (ex.: `FinancialEmail`, `EmailControl`).
Helpers em `src/lib/`: `getErrorMessage.ts` (erro em strict mode), `cn.ts` (merge de
classes Tailwind — `clsx` + `tailwind-merge`, base do padrão CVA), `supabaseClient.ts`
(SDK oficial, só para auth), `authStorage.ts` (storage híbrido da sessão +
`setRememberPreference`/`getRememberPreference` — preferência "Lembrar-me"; ver
seção Autenticação) e `getFailureReason.ts` (texto pt-BR explicando por que um e-mail
ficou em `falha`, exibido no `Alert` do card de `/emails`).

Infra de teste a11y em `tests/`: `setup.ts` (matcher `toHaveNoViolations`), `axe.ts`
(runner AA + `color-contrast` desligado) e `contrast.a11y.test.ts` (guarda de contraste
dos tokens). Ver regra mandatória 6.

### Guia de cores — paleta `loginGreen` (`apps/frontend-vite/tailwind.config.ts`)

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

### Guia de cores — paleta semântica `status` (`tailwind.config.ts`)

Fonte de verdade para **feedback, badges e banners** em todo o app — usar estes tokens em
vez de cores default do Tailwind. Cada grupo tem `bg` (fundo suave), `fg` (texto/ícone) e
`border`; `error` ainda tem `solid`/`solidBorder` (badge crítico de fundo cheio). Todos
cumprem WCAG AA (verificado em `tests/contrast.a11y.test.ts`).

| Token | fg / bg | Uso |
|---|---|---|
| `status-error-*` | `#b91c1c` / `#fef2f2` (border `#fecaca`) | erro, vencido, falha |
| `status-error-solid` | branco / `#dc2626` | badge crítico (`erro_api`) |
| `status-success-*` | `#15803d` / `#f0fdf4` | sucesso, pago, extraído |
| `status-warning-*` | `#b45309` / `#fffbeb` | atenção, pendente |
| `status-info-*` | `#1d4ed8` / `#eff6ff` | informativo, a vencer, recebido |
| `status-source-*` | `#0f766e` / `#f0fdfa` | origem da extração (teal) |
| `status-neutral-*` | `#64748b` / `#f8fafc` | neutro, cancelado, documento |

Aplicação **sempre via `cva`**: `StatusBadge` (`statusBadge.variants.ts`), `Alert` (banner
de página) e `InlineMessage`. As quatro paletas — `brand` (verde dashboard), `auth`
(azul/petróleo), `loginGreen` (auth v2) e `status` (semântica) — **não se misturam**; cada
uma no seu contexto.

### Guia de cores — grid de dados (`DataGrid`, `dataGrid.variants.ts`)

O `DataGrid` é **chrome de tabela neutro**, não estado semântico — por isso usa as escalas
neutras default do Tailwind (exceção explícita à regra "não usar cores default" da Regra 1,
que vale só para **estados semânticos**). Dois temas via `variant`:

| Tema | Uso | Neutro | Header/célula |
|---|---|---|---|
| `default` | `/consulta` | `slate-*` | `.table-header` / `.table-cell` |
| `silver` | `/emails` | `zinc-*` | `.table-header-silver` / `.table-cell-silver` |

Linha selecionada usa o acento `brand` (`bg-brand/5 border-l-2 border-brand`); o `StatusBadge`
dentro das células continua na paleta `status`. Cada slot (header, row, cell, skeleton, empty,
sub-linha de detalhe) é um `cva` próprio com a base + o neutro do tema — string literal completa.

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

### Deduplicação por `message_id`

Gravado em `email_control.message_id` (UNIQUE). `register()` usa
`Prefer: resolution=ignore-duplicates` — mensagens já processadas são ignoradas sem
atualizar o registro existente. Fallback local em CSV quando Supabase indisponível
(`SupabaseControl._available`).

### Dedup de conteúdo + reemissão (`financial_account_control`)

Além do dedup por `message_id`, `find_financial_duplicate(payload)` evita gravar o
**mesmo documento** chegado em e-mails diferentes. Casa por 3 impressões: (1) barcode;
(2) fornecedor + `invoice_number` (≥6) + valor — pega **guia/DAS reemitida** com o mesmo
número e vencimento novo; (3) fornecedor + valor + vencimento + tipo. Quando encontra
duplicata, `extract_and_store_accounts` **não cria outra conta**: se a reemissão tem
vencimento **mais recente**, chama `update_financial` para atualizar `due_date` + boleto
(`barcode`, `amount_charged`, `fine_interest`, `other_additions`) na conta existente — uma
guia paga uma vez, sempre com o boleto válido. A trigger recalcula `due_status` no UPDATE.

### Duas chaves Supabase, dois papéis

- **`anon`** (`VITE_SUPABASE_ANON_KEY`): frontend — leitura REST, respeita RLS `TO authenticated`.
- **`service_role`** (`SUPABASE_SERVICE_KEY`): scripts Python/Flask — escrita, ignora RLS.

### Normalização de `document_type`

`extract_pdf.py` usa `_ns()` (strip de acentos + lowercase) para lookup em `_DOC_TYPE_NORM`.
CHECK constraint em `financial_account_control.document_type` usa `lower()` (migrations 014,
017, **024** e **026**). Tipos aceitos incluem: `boleto`, `cte`, `nfe`, `nfse`, `tributo`,
`das`, `pix`, `seguro`, `fatura`, `recibo`, `contrato`, `honorários`, `container`, `outro`
(DAS de Simples Nacional → `das`; PIX → `pix`). `container` = frete/demurrage/movimentação de
contêineres (keyword de assunto + classificação no corpo e PDF; migration 026).
`SKIP_ACCOUNT_TYPES = ['nfe', 'nfse']` — não geram conta a pagar.

**Regra honorários** (migration 024): e-mail de honorários (keyword de assunto `honorário`;
termo `honorário(s)` no corpo ou recibo) é gravado com `document_type='honorários'` e
`payment_method='pix'` — honorários têm **precedência sobre o override de PIX** do tipo, e o
pagamento é forçado a `pix` tanto no corpo (`extract_from_email_body`) quanto no PDF
(`build_financial_payload`).

### Auto-resolução de fornecedor

Trigger `trg_fe_supplier_id` (BEFORE INSERT OR UPDATE em `financial_account_control`) chama
`resolve_supplier_id(cnpj, cpf, name, email)`. Ordem de busca (`migration 027`/`028`):
**CNPJ → CPF → e-mail exato → nome normalizado → auto-insert** em `supplier`. Função
`normalize_search()` é SECURITY DEFINER.

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

| Valor | Origem |
|---|---|
| `pdf_text` | PDF digital (pdfplumber) |
| `pdf_vision` | PDF escaneado (Claude Vision via base64 — não exige poppler) |
| `email_body` | Corpo do e-mail (sem PDF válido) |
| `falha` | Falha na extração |

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
  parâmetros não quebrarem. Cobre **SIEG genericamente** (a página `app.sieg.com/faturas`
  tem `<a id="hlBoleto">Gerar Boleto</a>` apontando para o PDF na Vindi — sem handler
  dedicado). Faturas SIEG já **pagas** não trazem boleto (corretamente não geram conta).
- **Portal BRASPRESS** (`download_pdf_from_url` + `_braspress_download_url`): caso que o scan
  genérico não cobre, pois o link do PDF é montado por JS. O link do e-mail
  (`/protocoloweb?protocolo=CHAVE`) abre uma página cujo botão chama `faturaPDF(chave)`, que
  baixa de `/fatura/download?protocolo=CHAVE&protocoloWeb=true`. Exige **cookie de sessão**
  (`JSESSIONID`) — por isso `download_pdf_from_url` usa um `http.cookiejar`/opener
  compartilhado entre a página e o download (`_fetch_url` aceita `opener`). Outros portais
  com link de PDF montado por JS seguem esse padrão (handler dedicado).
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
`extract_from_email_body()` faz parsing por regex: `supplier_name` via rótulo
(`Fornecedor`/`Favorecido`/`Nome`/`Responsável`…) ou CNPJ/CPF. **Sem rótulo nem documento**,
tenta sinais (`_supplier_from_signals`) antes do remetente: assinatura titulada (`Prof./Dr.
<Nome>`) e destinatário do pagamento (`pix/pagar p/|para <Nome>`, com stopwords cortando a
captura) — ex.: honorários "pix p/ Wesley" + "Prof. Wesley S. Paixão". Só então cai para
`sender_email`. `amount` via `R$ ([\d.,]+)`; `payment_method='pix'` se o termo aparecer (ou
sempre, p/ honorários). **Valida fornecedor+valor**: sem valor → não grava conta (vira
`falha`). `email_body_excerpt` (migration 016) guarda o corpo completo.

**Fallbacks de campo (corpo E PDF — `build_financial_payload`):** `issue_date` vazio →
data do e-mail (`received_at`); `due_date` vazio → `issue_date` → hoje; `invoice_number`
vazio → `"{document_type}_{ddmmyy(vencimento|emissão)}"`. `supplier_name`/`amount` são
obrigatórios para gerar conta.

### Registrar TODOS os e-mails + filtro de assunto (`KEYWORDS_DEFAULT`)

`run_reader()` registra **todos** os e-mails da caixa em `email_control` — `/emails`
espelha o webmail inteiro (o app substitui abrir a caixa). O filtro de keyword decide
**o que extrair**, não o que registrar:

- **Dedup primeiro** (`message_id` em `known_ids`) → pula.
- **Sem keyword** no assunto → `ctrl.register({... status:'ignorado'})` sem baixar/
  extrair (`has_attachment` fica NULL). Respeita `--dry-run` (não grava).
- **Com keyword** → `process_message` (baixa + extrai) define o status pelo resultado:
  `extraído` (CSV gerado) · `pendente` (PDF salvo sem CSV) · `recebido` (sem PDF, conta
  via corpo) · `falha` (casou keyword mas sem PDF e sem conta no corpo). Ver migration 022.
- **Corpo é fallback só quando o anexo NÃO gera conta** (`accounts_saved==0`) — havendo
  conta de arquivo anexado válido, o corpo é ignorado (sem conflito).

Match é **substring** case-insensitive (`match_keyword`, ~linha 494): `transporte`
pega "conhecimento de transporte". Lista padrão em `KEYWORDS_DEFAULT` (~linha 72),
**sobrescrita por `EMAIL_KEYWORDS` no `.env`** (fonte de verdade usada hoje — ampliada
com `transporte, conhecimento de transporte, frete, honorá, título, vencer, unimed,
tributo, taxa, gnre`, etc.). Evitar tokens curtos ambíguos (`das` casaria "vendas").

### Frontend — rotas e serviços

| Rota | Componente | Tabela |
|---|---|---|
| `/emails` | `Emails.tsx` | `email_control` + `financial_account_control` por `message_id` |
| `/consulta` | `Consulta.tsx` | `financial_account_control` (paginado, filtros, CSV client-side) |
| `/erros` | `Erros.tsx` | `email_processing_errors` |

- `services/supabase.ts` — fetch direto REST, `Prefer: count=exact` + `Content-Range` para paginação.
- `services/emailReader.ts` — `POST /api/emails/read` proxiado pelo Vite para Flask.
- **`/consulta` — `cancelado` oculto por padrão (consistência grid ↔ KPIs):** `applyFinancialFilters`
  aplica `status=neq.cancelado` quando **não** há filtro de situação. `getFinancialStats` usa o
  **mesmo** filtro, então o rodapé "N registros", o KPI "Total de registros", o "Valor total" e
  "Vencidas" batem com o grid — contas canceladas só aparecem se o usuário escolher `cancelado`
  no filtro de situação (que sobrescreve o `neq`). Ao criar nova query/KPI sobre
  `financial_account_control`, replicar esse padrão para não divergir.
- **Grid compartilhado (responsivo, "à prova de mobile")**: `/consulta` (tema `default`) e
  `/emails` (tema `silver`) renderizam pelo mesmo `organisms/DataGrid.tsx`, com as colunas de
  `useGridColumns.ts` (`CONSULTA_COLUMNS` / `getEmailColumns`). Estratégia em camadas:
  1. **breakpoint pela largura do container** (`useContainerBreakpoint`/`ResizeObserver`),
     não da janela — então oculta colunas (`hideOn`) e desce as `secondLine` para uma
     sub-linha conforme o espaço **real** (considera a sidebar);
  2. **truncagem** de texto longo nas colunas com `truncate: true` (Fornecedor, Assunto,
     Remetente) — corta com `…` e expõe o valor no `title`;
  3. **rolagem horizontal** como rede de segurança: a `<table>` vive num wrapper
     `overflow-x-auto` no próprio `DataGrid` (rola em vez de cortar). **Trade-off:** o
     cabeçalho **deixou de ser `sticky`** (o wrapper de rolagem seria um novo contexto de
     scroll e quebraria o sticky vertical).
  A **sidebar** (`Layout.tsx`) colapsa em drawer com hambúrguer abaixo de `lg` (overlay +
  fecha ao navegar); em `lg+` é estática. Isso libera a largura no celular — toda página
  nova deve viver dentro desse `Layout`.

### Build e code-splitting (`frontend-vite`)

- **Rotas lazy** (`App.tsx`): só `LoginPage` entra no bundle inicial; as três telas de
  dados (`Emails`/`Consulta`/`Erros`) e os fluxos de auth secundários (`Forgot`/`Reset`)
  são `React.lazy` + `Suspense` (fallback "Carregando…"; um `Suspense` interno mantém o
  `Layout`/sidebar visível enquanto a página carrega). **Toda rota/página nova segue esse
  padrão** `lazy(() => import(...))`.
- **`manualChunks`** (`vite.config.ts`): `react-vendor` (react/-dom/router) e `supabase`
  (SDK) em chunks próprios — melhora cache e download paralelo e elimina o aviso `>500 kB`
  do Vite. O código de cada rota lazy vira um chunk à parte automaticamente.

## Banco de dados (Supabase)

Migrations em `supabase/migrations/`, aplicadas **manualmente no SQL Editor** em ordem
numérica (`001` → `028`). Não há migration automática.

| Tabela | Propósito |
|---|---|
| `email_control` | Dedup/controle. `status` ∈ (`extraído`, `recebido`, `pendente`, `falha`, `ignorado`) — **migration 022**. `extraído`=PDF extraído (CSV gerado); `recebido`=sem PDF, conta via corpo; `pendente`=PDF salvo sem CSV (substitui `baixado`); `falha`=casou keyword mas sem PDF e sem conta no corpo; `ignorado`=não-financeiro. O status é calculado em `process_message` pelo resultado real (CSV gerado/corpo), não por `pdf_extracted` |
| `financial_account_control` | Tabela principal de contas a pagar — uma linha por documento; alimentada pelo pipeline de e-mail **e** por CRUD manual (baixas, consolidações, dashboards). Substitui a antiga `financial_emails` (dropada na migration 020). Tem `sender_email` (migration 023; backfill em 025) que o trigger usa p/ alinhar `supplier.email`, e `subject` (migration 025) — ambos com backfill SQL de `email_control` e exibidos/buscados em `/consulta` |
| `email_processing_errors` | Log de falhas com `raw_payload` JSON |
| `supplier` | Fornecedores auto-criados pelo trigger. Reconhecimento por **e-mail** em `email`/`email2`/`email3`/`email4` (migrations 023/027/028) — ver "Auto-resolução de fornecedor" |
| `company` | Empresa pagadora (**cadastro**, tem campo `email`). Auto-resolvida pelo trigger `resolve_company_id` a partir de `payer_cnpj`/`payer_name`. **Preservada em limpezas** (ver abaixo) |

`financial_account_control.status` (ciclo de vida do pagamento, default `pendente`) e
`due_status` (situação de vencimento, gravada pela trigger) compartilham o mesmo domínio
pt-BR de 13 valores: `pendente, vencido, a vencer, prorrogado, baixado, protestado,
cartório, pago, pago protesto, pago cartório, não pago, cancelado, falha` (migration 018).
`payment_method` aceita `boleto, pix, ted, cartão, depósito, duplicata, bancário, carteira,
vale, crédito, débito, dinheiro, transferência, cheque, outro`; `extraction_source` ∈
(`email_body, pdf_text, pdf_vision, falha`).

**Schemas Zod (`packages/shared`) = fonte única de tipos.** Os tipos TS são `z.infer` dos
schemas (não há tipo escrito à mão para divergir); os `z.enum` espelham 1:1 os CHECK do
banco — ao alterar um CHECK, **atualizar o enum correspondente**. `due_status` reutiliza
`ACCOUNT_STATUSES` (o domínio completo de 13 valores, idêntico a `status`), não só os
`'a vencer'/'vencido'` que a trigger grava hoje — baixas/CRUD manual podem usar os demais.
O frontend consome os schemas de dados (`FinancialAccountControl`, `EmailControl`,
`ProcessingError`) **apenas como `import type`** (sem `.parse()` em runtime — `services/supabase.ts`
faz cast); só os schemas de **auth** rodam em runtime via `zodResolver`.

RLS habilitado em todas as tabelas. Policies de leitura são `TO authenticated`
(migrations 015/018/019); escrita em `financial_account_control` é `TO service_role`
(CRUD via Next API). Toda nova tabela deve seguir o mesmo padrão.

### Limpeza / reset de dados (SEMPRE preservar os cadastros)

Ao limpar a base para uma nova busca geral, **SEMPRE preserve estas tabelas de
cadastro/configuração** — não são alimentadas pelo pipeline e nunca devem ser apagadas:

- `company`
- `financial_account`
- `financial_bank`
- `financial_chart_of_account`
- `financial_chart_of_account_group`
- `financial_chart_of_account_subgroup`
- `financial_cost_center`

**Alvos da limpeza** (truncar com `RESTART IDENTITY CASCADE`): `email_control`,
`financial_account_control`, `email_processing_errors`, `supplier` e `audit_log` — mais o
bucket **`attachments`** do Storage e o cache local (`data/pdfs_inbox`, `data/csv_output`).
`supplier` é recriado automaticamente pelo trigger de resolução no reprocessamento; a
`company` preservada continua resolvendo `company_id` das novas contas.

> **Storage:** `DELETE` direto em `storage.objects` é bloqueado (`protect_delete`). Esvaziar
> o bucket via **Storage API** (`POST object/list/attachments` → `DELETE object/attachments`
> com `{prefixes:[…]}`), usando `SUPABASE_SERVICE_KEY` do `.env` da raiz.

## Windows Task Scheduler

`scheduler/run_reader.ps1` — 1 hora de intervalo. Detecta Python com `pdfplumber`
(ordem: `py -3.12`, `-3.13`, `-3.11`, `-3.10`, `-3`, PATH). Logs em
`logs/scheduler/reader_YYYYMMDD.log`, retidos 30 dias.

Dev/único checkout: `C:\Sheild\Projetos\Claude\Contas a pagar\Pagamentos` (branch `Features`,
sincronizado com `main`). **Não há checkout de produção separado** — `C:\Sheild\API\Pagamentos`
(citado em versões antigas) não existe como repositório. Para provisionar produção no futuro,
clonar o `main` no destino; até lá, app e scheduler rodam deste diretório.

