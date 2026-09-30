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

O **remetente** (campo `From`) vem do campo `email` da tabela `company` (`company_id = 1`):

```sql
SELECT email, legal_name, trade_name
FROM   company
WHERE  company_id = 1;
```

No projeto OTIMOTEX o remetente é `financeiro@otimotex.com.br` (o mesmo mailbox do
recebimento IMAP). **Desde 2026-06-25 o envio usa o SMTP transacional da Locaweb**
(`smtplw.com.br`, produto de alto volume com credencial/token PRÓPRIA do painel —
**não** a senha do mailbox). O código prioriza as `SMTP_*` sobre as `IMAP_*`, então
basta preencher o bloco abaixo no `.env` da raiz:

```env
# === Locaweb SMTP transacional (cobranca-vencidos) — ATIVO ===
SMTP_HOST=smtplw.com.br
SMTP_PORT=587            # 587 STARTTLS (usado pelo código) | 465 SSL/TLS
SMTP_USER=otimotex1      # usuário do painel SMTP Locaweb (NÃO o e-mail)
SMTP_PASSWORD=<senha/token do painel SMTP>
# SMTP_FROM_NAME=OTIMOTEX   # opcional — default: trade_name/legal_name da company
SMTP_FROM_ADDR=financeiro@envio.otimotex.com.br   # OBRIGATÓRIO p/ preservar o remetente
```

> 🔴 **O From TEM de estar no domínio do Return Path (`@envio.otimotex.com.br`).** Com
> `financeiro@otimotex.com.br` no From, o relay reescreve From, Return-Path e DKIM para
> `@smtplw-12.com` — mesmo com o Return Path "Verificado" e o endereço "Confirmado" no painel.
> Diagnosticado pelos cabeçalhos e confirmado pelo suporte Locaweb em 2026-09-30.
>
> Com `SMTP_FROM_ADDR` diferente do mailbox, o código envia **`Reply-To`** = e-mail da
> `company` (`financeiro@otimotex.com.br`): o subdomínio `envio` **não recebe e-mail** (o MX dele
> é o bounce da Locaweb), então sem o Reply-To a resposta do cliente se perderia em silêncio.
> Valor malformado em `SMTP_FROM_ADDR` falha o lote (`ValueError`) em vez de enviar errado.

### Fallback (sem `SMTP_*`) — credenciais do mailbox IMAP

Se o bloco `SMTP_*` for removido, o envio cai no caminho legado, reaproveitando as
credenciais IMAP já presentes no `.env`:

- **host** → `IMAP_HOST` (`email-ssl.com.br`) — `smtp.locaweb.com.br` **não** atende esta conta (timeout).
- **senha** → `IMAP_PASS` (a senha do mailbox NUNCA fica no banco).
- **porta** → `587` (STARTTLS).

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

Estado em 2026-09-30: **SPF ✅** · **DKIM ✅** · **Return Path ✅ no painel** — mas só vale no envio
com `SMTP_FROM_ADDR` no subdomínio (ver o aviso ao fim desta seção). Configurado via o produto
**"Domínio de Remetente" do painel SMTP Locaweb** (`smtplw.com.br/panel/settings/return_path`),
que usa o subdomínio dedicado `envio.otimotex.com.br` — não o `otimotex.com.br` raiz nem um
seletor manual. Registros publicados e confirmados por consulta pública ao DNS:

| Registro | Host | Conteúdo | Status no painel |
|---|---|---|---|
| CNAME | `envio.otimotex.com.br` | `smtplw.com` | Autenticado |
| CNAME DMARC | `_dmarc.envio.otimotex.com.br` | `_dmarc.smtpdlv.com.br` | Autenticado |
| TXT DKIM | `smtp._domainkey.envio.otimotex.com.br` | `k=rsa; p=MIGf...` | Autenticado |

Validar (deve retornar exatamente os valores acima):

```powershell
nslookup -type=CNAME envio.otimotex.com.br
nslookup -type=CNAME _dmarc.envio.otimotex.com.br
nslookup -type=TXT smtp._domainkey.envio.otimotex.com.br
```

> **Não confundir com "Endereços de remetente"** (`smtplw.com.br/panel/settings/emails`) — tela
> separada e **não obrigatória** desde a mudança de política do Google. Ter `otimotex.com.br` e
> `financeiro@otimotex.com.br` confirmados ali **NÃO** impede a reescrita do From.

> ⚠️ **Painel + DNS verificados NÃO bastam.** De 2026-09-01 a 2026-09-30 tudo aparecia
> "Autenticado" e os e-mails saíam como `financeiro@smtplw-12.com`. O que faz o Return Path valer
> é o **From no subdomínio** — `SMTP_FROM_ADDR` no `.env` (seção acima). Para conferir, olhar os
> cabeçalhos recebidos: `From`, `Return-Path` e `DKIM-Signature d=` devem estar em
> `envio.otimotex.com.br`.

---

## Histórico — migração para o SMTP transacional da Locaweb (CONCLUÍDA em 2026-06-25)

O SMTP transacional (`smtplw.com.br`) foi **contratado e ativado** em 2026-06-25. A virada
foi **só `.env`** (o código já priorizava as `SMTP_*` sobre as `IMAP_*`) — ver a seção SMTP
acima para as variáveis ativas. Antes disso, o envio reaproveitava as credenciais do mailbox
IMAP (`email-ssl.com.br` + `IMAP_PASS`), que segue como fallback se as `SMTP_*` forem removidas.
