# pagamentos

Pipeline financeiro automatizado para gestão de contas a pagar.

## Stack

- **n8n Cloud** — automação de workflows (leitura de e-mail, orquestração)
- **Claude API** — extração de dados de PDFs (texto + Vision)
- **Supabase (PostgreSQL)** — armazenamento e API REST
- **Locaweb IMAP** — fonte de e-mails (SSL, porta 993)
- **Python 3.10+** — scripts de extração e processamento
- **Flask** — backend local que expõe a leitura de e-mails como API (`server/`)
- **Monorepo npm workspaces** — `apps/*` + `packages/shared`
- **React 18 + Vite + Tailwind (TypeScript)** — app interno (`apps/frontend-vite`, :5173)
- **Next.js 16 + TypeScript** — API de dados (`apps/api-backend`, :3000) e portal público (`apps/portal-next`, :3002)
- **Zod** — schemas compartilhados (`packages/shared`, `@sheild/shared`)

## Estrutura do Projeto

```
pagamentos/
├── .env.example              ← Modelo de variáveis de ambiente
├── .env                      ← Variáveis reais (NÃO commitar)
├── .gitignore
├── README.md
│
├── skills/                   ← Skills Claude instaladas
│   └── pdf-contas-pagar/     ← Extração PDF → CSV
│       ├── SKILL.md
│       ├── scripts/
│       │   └── extract_pdf.py
│       ├── references/
│       │   ├── csv_schema.md
│       │   ├── integration_guide.md
│       │   └── error_handling.md
│       └── assets/
│           └── output_template.csv
│
├── data/
│   ├── pdfs_inbox/           ← PDFs recebidos (input)
│   ├── csv_output/           ← CSVs extraídos (output)
│   └── samples/              ← PDFs de exemplo para testes
│
├── n8n/
│   └── workflows/            ← Exportações JSON dos workflows
│
├── supabase/
│   └── migrations/           ← Scripts DDL versionados (001, 002, 003…)
│
├── server/                   ← Backend local (Flask) — pipeline Python
│   ├── app.py                ←   API: POST /api/emails/read, GET /api/health
│   └── requirements.txt
│
├── package.json              ← Raiz do monorepo (npm workspaces, lockfile único)
│
├── apps/
│   ├── frontend-vite/        ← App interno (React 18 + Vite + Tailwind, TS) :5173
│   │   └── src/{pages,components,contexts,services,lib}/  ← tudo .tsx/.ts
│   ├── api-backend/          ← Next.js 16 + TS — camada de dados/CRUD :3000
│   │   ├── app/api/{health,emails/read}/route.ts
│   │   └── lib/{response,supabase-admin,python-bridge}.ts
│   └── portal-next/          ← Next.js 16 + Tailwind v4 — portal público :3002
│
├── packages/
│   └── shared/               ← @sheild/shared — schemas Zod (fonte de tipos)
│
└── logs/                     ← Logs de execução
```

## Skills planejadas

| # | Skill | Status |
|---|---|---|
| 1 | `pdf-contas-pagar` | ✅ Pronta |
| 2 | `email-reader` | ✅ Pronta (CLI + API via `server/app.py`) |
| 3 | `supabase-sync` | ⏳ Planejada |
| 4 | `contas-crud` | ⏳ Planejada |
| 5 | `dashboard-financeiro` | ⏳ Planejada |
| 6 | `n8n-automation` | ⏳ Planejada |

## Instalação

```bash
# 1. Instalar dependências Python (extração + backend Flask)
pip install pdfplumber pypdf anthropic pandas python-dotenv Pillow flask

# 2. Instalar poppler (necessário para PDFs escaneados)
# Baixar em: https://github.com/oschwartz10612/poppler-windows/releases
# Extrair e adicionar a pasta bin/ ao PATH do sistema

# 3. Configurar variáveis de ambiente
copy .env.example .env
# Editar .env com os valores reais (pipeline Python: IMAP, Supabase service_role, Claude)
# O frontend usa apps\frontend-vite\.env.local (VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY)

# 4. Instalar dependências de todos os apps (na raiz — npm workspaces)
npm install

# 5. Testar extração
python skills\pdf-contas-pagar\scripts\extract_pdf.py ^
  --input data\samples\ ^
  --output data\csv_output\ ^
  --batch
```

## Executar o app

Para o fluxo principal (app interno + leitura de e-mails), bastam **dois processos** —
abra dois terminais a partir da raiz do projeto:

```powershell
# Terminal 1 — backend Flask (porta 8000)
python server\app.py

# Terminal 2 — frontend Vite interno (porta 5173)
npm run dev:vite
```

Opcionais (monorepo): `npm run dev:api` (Next API, :3000) e `npm run dev:portal`
(portal público, :3002).

Acesse a URL exibida pelo Vite (ex.: `http://localhost:5173/`). Na página
**E-mails**, o botão **"Buscar e-mails novos"** dispara a leitura IMAP no backend:
baixa os PDFs, aciona a extração, grava em `email_control`/`financial_account_control` e
recarrega a tabela com o resumo.

> O Vite faz proxy de `/api` → `http://127.0.0.1:8000` (Flask), então não há
> configuração de CORS. O frontend interno só funciona com o backend Flask ativo.
> A Next API (`apps/api-backend`) é camada de dados independente e expõe a mesma
> ponte ao Flask para CRUD futuro.

### Verificação e testes

```powershell
npm test          # Vitest em todos os workspaces (frontend-vite + api-backend)
npm run typecheck # tsc --noEmit em todos os workspaces
```

### API do backend (`server/app.py`)

| Método | Rota | Descrição |
|---|---|---|
| `GET`  | `/api/health` | Sonda de disponibilidade (`{"status":"ok"}`) |
| `POST` | `/api/emails/read` | Dispara a leitura IMAP |

Corpo (JSON) do `POST /api/emails/read` — todos os campos são opcionais:

| Campo | Tipo | Padrão | Descrição |
|---|---|---|---|
| `days` | int | `0` | Últimos N dias (`0` = apenas não lidos / UNSEEN); máx. 365 |
| `all` | bool | `false` | Processar TODOS os e-mails (ignora UNSEEN) |
| `dry_run` | bool | `false` | Listar sem baixar anexos nem gravar |
| `mark_seen` | bool | `false` | Marcar como lidos após processar |

A mesma lógica está disponível via CLI (`run_reader` é compartilhada):

```powershell
python skills\email-reader\scripts\read_emails.py --days 7
```

## Banco de dados (Supabase)

Migrations versionadas em `supabase/migrations/` — execute em ordem no SQL Editor:

| Migration | Conteúdo |
|---|---|
| `002_create_email_control.sql` | Tabela `email_control` (controle/deduplicação) |
| `003_rls_read_policies.sql` | RLS + policies de leitura nas tabelas |
| `018_create_financial_account_control.sql` | Tabela principal `financial_account_control` (domínios pt-BR, triggers, RLS) |
| `019_email_control_pt_status.sql` | Status de `email_control` em pt-BR + policy de leitura |
| `020_drop_financial_emails.sql` | Remove a antiga `financial_emails` (substituída) |

### `financial_account_control` — campos principais
- `gmail_message_id` (UNIQUE) — identificador de deduplicação do pipeline de e-mail
- `due_date`, `amount` (NUMERIC 15,2), `currency` (BRL)
- `status` — coluna única de situação/ciclo de vida (pendente/vencido/a vencer/prorrogado/baixado/protestado/cartório/pago/cancelado/falha — default `pendente`). A trigger grava `a vencer`/`vencido` a partir de `due_date` quando em aberto; preserva `falha`/baixas manuais (migration 034 fundiu o antigo `due_status` aqui)
- `status_id` — FK para a dimensão `status` (`fk_fac_status`), sincronizado por `status_name` na trigger (migration 035)
- `payment_method` (boleto/pix/ted/cartão/depósito/duplicata/bancário/carteira/vale/crédito/débito/dinheiro/transferência/cheque/outro)
- `extraction_source` (email_body/pdf_text/pdf_vision/falha)

### `email_control` — controle de processamento
- `message_id` (UNIQUE) — deduplicação por Message-ID do header MIME
- `has_attachment`, `pdf_extracted`, `status` (recebido/baixado/extraído/falha/ignorado)

> **RLS:** todas as tabelas têm Row Level Security habilitado. As policies de
> **leitura** liberam o papel `authenticated` (frontend logado via Supabase Auth).
> A **escrita** em `financial_account_control` é exclusiva da `service_role` (scripts
> Python e CRUD via Next API), que ignora RLS.
