---
name: email-reader
description: >
  Skill especializada em leitura de e-mails financeiros via IMAP (Locaweb SSL),
  filtragem por palavras-chave no assunto, extração de metadados (remetente, assunto,
  data de recebimento, corpo), download automático de anexos PDF para pdfs_inbox\ e
  acionamento do pipeline extract_pdf.py para processamento imediato.

  Use esta skill SEMPRE que o usuário mencionar: ler e-mails, verificar caixa de entrada,
  baixar anexos, processar e-mails financeiros, verificar e-mails recebidos, quais e-mails
  chegaram, de quem veio, quando chegou, importar e-mails de contas a pagar, ou qualquer
  variação de leitura e processamento de e-mail financeiro. Acione mesmo que o usuário
  não diga explicitamente "skill" ou "IMAP".

project: pagamentos
version: 1.0.0
compatibility:
  python: ">=3.10"
  libs: python-dotenv, pandas
  env: IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS, ANTHROPIC_API_KEY
---

# Skill: email-reader

## Visão Geral

Lê a caixa de entrada via IMAP SSL, filtra e-mails financeiros por palavras-chave
no assunto, registra metadados de todos os e-mails identificados e processa
automaticamente os anexos PDF encontrados.

```
IMAP Locaweb (SSL 993)
       │
       ├─► Filtra por palavras-chave no assunto
       │       boleto | nota fiscal | nf-e | fatura | cobrança | vencimento
       │
       ├─► Salva metadados do e-mail
       │       remetente, assunto, data, corpo, has_attachment
       │
       ├─► Tem anexo PDF?
       │       ├── SIM → salva em data\pdfs_inbox\
       │       │          └── aciona extract_pdf.py automaticamente
       │       └── NÃO → registra metadados apenas (revisão manual)
       │
       └─► Grava tudo em data\csv_output\emails_log.csv
               + UPSERT na tabela financial_account_control (Supabase)
```

---

## Estrutura de Arquivos

```
email-reader/
├── SKILL.md
├── scripts/
│   └── read_emails.py          ← script principal
└── references/
    ├── email_schema.md         ← schema do log de e-mails
    └── imap_guide.md           ← referência IMAP / Locaweb
```

---

## Schema do Log de E-mails (emails_log.csv)

| Campo | Tipo | Descrição |
|---|---|---|
| `message_id` | string | ID único do e-mail (Message-ID header) |
| `received_at` | datetime | Data/hora de recebimento (UTC) |
| `sender_name` | string | Nome do remetente |
| `sender_email` | string | E-mail do remetente |
| `subject` | string | Assunto do e-mail |
| `body_preview` | string | Primeiros 500 chars do corpo (texto plano) |
| `has_attachment` | bool | True se tinha PDF anexado |
| `attachment_names` | string | Nomes dos PDFs separados por `|` |
| `attachment_saved` | bool | True se PDF foi salvo em pdfs_inbox |
| `pdf_extracted` | bool | True se extract_pdf.py foi acionado |
| `extraction_csv` | string | Caminho do CSV gerado pela extração |
| `keyword_matched` | string | Palavra-chave que disparou o filtro |
| `processed_at` | datetime | Timestamp do processamento (UTC) |
| `notes` | string | Observações / erros |

---

## Execução

```powershell
# Processar e-mails não lidos
python skills\email-reader\scripts\read_emails.py

# Processar e-mails dos últimos N dias (incluindo já lidos)
python skills\email-reader\scripts\read_emails.py --days 7

# Apenas listar sem baixar anexos nem acionar extração
python skills\email-reader\scripts\read_emails.py --dry-run

# Processar e marcar e-mails como lidos após processar
python skills\email-reader\scripts\read_emails.py --mark-seen
```

---

## Filtro de Palavras-chave

Palavras verificadas no assunto (case-insensitive):
`boleto`, `nota fiscal`, `nf-e`, `nfe`, `fatura`, `cobrança`, `vencimento`,
`pagamento`, `duplicata`, `recibo`, `nfs-e`, `danfe`

Configurável via variável `EMAIL_KEYWORDS` no `.env`.

---

## Integração com pdf-contas-pagar

Quando um PDF é encontrado, o script chama automaticamente:
```
extract_pdf.py --input {pdf_path} --output {csv_output}
```
O resultado é registrado nos campos `pdf_extracted` e `extraction_csv` do log.

---

## Saídas Geradas

| Arquivo | Conteúdo |
|---|---|
| `data\pdfs_inbox\{remetente}_{assunto}_{data}.pdf` | Anexo salvo |
| `data\csv_output\emails_log.csv` | Log acumulativo de todos os e-mails |
| `data\csv_output\{ts}_extracted.csv` | CSV financeiro gerado pelo extract_pdf |
| `data\csv_output\{ts}_errors.log` | Erros de extração |
