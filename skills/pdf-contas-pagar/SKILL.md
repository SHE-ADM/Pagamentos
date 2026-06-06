---
name: pdf-contas-pagar
description: >
  Skill especializada em extração de dados financeiros de PDFs de contas a pagar
  (boletos bancários, notas fiscais NF-e/NFS-e, faturas de cartão/operadoras e
  documentos digitalizados por imagem/scan) e exportação para CSV estruturado,
  compatível com o pipeline pagamentos (n8n + Supabase).

  Use esta skill SEMPRE que o usuário mencionar: ler PDF de conta, extrair boleto,
  processar nota fiscal, converter PDF para CSV, importar contas a pagar de arquivo,
  processar anexo financeiro, extrair dados de fatura, ler NF-e em PDF, processar
  recibo digitalizado, ou qualquer variação de leitura/extração de documento
  financeiro em PDF. Acione mesmo que o usuário não diga explicitamente "skill" ou "PDF".

project: pagamentos
version: 1.0.0
compatibility:
  python: ">=3.10"
  libs: pdfplumber, pypdf, pytesseract, Pillow, anthropic, pandas, python-dotenv
  env: ANTHROPIC_API_KEY
---

# Skill: pdf-contas-pagar

## Visão Geral

Esta skill processa PDFs financeiros de **quatro categorias** e gera um CSV padronizado
para ingestão no Supabase (tabela `financial_emails`) ou importação manual.

```
PDF (qualquer tipo)
    │
    ├─► Detecção automática de tipo (boleto / NF-e / fatura / scan)
    │
    ├─► Extração de texto (pdfplumber) ──► PDF digital
    │
    └─► OCR via Claude Vision ──────────► PDF escaneado / imagem
            │
            └─► JSON estruturado ──► CSV final
```

---

## Estrutura de Arquivos da Skill

```
pdf-contas-pagar/
├── SKILL.md                    ← este arquivo
├── scripts/
│   └── extract_pdf.py          ← script principal de extração
├── references/
│   ├── csv_schema.md           ← schema e mapeamento de campos por tipo
│   ├── integration_guide.md    ← como conectar com n8n e Supabase
│   └── error_handling.md       ← tratamento de erros e fallbacks
└── assets/
    └── output_template.csv     ← template de cabeçalho CSV
```

---

## Schema do CSV de Saída

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `source_file` | string | ✓ | Nome do arquivo PDF original |
| `document_type` | string | ✓ | `boleto` / `nfe` / `nfse` / `fatura` / `recibo` / `outro` |
| `extraction_source` | string | ✓ | `pdf_text` / `pdf_vision` |
| `supplier_name` | string | ✓ | Razão social do fornecedor |
| `supplier_cnpj` | string | ✓ | CNPJ (somente dígitos, 14 chars) |
| `invoice_number` | string | — | Número da NF ou documento |
| `competence_date` | date | — | Competência (YYYY-MM) |
| `due_date` | date | ✓ | Vencimento (YYYY-MM-DD) |
| `issue_date` | date | — | Emissão (YYYY-MM-DD) |
| `amount` | decimal | ✓ | Valor total (ponto como separador) |
| `currency` | string | ✓ | `BRL` (padrão) |
| `payment_method` | string | ✓ | `boleto` / `pix` / `ted` / `cartao` / `outro` |
| `barcode` | string | — | Linha digitável / código de barras |
| `description` | string | — | Descrição do serviço/produto |
| `status` | string | ✓ | `pending` (default na extração) |
| `processing_notes` | string | — | Alertas de extração incompleta |
| `extracted_at` | datetime | ✓ | Timestamp ISO 8601 da extração |

**Regra de qualidade:** se `invoice_number` for null → `processing_notes = 'Revisão manual necessária'`

---

## Fluxo de Execução

### Passo 1 — Detectar tipo de PDF

```bash
pdffonts arquivo.pdf   # fontes presentes = digital | vazio = scan
pdfinfo arquivo.pdf    # metadados gerais
```

### Passo 2 — Executar extração

```bash
# PDF único
python scripts\extract_pdf.py --input caminho\arquivo.pdf --output data\csv_output\

# Lote (pasta inteira)
python scripts\extract_pdf.py --input data\pdfs_inbox\ --output data\csv_output\ --batch

# Forçar Vision mesmo em PDF digital
python scripts\extract_pdf.py --input arquivo.pdf --output data\csv_output\ --force-vision
```

### Passo 3 — Verificar saída

- `{timestamp}_extracted.csv` — registros com extração bem-sucedida
- `{timestamp}_errors.log` — arquivos com falha e motivo

---

## Regras de Extração por Tipo de Documento

### Boleto Bancário
- Keywords: `BOLETO`, `CEDENTE`, `BENEFICIÁRIO`, `LINHA DIGITÁVEL`
- `barcode` = linha digitável (47-48 dígitos)
- `supplier_name` = campo Cedente/Beneficiário

### NF-e / NFS-e
- Keywords: `DANFE`, `NF-e`, `NFS-e`, `NOTA FISCAL`, chave acesso 44 dígitos
- `supplier_cnpj` = CNPJ do emitente (não do tomador)
- `competence_date` = mês de referência do serviço

### Fatura de Cartão / Operadoras
- Keywords: `FATURA`, nome de operadora
- `amount` = total da fatura (não valor mínimo)

### Documento Digitalizado
- Sempre `extraction_source = pdf_vision`
- Vision retorna JSON direto — ver references/csv_schema.md

---

## Tratamento de Erros

| Situação | Ação |
|---|---|
| PDF protegido por senha | Log de erro, pula arquivo |
| Texto extraído < 80 chars | Fallback automático para Vision |
| invoice_number null | `processing_notes` = 'Revisão manual necessária' |
| Arquivo corrompido | Exceção capturada, log detalhado |

Ver detalhes completos em `references/error_handling.md`

---

## Integração com pagamentos

- **n8n**: chamar via node `Execute Command`
- **Supabase**: CSV compatível com tabela `financial_emails`
- **Deduplicação**: por `source_file` ou `gmail_message_id`

Ver `references/integration_guide.md`
