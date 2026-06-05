# email-pago

Pipeline financeiro automatizado para gestão de contas a pagar.

## Stack

- **n8n Cloud** — automação de workflows (leitura de e-mail, orquestração)
- **Claude API** — extração de dados de PDFs (texto + Vision)
- **Supabase (PostgreSQL)** — armazenamento e API REST
- **Locaweb IMAP** — fonte de e-mails (SSL, porta 993)
- **Python 3.10+** — scripts de extração e processamento
- **Flask** — backend local que expõe a leitura de e-mails como API (`server/`)
- **React + Vite + Tailwind** — interface web (`app/`)

## Estrutura do Projeto

```
email-pago/
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
├── server/                   ← Backend local (Flask)
│   ├── app.py                ←   API: POST /api/emails/read, GET /api/health
│   └── requirements.txt
│
├── app/                      ← Frontend (React + Vite + Tailwind)
│   ├── src/
│   │   ├── pages/            ←   Emails.jsx, Consulta.jsx
│   │   ├── components/       ←   Layout.jsx, StatusBadge.jsx
│   │   └── services/         ←   supabase.js, emailReader.js
│   ├── vite.config.js        ←   proxy /api → backend Flask
│   └── package.json
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
# Editar .env com os valores reais
# O frontend usa app\.env (VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY)

# 4. Instalar dependências do frontend
cd app && npm install && cd ..

# 5. Testar extração
python skills\pdf-contas-pagar\scripts\extract_pdf.py ^
  --input data\samples\ ^
  --output data\csv_output\ ^
  --batch
```

## Executar o app

O sistema roda em **dois processos** — abra dois terminais a partir da raiz do projeto:

```powershell
# Terminal 1 — backend Flask (porta 8000)
python server\app.py

# Terminal 2 — frontend Vite (porta 5173)
cd app
npm run dev
```

Acesse a URL exibida pelo Vite (ex.: `http://localhost:5173/`). Na página
**E-mails**, o botão **"Buscar e-mails novos"** dispara a leitura IMAP no backend:
baixa os PDFs, aciona a extração, grava em `email_control`/`financial_emails` e
recarrega a tabela com o resumo.

> O Vite faz proxy de `/api` → `http://127.0.0.1:8000`, então não há configuração
> de CORS. O frontend só funciona com o backend Flask ativo.

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
| `001_create_financial_emails.sql` | Tabela `financial_emails` (dados extraídos) |
| `002_create_email_control.sql` | Tabela `email_control` (controle/deduplicação) |
| `003_rls_read_policies.sql` | RLS + policies de leitura `anon` nas duas tabelas |

### `financial_emails` — campos principais
- `gmail_message_id` (UNIQUE) — identificador de deduplicação
- `due_date`, `amount` (NUMERIC 15,2), `currency` (BRL)
- `status` (pending/paid/cancelled/error)
- `extraction_source` (email_body/pdf_text/pdf_vision)

### `email_control` — controle de processamento
- `message_id` (UNIQUE) — deduplicação por Message-ID do header MIME
- `has_attachment`, `pdf_extracted`, `status` (received/downloaded/extracted/error/ignored)

> **RLS:** as duas tabelas têm Row Level Security habilitado. As policies da
> migration 003 liberam **leitura** para a chave `anon` (frontend). A **escrita**
> é exclusiva da `service_role` (usada pelos scripts Python e pelo backend), que
> ignora RLS. Ao adicionar Supabase Auth, restringir as policies para
> `authenticated` (ver comentário no arquivo da migration).
