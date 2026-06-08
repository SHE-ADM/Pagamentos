# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é este projeto

`pagamentos` é um **pipeline financeiro de contas a pagar**, não um app CRUD comum.
O fluxo central é: e-mail (IMAP) → download de PDF → extração via Claude API →
gravação no Supabase → consulta/exportação pela interface web.

> **Atenção — diverge do padrão Sheild do workspace.** Os `CLAUDE.md` e `rules/` em
> `C:\Sheild\Projetos\Claude\` assumem o monorepo `client/server/shared`, Supabase Auth,
> shadcn/ui e TypeScript. Este projeto **não segue** isso:
> - Backend é **Python (Flask)** em `server/`, não Express/TS.
> - Frontend é **React + Vite + Tailwind em JavaScript puro** (`app/`), **sem shadcn/ui**,
>   **sem TypeScript**.
> - A lógica de negócio vive em **Claude Skills** (`skills/`), não em rotas Express.
> - Acesso de leitura ao Supabase é via **REST direto com `fetch`**
>   (`app/src/services/supabase.js`), sem o SDK `@supabase/supabase-js` — apenas a
>   sessão de autenticação usa o cliente oficial (`app/src/lib/supabaseClient.js`).
>
> Não aplique os templates Sheild Canvas, shadcn ou os componentes de exemplo do
> `auth-specs.md` aqui — mas o **fluxo de autenticação em 3 etapas** e a **regra de
> não-autorregistro** definidos em `auth-specs.md` foram seguidos, adaptados para `.jsx`
> puro com Tailwind. Mantenha o estilo existente do restante do projeto.

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

### 2 — Todo componente tem teste

- **Todo componente novo ou alterado de forma relevante deve ter ao menos um teste**
  cobrindo renderização e a interação principal (ex.: submit, expand/collapse, validação).
- O projeto **ainda não tem suíte configurada** — ao criar o primeiro teste, configurar
  **Vitest + Testing Library** e adicionar o script `"test": "vitest"` no
  `app/package.json`. Não postergar: o teste vai junto com o componente no mesmo commit.
- Referência de granularidade: `ExpandableText.jsx`, `StatusBadge.jsx`, `FilledTextField.jsx`.

### 3 — REST no backend

Toda rota nova em `server/app.py` deve seguir:

| Decisão | Regra |
|---|---|
| URL | Substantivo no plural (`/api/contas`, `/api/contas/:id`) |
| Verbos | `GET` leitura · `POST` criação/ação · `PUT`/`PATCH` atualização · `DELETE` remoção |
| Status codes | `200`/`201` sucesso · `400` validação · `401`/`403` auth · `404` não encontrado · `5xx` servidor |
| Envelope | `{"ok": bool, ...}` — não introduzir formatos novos |
| Sessão | Stateless — autenticação via `Authorization: Bearer <token>` no header |

A exceção aceita: `POST /api/emails/read` usa POST + corpo de parâmetros porque é
uma **ação de disparo**, não um recurso CRUD.

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

---

## Autenticação (Supabase Auth)

O acesso às rotas internas (`/emails`, `/consulta`, `/erros`) exige login.

- **Sem auto-cadastro**: usuários criados apenas pelo admin no Supabase Dashboard
  (`Authentication → Users → Add user`, com "Auto Confirm User" marcado).
  `supabase.auth.signUp()` nunca é chamado pelo frontend.
- **Três fluxos** (`app/src/pages/auth/`): `LoginPage` → `signInWithPassword`,
  `ForgotPasswordPage` → `resetPasswordForEmail`, `ResetPasswordPage` → `updateUser`.
- Estado de sessão: `AuthContext`/`useAuth` (`app/src/contexts/AuthContext.jsx`),
  via `supabase.auth.getSession()` + `onAuthStateChange`.
- Rotas protegidas: `ProtectedRoute.jsx` redireciona para `/auth/login` sem sessão.
- RLS: migration `015` trocou policies de leitura de `TO anon` para `TO authenticated` —
  `services/supabase.js` envia `access_token` no header `Authorization` (além do `apikey`).

## Arquitetura e fluxo de dados

```
IMAP (Locaweb SSL)                       Frontend (app/, React+Vite)
      │                                        │
      │                          ┌─────────────┼────────────────────────────┐
      │                          │ /emails     │ /consulta      /erros       │
      │                          │ email_control  financial_emails  errors   │
      │                          │   fetch direto Supabase REST              │
      │                          │   (apikey: anon + Authorization: token)   │
      │                          └─────────────┼────────────────────────────┘
      │                                        │ POST /api/emails/read
      ▼                                        ▼
read_emails.run_reader() ◄───────── server/app.py (Flask, porta 8000)
      │                                        ▲
      │ por e-mail:                            │ proxy /api (vite.config.js)
      │  1. filtra por palavra-chave no assunto
      │  2. deduplica via email_control.message_id (UNIQUE)
      │  3. salva PDF em data/pdfs_inbox/
      │  4. subprocess → extract_pdf.py (Claude API: pdf_text ou pdf_vision)
      │  5. UPSERT em email_control  +  fallback CSV em data/csv_output/
      ▼
Supabase (PostgreSQL)  ── financial_emails (dados extraídos)
                       ├─ email_control     (controle/dedup)
                       ├─ email_processing_errors (log de falhas)
                       └─ supplier          (fornecedores auto-criados)
```

## Comandos

```powershell
# Terminal 1 — backend Flask (porta 8000)
python server\app.py

# Terminal 2 — frontend Vite (porta 5173; proxy /api → 127.0.0.1:8000)
cd app
npm run dev
npm run build
npm run preview
```

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
cd app && npm install
```

## Frontend — componentes e design system

### Estrutura Atomic Design

```
app/src/components/
├── atoms/
│   ├── FilledTextField.jsx    # campo com label, fundo verde, foco via useState
│   ├── AccentPillButton.jsx   # botão primário verde + ArrowRight
│   ├── AuthInput.jsx          # input das páginas Esqueci/Redefinir senha
│   └── GradientPillButton.jsx
├── molecules/
│   ├── SocialLinksBar.jsx     # círculos Otimotex/Lebianco/WhatsApp + "fale com a gente"
│   ├── AuthHeroHeader.jsx
│   └── InlineMessage.jsx
├── organisms/
│   ├── LoginForm.jsx          # estado + validação + Supabase
│   ├── ForgotPasswordForm.jsx
│   └── ResetPasswordForm.jsx
├── AuthLayout.jsx
├── Layout.jsx
├── ProtectedRoute.jsx
├── StatusBadge.jsx
└── ExpandableText.jsx         # expansível "ver mais/ver menos" (whitespace-pre-wrap)
```

### Guia de cores — paleta `loginGreen` (`app/tailwind.config.js`)

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

Usar o token mais próximo; valor arbitrário só como exceção documentada.

**Tipografia:**

| Classe | Tamanho | Uso no projeto |
|---|---|---|
| `text-xs` | 12px | labels sociais, "fale com a gente" |
| `text-sm` | 14px | labels de campo, textos de meta, erro |
| `text-base` | 16px | corpo padrão do restante do app |
| `text-lg` | 18px | subtítulo do login |
| `text-xl` | 20px | texto do botão primário |
| `text-4xl` | 36px | h1 do login (design original: 42px — token mais próximo) |

**Pesos:**

| Classe | Peso | Uso |
|---|---|---|
| `font-medium` | 500 | subtítulo, input, meta row, labels sociais |
| `font-semibold` | 600 | link "Esqueci a senha" |
| `font-bold` | 700 | label de campo, botão |
| `font-extrabold` | 800 | h1 do login |

**Espaçamento e dimensões recorrentes:**

| Classe | px | Uso |
|---|---|---|
| `h-12` | 48px | altura dos campos de input |
| `h-14` | 56px | altura do botão primário |
| `h-64` | 256px | altura do banner da login page |
| `w-14 h-14` | 56px | círculos sociais |
| `border-8` | 8px | frame externo da login page |
| `border-2` | 2px | borda dos campos e círculos |
| `rounded-2xl` | 16px | border-radius do card |
| `rounded-lg` | 8px | border-radius de campos e botão |
| `gap-5` | 20px | espaçamento entre seções do formulário |
| `gap-8` | 32px | espaçamento entre círculos sociais |
| `p-6` | 24px | padding horizontal do card |
| `px-3.5` | 14px | padding horizontal dos campos |

**Fonte customizada:**

`font-jakarta` → `Plus Jakarta Sans` (Google Fonts, carregada em `app/index.html`).
Aplicada no div raiz de `LoginPage.jsx`; herda por cascata para todos os filhos.

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

### Duas chaves Supabase, dois papéis

- **`anon`** (`VITE_SUPABASE_ANON_KEY`): frontend — leitura REST, respeita RLS `TO authenticated`.
- **`service_role`** (`SUPABASE_SERVICE_KEY`): scripts Python/Flask — escrita, ignora RLS.

### Normalização de `document_type`

`extract_pdf.py` usa `_ns()` (strip de acentos + lowercase) para lookup em `_DOC_TYPE_NORM`.
CHECK constraint em `financial_emails.document_type` usa `lower()` (migration 014).
Tipos aceitos: `boleto`, `cte`, `nfe`, `nfse`, `tributo`, `seguro`, `fatura`, `recibo`, `contrato`, `outro`.
`SKIP_ACCOUNT_TYPES = ['nfe', 'nfse']` — não geram conta a pagar.

### Auto-resolução de fornecedor

Trigger `trg_fe_supplier_id` (BEFORE INSERT OR UPDATE em `financial_emails`) chama
`resolve_supplier_id(cnpj, cpf, name)`: busca exata por CNPJ/CPF → fallback por nome
normalizado → auto-insert em `supplier`. Função `normalize_search()` é SECURITY DEFINER.

### `extraction_source` — origem dos dados

| Valor | Origem |
|---|---|
| `pdf_text` | PDF digital (pdfplumber) |
| `pdf_vision` | PDF escaneado (Claude Vision, exige poppler) |
| `email_body` | Corpo do e-mail (sem PDF válido) |
| `error` | Falha na extração |

### Caminho `email_body`

Acionado em `process_message()` quando `not has_att` ou `accounts_saved == 0`.
`extract_from_email_body()` faz parsing por regex: `supplier_name` via
`Nome`/`Responsável`, `amount` via `R$ ([\d.,]+)`, `payment_method = 'pix'` se
o termo aparecer, `due_date` = data explícita ou `received_at` como fallback.
`email_body_excerpt` (migration 016) guarda o corpo completo; exibido via `ExpandableText`.

### Filtro de assunto — `KEYWORDS_DEFAULT`

Linha ~60 de `read_emails.py`. Sobrescrito via `EMAIL_KEYWORDS` no `.env`.
Comparação case-insensitive contra o assunto do e-mail.

### Frontend — rotas e serviços

| Rota | Componente | Tabela |
|---|---|---|
| `/emails` | `Emails.jsx` | `email_control` + `financial_emails` por `message_id` |
| `/consulta` | `Consulta.jsx` | `financial_emails` (paginado, filtros, CSV client-side) |
| `/erros` | `Erros.jsx` | `email_processing_errors` |

- `supabase.js` — fetch direto REST, `Prefer: count=exact` + `Content-Range` para paginação.
- `emailReader.js` — `POST /api/emails/read` proxiado pelo Vite para Flask.

## Banco de dados (Supabase)

Migrations em `supabase/migrations/`, aplicadas **manualmente no SQL Editor** em ordem
numérica (`001` → `016`). Não há migration automática.

| Tabela | Propósito |
|---|---|
| `email_control` | Dedup/controle. `status` ∈ (received, downloaded, extracted, error, ignored) |
| `financial_emails` | Dados extraídos — uma linha por documento financeiro |
| `email_processing_errors` | Log de falhas com `raw_payload` JSON |
| `supplier` | Fornecedores auto-criados pelo trigger |

RLS habilitado em todas as tabelas. Policies de leitura são `TO authenticated` (migration 015).
Toda nova tabela deve seguir o mesmo padrão.

## Windows Task Scheduler

`scheduler/run_reader.ps1` — 1 hora de intervalo. Detecta Python com `pdfplumber`
(ordem: `py -3.12`, `-3.13`, `-3.11`, `-3.10`, `-3`, PATH). Logs em
`logs/scheduler/reader_YYYYMMDD.log`, retidos 30 dias.

Produção: `C:\Sheild\API\Pagamentos` (dev: `C:\Sheild\Projetos\Claude\Contas a pagar\Pagamentos`).

## Convenções herdadas (do workspace)

Respostas em pt-BR formal, código/identificadores em inglês, `NUMERIC(15,2)` para
valores monetários, nunca commitar `.env`.
Veja `C:\Sheild\Projetos\Claude\CLAUDE.md` — ignorar as partes sobre monorepo TS/Express/shadcn.
