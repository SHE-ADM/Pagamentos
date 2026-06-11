# integration_guide.md — Integração com n8n e Supabase

## Pipeline Completo

```
Email IMAP ──► n8n
                ├── Salva PDFs em data\pdfs_inbox\
                └── Execute Command → extract_pdf.py
                         └── CSV gerado
                              └── n8n lê CSV → Supabase UPSERT
```

## n8n — Node Execute Command

```
Command:  python
Args:     C:\Sheild\Projetos\Claude\Contas a pagar\Pagamentos\skills\pdf-contas-pagar\scripts\extract_pdf.py
          --input {{ $json.attachment_path }}
          --output C:\Sheild\Projetos\Claude\Contas a pagar\Pagamentos\data\csv_output\
```

## n8n — UPSERT no Supabase (HTTP Request)

```
Method:  POST
URL:     {{ $env.SUPABASE_URL }}/rest/v1/financial_account_control
Headers:
  apikey:        {{ $env.SUPABASE_SERVICE_KEY }}
  Authorization: Bearer {{ $env.SUPABASE_SERVICE_KEY }}
  Content-Type:  application/json
  Prefer:        resolution=merge-duplicates

Body:
{
  "source_file":       "{{ $json.source_file }}",
  "document_type":     "{{ $json.document_type }}",
  "extraction_source": "{{ $json.extraction_source }}",
  "supplier_name":     "{{ $json.supplier_name }}",
  "supplier_cnpj":     "{{ $json.supplier_cnpj }}",
  "invoice_number":    "{{ $json.invoice_number }}",
  "due_date":          "{{ $json.due_date }}",
  "amount":            "{{ $json.amount }}",
  "currency":          "BRL",
  "payment_method":    "{{ $json.payment_method }}",
  "barcode":           "{{ $json.barcode }}",
  "description":       "{{ $json.description }}",
  "status":            "pendente",
  "processing_notes":  "{{ $json.processing_notes }}",
  "extracted_at":      "{{ $json.extracted_at }}"
}
```

## Supabase — Executar migração

Cole o conteúdo de `supabase\migrations\018_create_financial_account_control.sql`
no **SQL Editor** do Supabase e execute.

## Instalação das dependências

```powershell
pip install pdfplumber pypdf anthropic pandas python-dotenv Pillow

# poppler (necessário para PDFs escaneados)
# 1. Baixar: https://github.com/oschwartz10612/poppler-windows/releases
# 2. Extrair em C:\poppler\
# 3. Adicionar C:\poppler\Library\bin ao PATH do sistema
```
