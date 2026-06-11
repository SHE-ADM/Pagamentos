# csv_schema.md — Schema do CSV e Mapeamento por Tipo de Documento

## Configurações do CSV
- **Separador**: `;` (ponto-e-vírgula)
- **Encoding**: `utf-8-sig` (UTF-8 com BOM — compatível com Excel BR)
- **Decimal**: `.` (ponto)

## Campos

| Campo | Tipo | Tamanho | Valores | Notas |
|---|---|---|---|---|
| `source_file` | string | 255 | — | Nome do .pdf original |
| `document_type` | enum | — | boleto/nfe/nfse/fatura/recibo/contrato/outro | Auto-classificado |
| `extraction_source` | enum | — | pdf_text/pdf_vision/falha | Path utilizado |
| `supplier_name` | string | 120 | — | Razão social |
| `supplier_cnpj` | string | 14 | somente dígitos | Sem formatação |
| `invoice_number` | string | 30 | — | Null dispara revisão |
| `competence_date` | string | — | YYYY-MM | Mês de referência |
| `due_date` | date | — | YYYY-MM-DD | Vencimento |
| `issue_date` | date | — | YYYY-MM-DD | Emissão |
| `amount` | decimal | — | ponto decimal | Ex: 1234.56 |
| `currency` | string | 3 | BRL | Sempre BRL |
| `payment_method` | enum | — | boleto/pix/ted/cartão/…/outro (migration 018) | — |
| `barcode` | string | 48 | somente dígitos | Linha digitável |
| `description` | string | 500 | — | Descrição serviço/produto |
| `status` | enum | — | pendente/vencido/a vencer/…/pago/cancelado/falha (migration 018) | Default: pendente |
| `processing_notes` | string | 500 | — | Alertas de extração |
| `extracted_at` | datetime | — | ISO 8601 UTC | Timestamp extração |

## Mapeamento por Tipo de Documento

### Boleto Bancário
| Campo CSV | Campo no Documento |
|---|---|
| `supplier_name` | Cedente / Beneficiário |
| `supplier_cnpj` | CNPJ do Cedente |
| `due_date` | Vencimento |
| `amount` | Valor do Documento |
| `barcode` | Linha digitável (47-48 dígitos) |
| `invoice_number` | Nosso Número |

### NF-e (Produto)
| Campo CSV | Campo no Documento |
|---|---|
| `supplier_name` | Emitente — Razão Social |
| `supplier_cnpj` | CNPJ do Emitente |
| `invoice_number` | Número da NF |
| `issue_date` | Data de Emissão |
| `competence_date` | Mês da issue_date |
| `amount` | Valor Total da Nota |
| `description` | Primeiro item |

### NFS-e (Serviço)
| Campo CSV | Campo no Documento |
|---|---|
| `supplier_name` | Prestador — Razão Social |
| `supplier_cnpj` | CNPJ do Prestador |
| `invoice_number` | Número da Nota |
| `issue_date` | Data de Emissão |
| `competence_date` | Competência |
| `amount` | Valor dos Serviços / Valor Líquido |
| `description` | Discriminação dos Serviços |

### Fatura de Cartão / Operadora
| Campo CSV | Campo no Documento |
|---|---|
| `supplier_name` | Razão social da operadora |
| `supplier_cnpj` | CNPJ da operadora |
| `due_date` | Data de Vencimento |
| `amount` | Total da Fatura (não mínimo) |
| `barcode` | Linha digitável |
| `invoice_number` | Referência do mês |
| `competence_date` | Mês de referência |

### Documento Digitalizado (Vision)
JSON retornado pelo Claude deve conter todos os campos acima.
Campos ausentes → `null`.
