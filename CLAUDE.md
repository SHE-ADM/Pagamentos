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
>   **sem react-router auth**, **sem TypeScript**, **sem login** (acesso aberto na fase 1).
> - A lógica de negócio vive em **Claude Skills** (`skills/`), não em rotas Express.
> - Acesso ao Supabase é via **REST direto com `fetch`** (`app/src/services/supabase.js`),
>   sem o SDK `@supabase/supabase-js`.
>
> Não aplique os templates Sheild Canvas, auth-specs ou shadcn aqui. Mantenha o estilo existente.

## Arquitetura e fluxo de dados

```
IMAP (Locaweb SSL)                       Frontend (app/, React+Vite)
      │                                        │  fetch /api/emails/read
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
                       └─ email_control     (controle/dedup)
```

Pontos-chave que exigem ler vários arquivos para entender:

- **`run_reader()` é a única fonte de verdade da leitura** (`skills/email-reader/scripts/read_emails.py`).
  Tanto o CLI (`main()`) quanto a API (`server/app.py`) a chamam. Ao mudar a lógica de
  leitura, edite só `run_reader` — nunca duplique no Flask.
- **`read_emails.py` carrega o `.env` da raiz por conta própria** (`load_dotenv(parents[3]/".env")`).
  O `server/app.py` apenas insere o caminho da skill no `sys.path` e importa o módulo —
  não recarrega env nem reimplementa nada.
- **Deduplicação é por `message_id`** (header MIME), gravado em `email_control`. Se o Supabase
  estiver indisponível, o script cai para dedup/log local em CSV (`SupabaseControl._available`).
- **Duas chaves Supabase, dois papéis:** o frontend usa a **`anon`** (somente leitura, via
  policies da migration 003); os scripts Python e o Flask usam a **`service_role`**
  (`SUPABASE_SERVICE_KEY`), que ignora RLS para escrever.
- **`extraction_source`** distingue de onde o dado veio: `email_body`, `pdf_text` (PDF com texto)
  ou `pdf_vision` (PDF escaneado, via Claude Vision — exige poppler no PATH).

## Comandos

O sistema roda em **dois processos** (a partir da raiz do projeto):

```powershell
# Terminal 1 — backend Flask (porta 8000)
python server\app.py

# Terminal 2 — frontend Vite (porta 5173; o Vite faz proxy de /api → 127.0.0.1:8000)
cd app
npm run dev          # dev server
npm run build        # build de produção (dist/)
npm run preview      # serve o build
```

Leitura de e-mails pela CLI (mesma lógica do botão do app):

```powershell
python skills\email-reader\scripts\read_emails.py --days 7      # últimos 7 dias
python skills\email-reader\scripts\read_emails.py               # apenas não lidos (UNSEEN)
python skills\email-reader\scripts\read_emails.py --dry-run     # lista sem baixar/gravar
python skills\email-reader\scripts\read_emails.py --all --mark-seen
```

Extração de PDF isolada:

```powershell
python skills\pdf-contas-pagar\scripts\extract_pdf.py --input data\pdfs_inbox\ --output data\csv_output\ --batch
```

Dependências:

```powershell
pip install pdfplumber pypdf anthropic pandas python-dotenv Pillow flask
cd app && npm install
```

Não há suíte de testes automatizados no projeto. Validação é manual:
use `--dry-run` na CLI ou `{"dry_run": true}` no `POST /api/emails/read`.

## Banco de dados (Supabase)

Migrations versionadas em `supabase/migrations/`, aplicadas **manualmente no SQL Editor**
em ordem (`001` → `002` → `003`). Não há ferramenta de migration automática.

- `001_create_financial_emails.sql` — tabela de dados extraídos
- `002_create_email_control.sql` — tabela de controle/dedup
- `003_rls_read_policies.sql` — RLS + policies de leitura `anon`

Ambas as tabelas têm **RLS habilitado**. Ao adicionar autenticação, trocar as policies de
`TO anon` para `TO authenticated` (ver comentário na migration 003). Toda escrita passa pela
`service_role`, que ignora RLS — por isso os scripts conseguem gravar mesmo sem login.

## Convenções herdadas (do workspace)

Aplicam-se as regras globais Sheild que **não** dependem do stack: respostas em
pt-BR formal, código/identificadores em inglês, `NUMERIC(15,2)` para valores monetários,
nunca commitar `.env`. Veja `C:\Sheild\Projetos\Claude\CLAUDE.md` — mas ignore as partes
sobre monorepo TS/Express/shadcn, que não se aplicam aqui.
