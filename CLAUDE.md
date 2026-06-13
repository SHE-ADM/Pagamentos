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
- **Tokens de cor**: usar sempre `loginGreen-*` nas telas de auth (ver guia abaixo).
  Nunca use hex hardcoded em JSX ou CSS quando o token já existe na paleta.
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
  `InlineMessage`, `AuthInput`, `FilledTextField`, `AccentPillButton`, `GradientPillButton`.
  Mantenha as definições `cva` que não são componentes em arquivo separado (`*.variants.ts`)
  para não disparar `react-refresh/only-export-components`.

### 2 — Todo componente tem teste

- **Todo componente novo ou alterado de forma relevante deve ter ao menos um teste**
  cobrindo renderização e a interação principal (ex.: submit, expand/collapse, validação).
- **Suíte configurada (Vitest):** `apps/frontend-vite` (jsdom + Testing Library) e
  `apps/api-backend` (env node). Rode `npm test` na raiz (roda todos os workspaces) ou
  `npm run test --workspace=apps/<app>`.
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
- **SonarLint** (engine da IDE, sem CLI): manter o código livre dos achados recorrentes —
  condições positivas em vez de negadas com `else` (S7735: `v == null ? '—' : …`), par
  `[x, setX]` no `useState` (S6754), sem ternário/template literal aninhado no JSX (S3358/
  S4624 — extrair para uma const antes do `return`), sem import não usado (S1128), sem
  seletor booleano que escolhe a ação dentro do método (S2301 — preferir uma única ação
  com valor por ternário, ex.: `setItem(key, on ? '1' : '0')` em vez de `if/else` com
  `setItem`/`removeItem`), e sem texto solto logo após um elemento inline em JSX (S6772 —
  envolver o texto em `<span>`, ex.: `<input … /><span>Lembrar-me</span>`).

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
# Terminal 1 — backend Flask (porta 8000) — necessário para leitura de e-mails
python server\app.py

# Terminal 2 — os 3 apps Node de uma vez (vite :5173, api :3000, portal :3002)
npm run dev            # via concurrently — substitui os 3 comandos abaixo

# …ou individualmente, em terminais separados:
npm run dev:vite       # frontend Vite interno (proxy /api → Flask :8000)
npm run dev:api        # Next API de dados — opcional p/ o fluxo atual
npm run dev:portal     # portal público — opcional
```

Scripts da raiz: `npm run dev` (sobe vite+api+portal em paralelo via `concurrently`) ·
`npm test` · `npm run typecheck` · `npm run lint` (rodam em todos os workspaces via
`--workspaces --if-present`). Builds: `npm run build:vite|build:api|build:portal`.
Ordem de startup quando se testa o fluxo de e-mail ponta a ponta: **Flask antes** da Next API
(o `dev` raiz não inclui o Flask/Python — inicie-o à parte).

Leitura de e-mails:

```powershell
python skills\email-reader\scripts\read_emails.py --days 7
python skills\email-reader\scripts\read_emails.py --dry-run
python skills\email-reader\scripts\read_emails.py --all --mark-seen
```

Reprocessar PDFs com falha (`status=downloaded`, `pdf_extracted=false`):

```powershell
py -3 scripts\retry_extraction.py          # usar py -3, não python
py -3 scripts\retry_extraction.py --dry-run
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
│   ├── FilledTextField.tsx    # (v2) campo label + fundo verde + foco via useState
│   ├── AccentPillButton.tsx   # (v2) botão primário verde + ArrowRight
│   ├── AuthInput.tsx          # (gradient) campo label + input + erro inline
│   └── GradientPillButton.tsx # (gradient) botão pill com bg-gradient-auth
├── molecules/
│   ├── SocialLinksBar.tsx     # (v2) círculos Otimotex/Lebianco/WhatsApp
│   ├── AuthHeroHeader.tsx     # (gradient) header decorativo com círculos sobrepostos
│   └── InlineMessage.tsx      # (gradient) banner sucesso/erro — nunca alert()
├── organisms/
│   ├── LoginForm.tsx          # (v2) estado + validação + supabase.auth.signInWithPassword
│   ├── ForgotPasswordForm.tsx # (gradient) resetPasswordForEmail + mensagem genérica
│   └── ResetPasswordForm.tsx  # (gradient) updateUser + signOut + redirect
├── AuthLayout.tsx             # (gradient) wrapper full-page para Forgot/Reset
├── Layout.tsx (+ Layout.test.tsx)
├── ProtectedRoute.tsx
├── StatusBadge.tsx (+ StatusBadge.test.tsx)   # componente; variantes em statusBadge.variants.ts
├── statusBadge.variants.ts    # cva(badgeVariants) + resolveBadge + mapas de tipo/status
└── ExpandableText.tsx         # expansível "ver mais/ver menos" (+ ExpandableText.test.tsx)
```

Tipos compartilhados vêm de `@sheild/shared` (ex.: `FinancialEmail`, `EmailControl`).
Helpers em `src/lib/`: `getErrorMessage.ts` (erro em strict mode), `cn.ts` (merge de
classes Tailwind — `clsx` + `tailwind-merge`, base do padrão CVA), `supabaseClient.ts`
(SDK oficial, só para auth) e `authStorage.ts` (storage híbrido da sessão +
`setRememberPreference`/`getRememberPreference` — preferência "Lembrar-me"; ver
seção Autenticação).

### Guia de cores — paleta `loginGreen` (`apps/frontend-vite/tailwind.config.ts`)

Telas de auth usam **exclusivamente** estes tokens:

| Token | Hex | Uso |
|---|---|---|
| `loginGreen-ink` | `#0c1e14` | títulos, labels, texto de input |
| `loginGreen-inkMid` | `#2a3d30` | textos secundários ("lembrar-me") |
| `loginGreen-inkMuted` | `#4a6b55` | labels sociais, divisores |
| `loginGreen-inkFaint` | `#7aab8a` | ícone olho |
| `loginGreen-placeholder` | `#8ab89a` | placeholder (`placeholder:text-loginGreen-placeholder`) |
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

### Guia de tamanhos — tokens Tailwind em uso

Usar o token mais próximo; valor arbitrário só como exceção documentada (ver abaixo).
A login passou por compactação para centralizar melhor o card — os valores abaixo são
os **atuais** (não os do design original).

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
CHECK constraint em `financial_account_control.document_type` usa `lower()` (migration 014).
Tipos aceitos incluem: `boleto`, `cte`, `nfe`, `nfse`, `tributo`, `das`, `pix`, `seguro`,
`fatura`, `recibo`, `contrato`, `outro` (DAS de Simples Nacional → `das`; PIX → `pix`).
`SKIP_ACCOUNT_TYPES = ['nfe', 'nfse']` — não geram conta a pagar.

### Auto-resolução de fornecedor

Trigger `trg_fe_supplier_id` (BEFORE INSERT OR UPDATE em `financial_account_control`) chama
`resolve_supplier_id(cnpj, cpf, name)`: busca exata por CNPJ/CPF → fallback por nome
normalizado → auto-insert em `supplier`. Função `normalize_search()` é SECURITY DEFINER.

### `extraction_source` — origem dos dados

| Valor | Origem |
|---|---|
| `pdf_text` | PDF digital (pdfplumber) |
| `pdf_vision` | PDF escaneado (Claude Vision via base64 — não exige poppler) |
| `email_body` | Corpo do e-mail (sem PDF válido) |
| `falha` | Falha na extração |

### Caminho `email_body`

Acionado em `process_message()` quando `not has_att` ou `accounts_saved == 0`.
`extract_from_email_body()` faz parsing por regex: `supplier_name` via
`Nome`/`Responsável`, `amount` via `R$ ([\d.,]+)`, `payment_method = 'pix'` se
o termo aparecer, `due_date` = data explícita ou `received_at` como fallback.
`email_body_excerpt` (migration 016) guarda o corpo completo; exibido via `ExpandableText`.

### Registrar TODOS os e-mails + filtro de assunto (`KEYWORDS_DEFAULT`)

`run_reader()` registra **todos** os e-mails da caixa em `email_control` — `/emails`
espelha o webmail inteiro (o app substitui abrir a caixa). O filtro de keyword decide
**o que extrair**, não o que registrar:

- **Dedup primeiro** (`message_id` em `known_ids`) → pula.
- **Sem keyword** no assunto → `ctrl.register({... status:'ignorado'})` sem baixar/
  extrair (`has_attachment` fica NULL para não poluir o KPI "Sem anexo"). Respeita
  `--dry-run` (não grava).
- **Com keyword** → `process_message` (baixa + extrai).
- **Casou keyword mas sem PDF e sem conta** (não-acionável) → também vira `ignorado`
  (`has_attachment` NULL), em vez de `recebido`. Decidido em `process_message` antes do
  `register`: se o status derivado seria `recebido`, grava `ignorado`.

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

## Banco de dados (Supabase)

Migrations em `supabase/migrations/`, aplicadas **manualmente no SQL Editor** em ordem
numérica (`001` → `021`). Não há migration automática.

| Tabela | Propósito |
|---|---|
| `email_control` | Dedup/controle. CHECK aceita (recebido, baixado, extraído, falha, ignorado) — migration 019. **`recebido` não é mais produzido**: e-mail que casou keyword mas ficou sem PDF e sem conta vira `ignorado` (ver "Registrar TODOS os e-mails"); permanece no CHECK por compat |
| `financial_account_control` | Tabela principal de contas a pagar — uma linha por documento; alimentada pelo pipeline de e-mail **e** por CRUD manual (baixas, consolidações, dashboards). Substitui a antiga `financial_emails` (dropada na migration 020) |
| `email_processing_errors` | Log de falhas com `raw_payload` JSON |
| `supplier` | Fornecedores auto-criados pelo trigger |

`financial_account_control.status` (ciclo de vida do pagamento, default `pendente`) e
`due_status` (situação de vencimento, gravada pela trigger) compartilham o mesmo domínio
pt-BR de 13 valores: `pendente, vencido, a vencer, prorrogado, baixado, protestado,
cartório, pago, pago protesto, pago cartório, não pago, cancelado, falha` (migration 018).
`payment_method` aceita `boleto, pix, ted, cartão, depósito, duplicata, bancário, carteira,
vale, crédito, débito, dinheiro, transferência, cheque, outro`; `extraction_source` ∈
(`email_body, pdf_text, pdf_vision, falha`).

RLS habilitado em todas as tabelas. Policies de leitura são `TO authenticated`
(migrations 015/018/019); escrita em `financial_account_control` é `TO service_role`
(CRUD via Next API). Toda nova tabela deve seguir o mesmo padrão.

## Windows Task Scheduler

`scheduler/run_reader.ps1` — 1 hora de intervalo. Detecta Python com `pdfplumber`
(ordem: `py -3.12`, `-3.13`, `-3.11`, `-3.10`, `-3`, PATH). Logs em
`logs/scheduler/reader_YYYYMMDD.log`, retidos 30 dias.

Dev/único checkout: `C:\Sheild\Projetos\Claude\Contas a pagar\Pagamentos` (branch `Features`,
sincronizado com `main`). **Não há checkout de produção separado** — `C:\Sheild\API\Pagamentos`
(citado em versões antigas) não existe como repositório. Para provisionar produção no futuro,
clonar o `main` no destino; até lá, app e scheduler rodam deste diretório.

