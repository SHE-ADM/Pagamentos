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
| `DEV_MODE` | `true` / `false` | Se `true`, redireciona todos os envios para as caixas de teste abaixo |
| `DEV_OVERRIDE_EMAIL` | `ricardo@otimotex.com.br` | Destino do **To** em modo dev |
| `DEV_OVERRIDE_CC_EMAIL` | `ricardo@sheild.com.br` | Destino da **cópia (Cc)** em modo dev (se vazio, Cc usa o mesmo do To). Só envia Cc quando o título original tem cópia |

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
# Pausa (segundos) ENTRE envios reais. Default 3 (faixa recomendada 2-5). 0 desliga.
# Não pausa em duplicatas puladas nem em dry-run.
# COBRANCA_SEND_DELAY_SECONDS=3
```

- **Conexão**: o script já abre uma conexão SMTP **nova por e-mail** (connect → STARTTLS →
  login → envio → quit), atendendo a recomendação de "fechar e abrir nova conexão".
- **Autenticação de domínio (DNS, painel do provedor — fora do `.env`)**: configurar
  **SPF**, **DKIM** e **DMARC** para `otimotex.com.br` melhora a entregabilidade em
  Gmail/Outlook. Verifique no painel de DNS:
  - SPF: TXT com `v=spf1 include:_spf.locaweb.com.br ... ~all`
  - DKIM: TXT no seletor informado pela Locaweb (`<seletor>._domainkey.otimotex.com.br`)
  - DMARC: TXT em `_dmarc.otimotex.com.br` (`v=DMARC1; p=...`)
