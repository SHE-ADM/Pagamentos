# SKILL: backup-supabase

## O que faz

Backup diário e automático do Supabase deste projeto:

1. **Banco de dados** — `pg_dump` no formato *custom* (comprimido e restaurável
   com `pg_restore`) do(s) schema(s) configurado(s) (padrão: `public`, que contém
   todas as tabelas de negócio).
2. **Storage** — baixa **todos** os arquivos do bucket `attachments` (os PDFs/
   imagens originais das contas) via API REST.
3. **Manifesto + retenção** — grava um `manifest.json` por execução e remove
   backups mais antigos que a janela de retenção (padrão: 30 dias).

Roda por `py -3` (Windows Task Scheduler), **independente** do Flask/Next —
mesmo padrão das skills `email-reader` e `cobranca-vencidos`.

> O **esquema** (DDL, funções, triggers, RLS) também está versionado em
> `supabase/migrations/` (git). O `pg_dump` custom já traz esquema + dados; as
> migrations são a segunda linha de recuperação.

---

## Arquitetura

```
Windows Task Scheduler (02:00 diário)
        │
        ▼
scheduler/run_backup.ps1  ──►  skills/backup-supabase/scripts/run.py
        │
        ├── pg_dump (subprocess) ──► Supabase Postgres (SUPABASE_DB_URL)
        │       └── backups/<ts>/db/db_postgres_public.dump
        │
        ├── Storage REST (urllib) ──► bucket attachments (SUPABASE_SERVICE_KEY)
        │       └── backups/<ts>/storage/attachments/<arquivos>
        │
        ├── backups/<ts>/manifest.json   (resumo da execução)
        └── retenção: remove backups/<ts> além de BACKUP_RETENTION_DAYS dias
```

Estrutura de um backup:

```
backups/
└── 2026-07-03_020000/
    ├── db/
    │   └── db_postgres_public.dump      ← pg_restore para restaurar
    ├── storage/
    │   └── attachments/
    │       └── <mesma árvore do bucket>
    └── manifest.json
```

---

## Estrutura de arquivos

```
skills/backup-supabase/
├── SKILL.md                     ← este arquivo
├── scripts/
│   ├── run.py                   ← entry-point (Task Scheduler aponta aqui)
│   ├── config.py                ← .env, caminhos, detecção do pg_dump
│   ├── backup_db.py             ← pg_dump (senha via PGPASSWORD, fora do argv)
│   ├── backup_storage.py        ← list + download do bucket (REST/urllib)
│   └── retention.py             ← remove backups > N dias
└── references/
    └── env_reference.md         ← todas as variáveis .env desta skill
```

---

## Dependências

| Item | Uso | Status |
|---|---|---|
| `python-dotenv` | Carregar .env | ✅ já no projeto |
| `urllib` / `subprocess` / `json` | Storage + pg_dump + manifesto | ✅ stdlib |
| **`pg_dump.exe`** | Dump do banco | ⚠️ **externo** — ver abaixo |

**Não há dependência Python nova.** O único requisito externo é o **`pg_dump`**:

- O **pgAdmin** (já instalado) traz um em
  `C:\Program Files\pgAdmin 4\<versão>\runtime\pg_dump.exe`.
- O `config.py` detecta automaticamente instalações comuns; se não achar,
  defina `PG_DUMP_PATH` no `.env`.
- **Versão:** o servidor é PostgreSQL **17**. O `pg_dump` precisa ser **≥ 17**
  (um `pg_dump` 16 contra servidor 17 aborta com "server version mismatch"). Se
  o pgAdmin instalado for antigo, instale o **PostgreSQL 17 client** de
  postgresql.org.

---

## Configuração `.env`

Adicionar na raiz do projeto (detalhes em `references/env_reference.md`):

```env
# === Backup Supabase ===
# A MESMA connection string que funciona no pgAdmin (aba Session pooler):
SUPABASE_DB_URL=postgresql://postgres.tdzlwhifwdkeyurvnryx:SENHA@aws-1-us-east-1.pooler.supabase.com:5432/postgres

# Opcionais (têm padrão):
# PG_DUMP_PATH=                 # auto-detecta pgAdmin/PostgreSQL se vazio
# BACKUP_DB_SCHEMAS=public      # schemas a incluir (vírgula separa)
# BACKUP_STORAGE_BUCKET=attachments
# BACKUP_OUTPUT_DIR=            # padrão: backups/ na raiz
# BACKUP_RETENTION_DAYS=30
```

`SUPABASE_URL` e `SUPABASE_SERVICE_KEY` já existem no `.env` (usados pelo Storage).

---

## Execução manual (teste)

```powershell
# Valida config + conectividade SEM gravar nada (recomendado na 1ª vez):
py -3 skills/backup-supabase/scripts/run.py --dry-run

# Backup completo (banco + Storage):
py -3 skills/backup-supabase/scripts/run.py

# Só o banco / só o Storage:
py -3 skills/backup-supabase/scripts/run.py --skip-storage
py -3 skills/backup-supabase/scripts/run.py --skip-db
```

O wrapper do agendador aceita o mesmo dry-run:

```powershell
& scheduler\run_backup.ps1 -DryRun
```

---

## Agendamento (Windows Task Scheduler)

Registrar UMA VEZ, em janela PowerShell **como Administrador**:

```powershell
cd "C:\Sheild\Projetos\Claude\Contas a pagar\Pagamentos"
.\scheduler\setup-backup-task.ps1
```

Cria a tarefa **"Pagamentos - Backup Supabase"** na pasta `\Sheild\` do
Agendador (mesma dos outros dois pipelines), disparo diário **02:00**, timeout
120 min. Logs em `logs\backup\backup_YYYYMMDD.log` (retidos 30 dias).

```powershell
# Rodar agora, sem esperar as 02:00:
Start-ScheduledTask -TaskPath "\Sheild\" -TaskName "Pagamentos - Backup Supabase"

# Último resultado:
Get-ScheduledTaskInfo -TaskPath "\Sheild\" -TaskName "Pagamentos - Backup Supabase"
```

---

## Restaurar um backup

```powershell
# Banco (formato custom -> pg_restore). Restaura em um banco/projeto novo:
pg_restore --dbname="postgresql://postgres:<senha>@<host>:5432/postgres" `
           --no-owner --no-privileges --clean --if-exists `
           "backups\<ts>\db\db_postgres_public.dump"

# Storage: re-upload dos arquivos de backups\<ts>\storage\attachments\ para o
# bucket (via Storage API / dashboard) — os nomes de arquivo são a chave do objeto.
```

> Exit code do `run.py`: **0** = sucesso; **≠ 0** = falha operacional (banco ou
> Storage) — o `run_backup.ps1` marca a tarefa como vermelha e grava no Event
> Log (`Pagamentos-Backup`, EventId 1003).
