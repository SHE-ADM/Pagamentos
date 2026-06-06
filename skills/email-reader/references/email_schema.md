# email_schema.md — Schema do Log de E-mails

## Arquivo: data\csv_output\emails_log.csv
- **Separador**: `;`
- **Encoding**: `utf-8-sig`
- **Modo**: append acumulativo (nunca sobrescreve)
- **Deduplicação**: por `message_id` — mesmo e-mail nunca é processado duas vezes

## Campos

| Campo | Tipo | Descrição |
|---|---|---|
| `message_id` | string | Message-ID do header MIME — identificador único global |
| `received_at` | datetime ISO | Data/hora de recebimento (UTC) |
| `sender_name` | string | Nome do remetente (decodificado de MIME) |
| `sender_email` | string | Endereço de e-mail do remetente |
| `subject` | string | Assunto do e-mail (decodificado) |
| `body_preview` | string | Primeiros 500 chars do corpo em texto plano |
| `has_attachment` | bool | True se havia PDF anexado |
| `attachment_names` | string | Nomes dos PDFs salvos separados por `\|` |
| `attachment_saved` | bool | True se PDF foi gravado em pdfs_inbox |
| `pdf_extracted` | bool | True se extract_pdf.py foi acionado com sucesso |
| `extraction_csv` | string | Caminho do CSV gerado pela extração |
| `keyword_matched` | string | Palavra-chave que disparou o filtro |
| `processed_at` | datetime ISO | Timestamp de quando o script processou |
| `notes` | string | Observações, alertas ou mensagem de erro |

## Casos de uso do log

### Ver todos os e-mails recebidos hoje
```powershell
python -c "
import pandas as pd
df = pd.read_csv(r'data\csv_output\emails_log.csv', sep=';')
df['received_at'] = pd.to_datetime(df['received_at'])
hoje = df[df['received_at'].dt.date == pd.Timestamp.today().date()]
print(hoje[['received_at','sender_email','subject','has_attachment']].to_string())
"
```

### Ver e-mails sem PDF (revisão manual necessária)
```powershell
python -c "
import pandas as pd
df = pd.read_csv(r'data\csv_output\emails_log.csv', sep=';')
sem_pdf = df[df['has_attachment'] != True]
print(sem_pdf[['received_at','sender_email','subject','notes']].to_string())
"
```

### Ver falhas de extração
```powershell
python -c "
import pandas as pd
df = pd.read_csv(r'data\csv_output\emails_log.csv', sep=';')
falhas = df[(df['has_attachment'] == True) & (df['pdf_extracted'] != True)]
print(falhas[['received_at','subject','attachment_names','notes']].to_string())
"
```
