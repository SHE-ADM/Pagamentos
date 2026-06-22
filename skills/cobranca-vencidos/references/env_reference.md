# Variaveis de ambiente -- skill cobranca-vencidos

Adicionar no `.env` da raiz do projeto. Variaveis ja existentes nao precisam ser duplicadas.

---

## Firebird 5

| Variavel | Exemplo | Descricao |
|---|---|---|
| `FB_HOST` | `localhost` | IP ou hostname do servidor Firebird |
| `FB_PORT` | `3050` | Porta TCP (padrao Firebird) |
| `FB_DATABASE` | `C:\Dados\empresa.fdb` | Caminho absoluto do arquivo .fdb |
| `FB_USER` | `SYSDBA` | Usuario Firebird |
| `FB_PASSWORD` | `masterkey` | Senha Firebird |
| `FB_CHARSET` | `WIN1252` | Charset do banco (WIN1252 ou UTF8) |

---

## Supabase

Ja presentes no projeto. Confirmar que existem:

| Variavel | Descricao |
|---|---|
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_SERVICE_KEY` | Chave service_role (nunca expor no frontend) |

---

## Modo desenvolvimento

| Variavel | Valores | Descricao |
|---|---|---|
| `DEV_MODE` | `true` / `false` | Se `true`, redireciona todos os envios para as caixas de teste abaixo. **Em produção: `false`** |
| `DEV_OVERRIDE_EMAIL` | `ricardo@otimotex.com.br` | Destino do **To** em modo dev. **Em produção fica comentado** no `.env` |
| `DEV_OVERRIDE_CC_EMAIL` | `ricardo@sheild.com.br` | Destino da **cópia (Cc)** em modo dev (se vazio, Cc usa o mesmo do To). Só envia Cc quando o título original tem cópia. **Em produção fica comentado** |

> **Produção (desde 2026-06-22):** `DEV_MODE=false` e as duas `DEV_OVERRIDE_*` comentadas no
> `.env` — a cobrança envia para os clientes reais (To/Cc do Firebird). Para um teste pontual,
> defina `DEV_MODE=true` e **descomente ambas** (se faltar uma, o `run.py` aborta com erro claro,
> evitando envio real por engano).

---

## SMTP

O **remetente** vem do campo `email` da tabela `company` (`company_id = 1`):

```sql
SELECT email, legal_name, trade_name
FROM   company
WHERE  company_id = 1;
```

No projeto OTIMOTEX esse mailbox (`financeiro@otimotex.com.br`) é **o mesmo usado
para recebimento (IMAP)**. Por isso, **sem configurar nada novo**, o envio reaproveita
as credenciais IMAP já presentes no `.env`:

- **host** → `SMTP_HOST` ou, na ausência, `IMAP_HOST` (`email-ssl.com.br`)
  — `smtp.locaweb.com.br` **não** atende esta conta (timeout).
- **senha** → `SMTP_PASSWORD` ou, na ausência, `IMAP_PASS` (a senha NUNCA fica no banco).
- **porta** → `SMTP_PORT` (default `587`, STARTTLS).

### Variáveis SMTP no `.env` (todas OPCIONAIS — só para override)

```env
# Só se o mailbox de envio DIFERIR do de recebimento (IMAP). Caso contrário,
# deixe em branco: o envio reaproveita IMAP_HOST / IMAP_PASS automaticamente.
# SMTP_HOST=email-ssl.com.br
# SMTP_PORT=587
# SMTP_PASSWORD=senha_do_mailbox
# SMTP_FROM_NAME=OTIMOTEX        # default: trade_name/legal_name da company
# SMTP_USER=                     # default: company.email
```

---

## Throttle / fracionamento de envio (anti-bloqueio Locaweb)

Boa prática da Locaweb para envio em lote: **fracionar** os disparos com uma pausa entre
cada e-mail, em vez de mandar todos no mesmo segundo (reduz o risco de bloqueio por limite).

```env
# Pausa (segundos) ENTRE envios reais. Default 10. 0 desliga.
# Não pausa em duplicatas puladas nem em dry-run.
COBRANCA_SEND_DELAY_SECONDS=10
```

- **Conexão**: desde 2026-06-22 o envio **reaproveita UMA conexão SMTP por lote** (`SmtpSession`
  em `email_sender.py`) — conecta no 1º envio, reusa nos demais e reconecta+reenvia 1× se a
  conexão cair. Reduz a pressão sobre o relay (`451 queue file write error`) vs. abrir conexão
  por e-mail. O throttle de 10s segue valendo entre envios reais.

---

## Entregabilidade (SPF / DKIM / DMARC) — DNS, fora do `.env`

Estado em 2026-06-22: **SPF ✅** · **DMARC ⚠️ `p=none`** · **DKIM ❌ a configurar**. O envio
**funciona sem DKIM** (o SPF já autentica), mas DKIM + DMARC mais rígido melhoram a caixa-de-entrada
em Gmail/Outlook (e, desde 2024, são exigência para remetentes em volume). Runbook:

1. **DKIM (prioritário) — gerar no painel Locaweb.**
   - Painel Locaweb → e-mail do domínio `otimotex.com.br` → **Assinatura DKIM** → ativar.
   - A Locaweb fornece um registro **TXT** (ou CNAME) com um **seletor**
     (ex.: `loc1._domainkey.otimotex.com.br`). Publicar exatamente esse registro no **DNS** do
     domínio (provedor de DNS de `otimotex.com.br`).
   - Validar: `nslookup -type=TXT loc1._domainkey.otimotex.com.br` deve retornar a chave pública
     (`v=DKIM1; k=rsa; p=...`).
2. **SPF (já existe) — confirmar.**
   - TXT em `otimotex.com.br` deve conter `include:_spf.locaweb.com.br` e terminar em `~all`.
   - Validar: `nslookup -type=TXT otimotex.com.br`.
3. **DMARC — endurecer após DKIM estável.**
   - Hoje `p=none` (só monitora). Com SPF+DKIM passando por ~1-2 semanas, subir para
     `p=quarantine` e depois `p=reject`.
   - TXT em `_dmarc.otimotex.com.br`, ex.:
     `v=DMARC1; p=quarantine; rua=mailto:dmarc@otimotex.com.br; fo=1`.
   - Validar: `nslookup -type=TXT _dmarc.otimotex.com.br`.

> Esses três passos são executados no **painel da Locaweb + DNS do domínio** — não há nada a
> mudar no código nem no `.env`.

---

## Migração futura para o SMTP transacional da Locaweb (não adquirido ainda)

Se/quando contratar o **SMTP Locaweb** (`smtp.locaweb.com.br`, produto de alto volume, com
credencial/token próprios — **não** a senha do mailbox): a virada é **só `.env`** (o código já dá
prioridade às `SMTP_*` sobre as `IMAP_*`). Preencher:

```env
# SMTP transacional Locaweb (quando contratado)
# SMTP_HOST=smtp.locaweb.com.br
# SMTP_PORT=587            # 587 TLS (STARTTLS) ou 465 SSL
# SMTP_USER=<usuário/token do painel SMTP Locaweb>
# SMTP_PASSWORD=<senha/token do SMTP Locaweb>
```
