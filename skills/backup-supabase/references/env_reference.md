# Referência de variáveis `.env` — skill backup-supabase

Todas ficam no `.env` da **raiz** do projeto (o mesmo dos outros pipelines).
Somente `SUPABASE_DB_URL` é obrigatória e nova; as demais têm padrão.

## Obrigatória (nova)

| Variável | Descrição | Exemplo |
|---|---|---|
| `SUPABASE_DB_URL` | Connection string do Postgres — a **mesma** que funciona no pgAdmin (aba **Session pooler** do dashboard). Contém a senha do banco. | `postgresql://postgres.tdzlwhifwdkeyurvnryx:SENHA@aws-1-us-east-1.pooler.supabase.com:5432/postgres` |

> **Onde obter:** Supabase → projeto → botão **Connect** (topo) → aba **Session
> pooler** → copie a *connection string* e troque `[YOUR-PASSWORD]` pela senha
> do banco (a Database Password, não a senha da conta Supabase).
>
> **Por que o pooler (e não a conexão direta):** o pooler responde em IPv4; a
> conexão direta (`db.<ref>.supabase.co`) exige IPv6, ausente na maioria das
> redes. Use a porta **5432** (Session pooler) — a 6543 (Transaction) **não**
> funciona com `pg_dump`.

## Já existentes no projeto (reusadas)

| Variável | Uso nesta skill |
|---|---|
| `SUPABASE_URL` | Base da API REST do Storage |
| `SUPABASE_SERVICE_KEY` | Autenticação do Storage (ignora RLS) |

## Opcionais (têm padrão)

| Variável | Padrão | Descrição |
|---|---|---|
| `PG_DUMP_PATH` | auto-detecta | Caminho do `pg_dump.exe`. Vazio → procura PATH, PostgreSQL e pgAdmin. Defina se a detecção falhar. |
| `BACKUP_DB_SCHEMAS` | `public` | Schemas a incluir no dump (separados por vírgula). `public` cobre todas as tabelas de negócio. |
| `BACKUP_STORAGE_BUCKET` | `attachments` | Bucket do Storage a baixar. |
| `BACKUP_OUTPUT_DIR` | `backups/` na raiz | Pasta raiz onde cada execução cria `backups/<timestamp>/`. |
| `BACKUP_RETENTION_DAYS` | `30` | Backups mais antigos que isso são removidos ao final de cada execução. |
| `BACKUP_DB_TIMEOUT` | `1800` | Tempo máximo (s) do `pg_dump` antes de abortar. |

## Bloco pronto para colar no `.env`

```env
# === Backup Supabase (skill backup-supabase) ===
SUPABASE_DB_URL=postgresql://postgres.<ref>:<senha>@<host-pooler>:5432/postgres
# PG_DUMP_PATH=C:\Program Files\pgAdmin 4\v9\runtime\pg_dump.exe
# BACKUP_DB_SCHEMAS=public
# BACKUP_STORAGE_BUCKET=attachments
# BACKUP_OUTPUT_DIR=
# BACKUP_RETENTION_DAYS=30
```
