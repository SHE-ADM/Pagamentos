# error_handling.md — Tratamento de Erros e Fallbacks

## Tabela de Erros

| Situação | Ação | processing_notes |
|---|---|---|
| PDF protegido por senha | Pula, registra no .log | `'PDF protegido por senha'` |
| Texto < 80 chars | Fallback automático Vision | `'Texto insuficiente'` |
| `pdffonts` não instalado | Assume digital, continua | Warning no console |
| `pdftoppm` não instalado | Vision falha — erro | `'poppler não instalado'` |
| ANTHROPIC_API_KEY ausente | Abort — EnvironmentError | `'ANTHROPIC_API_KEY não configurada'` |
| Vision retorna JSON inválido | Campos null | `'Vision retornou resposta não-JSON'` |
| Arquivo corrompido | Log detalhado, pula | Mensagem da exceção |
| `invoice_number` null | Continua — flag revisão | `'Revisão manual necessária'` |
| Valor não encontrado | `amount = null` | `'Valor não identificado'` |

## Hierarquia de Fallback

```
1. pdffonts → fontes?
   ├── SIM  → pdfplumber
   │           └── texto >= 80 chars → OK
   │               texto < 80 chars  → Vision (fallback)
   └── NÃO  → Vision direto

2. Vision → JSON válido?
   ├── SIM → build_record com JSON
   └── NÃO → campos null + nota revisão

3. Qualquer exceção → entrada no _errors.log
```

## Reprocessar Erros (PowerShell)

```powershell
# Reprocessar arquivos que falharam com Vision forçado
$log = Get-Content "data\csv_output\*_errors.log" | Select-Object -First 1
$arquivo = ($log -split '\|')[0].Trim()

python skills\pdf-contas-pagar\scripts\extract_pdf.py `
  --input "data\pdfs_inbox\$arquivo" `
  --output "data\csv_output\" `
  --force-vision
```
