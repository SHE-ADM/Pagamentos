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
      │                                        │
      │                          ┌─────────────┼────────────────────────────┐
      │                          │ /emails     │ /consulta      /erros       │
      │                          │ email_control  financial_emails  errors   │
      │                          │   fetch direto Supabase REST (anon key)  │
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

Reprocessar PDFs que falharam na extração (`status=downloaded`, `pdf_extracted=false`):

```powershell
# Usar py -3, não python — garante sys.executable com pdfplumber disponível
py -3 scripts\retry_extraction.py
py -3 scripts\retry_extraction.py --dry-run
```

Extração de PDF isolada:

```powershell
py -3 skills\pdf-contas-pagar\scripts\extract_pdf.py --input data\pdfs_inbox\ --output data\csv_output\ --batch
```

Dependências:

```powershell
pip install pdfplumber pypdf anthropic pandas python-dotenv Pillow flask
cd app && npm install
```

Não há suíte de testes automatizados. Validação é manual:
use `--dry-run` na CLI ou `{"dry_run": true}` no `POST /api/emails/read`.

## Pontos-chave que exigem ler vários arquivos

### `run_reader()` é a única fonte de verdade da leitura

`skills/email-reader/scripts/read_emails.py` — tanto o CLI (`main()`) quanto a API
(`server/app.py`) chamam `run_reader()`. Ao mudar a lógica de leitura, edite só
`run_reader` — nunca duplique no Flask.

`read_emails.py` carrega o `.env` da raiz por conta própria (`load_dotenv(parents[3]/".env")`).
O `server/app.py` insere o caminho no `sys.path` e importa o módulo — não recarrega env.

### Deduplicação por `message_id`

Gravado em `email_control.message_id` (UNIQUE). `register()` usa `Prefer: resolution=ignore-duplicates` —
mensagens já processadas são silenciosamente ignoradas, sem atualizar o registro existente.
Se o Supabase estiver indisponível, o script cai para dedup/log local em CSV (`SupabaseControl._available`).

### Duas chaves Supabase, dois papéis

- **`anon`** (`VITE_SUPABASE_ANON_KEY`): usada pelo frontend para leitura via fetch direto à REST API.
  Respeita RLS (policies de `SELECT` sem autenticação, definidas na migration 003).
- **`service_role`** (`SUPABASE_SERVICE_KEY`): usada pelos scripts Python e Flask para escrita.
  Ignora RLS — por isso os scripts conseguem gravar sem login.

### Normalização de `document_type`

`extract_pdf.py` usa `_ns()` — equivalente Python do `normalize_search()` do PostgreSQL
(strip de acentos via `unicodedata` + lowercase). Aplicado em ambos os lados (field e value)
do lookup em `_DOC_TYPE_NORM`, garantindo matching case e accent insensitive.

O CHECK constraint em `financial_emails.document_type` usa `lower(document_type)` (migration 014),
aceitando qualquer casing na gravação. Tipos aceitos: `boleto`, `cte`, `nfe`, `nfse`,
`tributo`, `seguro`, `fatura`, `recibo`, `contrato`, `outro`.

Tipos que **não geram conta a pagar** e são ignorados pelo pipeline: `nfe`, `nfse` —
definidos em `SKIP_ACCOUNT_TYPES` em `read_emails.py` (lowercase, comparados com `.lower()`).

### Auto-resolução de fornecedor

Ao inserir em `financial_emails`, o trigger `trg_fe_supplier_id` (BEFORE INSERT OR UPDATE)
chama `resolve_supplier_id(cnpj, cpf, name)` que:
1. Busca por CNPJ ou CPF exato
2. Fallback: `normalize_search(legal_name) = normalize_search(p_name)` — case e accent insensitive
3. Se não encontrar: auto-insere na tabela `supplier` e retorna o novo `id`

`normalize_search()` é uma função PostgreSQL SECURITY DEFINER — não exposta via RLS.

### `extraction_source` distingue a origem dos dados

- `email_body` — extraído do corpo do e-mail
- `pdf_text` — PDF digital com texto legível (pdfplumber)
- `pdf_vision` — PDF escaneado via Claude Vision (exige poppler no PATH)
- `error` — falha na extração

### Frontend — rotas e serviços

Três páginas em `app/src/pages/`:

| Rota | Componente | Tabela principal |
|---|---|---|
| `/emails` | `Emails.jsx` | `email_control` + detalhes de `financial_emails` por `message_id` |
| `/consulta` | `Consulta.jsx` | `financial_emails` (paginado, filtros, exportação CSV client-side) |
| `/erros` | `Erros.jsx` | `email_processing_errors` |

Dois serviços em `app/src/services/`:
- `supabase.js` — `fetch` direto à REST API do Supabase com PostgREST query params
  (sem SDK). Usa `Prefer: count=exact` + `Content-Range` para paginação.
- `emailReader.js` — `POST /api/emails/read` para o Flask local (proxiado pelo Vite em dev).
  Lança erro descritivo quando o backend não está rodando.

## Banco de dados (Supabase)

Migrations versionadas em `supabase/migrations/`, aplicadas **manualmente no SQL Editor**
em ordem (`001` → `014`). Não há ferramenta de migration automática.

Tabelas principais:

| Tabela | Propósito |
|---|---|
| `email_control` | Dedup/controle de cada e-mail. `status` ∈ (received, downloaded, extracted, error, ignored) |
| `financial_emails` | Dados extraídos dos PDFs. Uma linha por documento financeiro |
| `email_processing_errors` | Log de falhas com `raw_payload` JSON para diagnóstico |
| `supplier` | Fornecedores auto-criados pelo trigger `trg_fe_supplier_id` |

RLS habilitado em todas as tabelas. Ao adicionar autenticação, trocar as policies de
`TO anon` para `TO authenticated` (ver comentário na migration 003).

## Windows Task Scheduler

`scheduler/run_reader.ps1` roda a cada **1 hora** via Task Scheduler. Detecta automaticamente
o Python com `pdfplumber` importável (ordem: `py -3.12`, `-3.13`, `-3.11`, `-3.10`, `-3`, PATH),
evitando o build free-threaded `python3.14t.exe`. Logs diários em
`logs/scheduler/reader_YYYYMMDD.log`, retidos por 30 dias.

Caminho do projeto na máquina de produção: `C:\Sheild\API\Pagamentos`
(diferente do ambiente de desenvolvimento `C:\Sheild\Projetos\Claude\Contas a pagar\Pagamentos`).

## Convenções herdadas (do workspace)

Aplicam-se as regras globais Sheild que **não** dependem do stack: respostas em
pt-BR formal, código/identificadores em inglês, `NUMERIC(15,2)` para valores monetários,
nunca commitar `.env`. Veja `C:\Sheild\Projetos\Claude\CLAUDE.md` — mas ignore as partes
sobre monorepo TS/Express/shadcn, que não se aplicam aqui.
