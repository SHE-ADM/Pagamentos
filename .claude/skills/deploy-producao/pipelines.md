# Os 4 pipelines — o que copiar e como validar

Referência da skill `deploy-producao`. O **procedimento** está no `SKILL.md`; aqui ficam as
particularidades de cada pipeline. Destino em todos: `C:\Sheild\API\Pagamentos\`.

## Regra geral — o que a mudança exige

| Mudou… | Copiar | Re-registrar tarefa? |
|---|---|---|
| Lógica do pipeline (`.py` em `skills\…\scripts\`) | os `.py` alterados (conjunto interdependente) | Não |
| Wrapper/agendador **funcional** (`.ps1` — horário, timeout, runner) | o `.ps1` alterado | **Sim**, se mudou `setup-*-task.ps1` |
| Só comentário/doc (sem efeito funcional) | nada | Não |

A tarefa agendada inicia um **processo novo** a cada disparo e lê os arquivos do disco — **nunca é
preciso reiniciar nada**.

---

## 1. Email Reader (leitura, a cada 5 min)

**Copiar** — `skills\email-reader\scripts\read_emails.py`,
`skills\pdf-contas-pagar\scripts\extract_pdf.py`, `skills\pdf-contas-pagar\scripts\febraban.py`,
`skills\pdf-contas-pagar\scripts\fiscal_key.py`, `skills\pdf-contas-pagar\scripts\cte_content.py`
(os que tiverem mudado) **+ `scheduler\deploy-manifest.json`**.

🔴 **Interdependentes.** `read_emails.py` chama `extract_pdf.extract_to_csv()` **in-process**; e
`extract_pdf.py` importa `febraban` e `fiscal_key` **no topo** — módulo ausente ⇒ `ImportError` ⇒
**nenhum PDF extraído**. Copie o módulo novo primeiro, ou todos juntos.

⚠️ **`cte_content.py` é ARQUIVO NOVO (Onda 5, 2026-08-12)** — conteúdo do CT-e (rota, peso, NF
transportada, frete) a partir da fatura agregada. Ao contrário de `febraban`/`fiscal_key`, ele é
importado **lazy** pelo `read_emails.py`, então a ausência **degrada com aviso**
(`modulo 'cte_content' indisponivel … Deploy parcial?`) em vez de parar a extração. É mais
brando, e por isso mais fácil de esquecer: o pipeline segue verde gravando os documentos **sem**
peso/rota/frete, e o único sinal fica no log. Confira o aviso depois do primeiro ciclo.

**Dependência:** `pypdf` (desde 2026-06-29, boleto com senha + split de carnê) —
`py -3 -m pip install "pypdf~=6.13"`. Sem ele, `import extract_pdf` falha e a extração para.

**Validar** (o comando exato depende da mudança; ver Passo 4 do `SKILL.md`):

```powershell
py -3 -c "import sys; sys.path.insert(0,'skills/email-reader/scripts'); import read_emails as R; print(hasattr(R,'<simbolo novo>'))"
```

---

## 2. Cobrança de vencidos (envios, 08:00)

**Copiar** — a pasta `skills\cobranca-vencidos\scripts\` inteira (8 arquivos).

🔴 **8 scripts INTERDEPENDENTES.** `run.py` (batch) e `resend.py` (reenvio) dependem de
`send_core.py`; este de `email_sender`/`supabase_log`/`template`; e `run.py` também de
`failure_notify`. Copiar só um dá `ImportError`. **Na dúvida, copie o conjunto:** `db_firebird.py`,
`email_sender.py`, `failure_notify.py`, `resend.py`, `run.py`, `send_core.py`, `supabase_log.py`,
`template.py`.

**Pré-requisitos (diferentes do reader):** driver Firebird **`fdb`** instalado; `.env` com
`FB_HOST`/`FB_PORT`/`FB_DATABASE`/`FB_USER`/`FB_PASSWORD`/`FB_CHARSET` **e** o bloco SMTP
transacional (`SMTP_HOST=smtplw.com.br`, `SMTP_PORT=587`, `SMTP_USER`, `SMTP_PASSWORD`) —
sem ele cai no fallback IMAP, que tem o gargalo `451`. Mais `COBRANCA_SEND_DELAY_SECONDS` (10s).

**Validar** — o `--dry-run` cobre imports **e** a conexão Firebird, sem enviar e-mail:

```powershell
py -3 skills\cobranca-vencidos\scripts\run.py --dry-run
```

⚠️ Está em produção com `DEV_MODE=false` (envia para clientes reais). Rode o `--dry-run` depois de
qualquer alteração, antes de confiar na próxima execução agendada.

---

## 3. Backup do Supabase (02:00)

**Copiar** — a pasta `skills\backup-supabase\` inteira (5 módulos irmãos: `config.py`,
`backup_db.py`, `backup_storage.py`, `retention.py`, `run.py`) + `scheduler\run_backup.ps1` +
`scheduler\setup-backup-task.ps1`.

🔴 **Pré-requisito NÃO ÓBVIO — `pg_dump` ≥ 17 na máquina.** O servidor é PG 17; um `pg_dump` 16
aborta com "server version mismatch". Produção pode não ter pgAdmin: instale o PostgreSQL 17+
client ou aponte `PG_DUMP_PATH` no `.env`.

**`.env` precisa de `SUPABASE_DB_URL`** — a mesma connection string do pgAdmin (**Session pooler**,
IPv4, porta **5432**; a 6543/Transaction não funciona com `pg_dump`), senha URL-encoded.

**Validar** — o `--dry-run` detecta o `pg_dump` e confere a variável, mas **não testa a senha**:

```powershell
py -3 skills\backup-supabase\scripts\run.py --dry-run
py -3 skills\backup-supabase\scripts\run.py --skip-storage   # dump real, valida a senha
```

**Disco:** backup é completo todo dia × retenção 30 dias. Se apertar, baixe `BACKUP_RETENTION_DAYS`.

---

## 4. Baixa automática (reconciliação, 08:00)

**Copiar** — a pasta `skills\baixa-automatica\` inteira + `scheduler\run_baixa.ps1` +
`scheduler\setup-baixa-task.ps1`.

**Sem dependência nova** (`urllib` + `python-dotenv`) e **sem `.env` novo** (reusa
`SUPABASE_URL`/`SUPABASE_SERVICE_KEY`). `run.py` é módulo isolado — basta a pasta.

**Validar** — o `--dry-run` reporta a contagem das DUAS regras (baixa + marcação de vencidos) sem
gravar:

```powershell
py -3 skills\baixa-automatica\scripts\run.py --dry-run
```

🔴 **Regra 1 (baixa para `pago`) é espelhada no frontend** (`qualifiesForAutoPago` em
`Consulta.tsx`, que sai pelo Vercel). Ao mudar essa regra, ajuste **os dois lados**. A Regra 2
(vencidos) vive só neste batch.

⚠️ Coincide às 08:00 com a Cobrança de vencidos — são independentes (bancos e sistemas distintos),
rodam em paralelo sem conflito.
