import { z } from 'zod';

// Schema da tabela `financial_emails` — uma linha por documento financeiro.
// Reflete o estado das migrations 001, 004 (due_status), 005 (campos de
// boleto), 006/014 (document_type), 009 (supplier_cpf/supplier_id) e 016
// (email_body_excerpt). Campos monetários chegam como string ou número pela
// REST do Supabase — `z.coerce.number()` normaliza ambos.

// ── Enums de domínio (espelham os CHECK constraints) ────────────────────────

export const DOCUMENT_TYPES = [
  'boleto',
  'cte',
  'nfe',
  'nfse',
  'tributo',
  'seguro',
  'fatura',
  'recibo',
  'contrato',
  'outro',
] as const;

export const EXTRACTION_SOURCES = [
  'email_body',
  'pdf_text',
  'pdf_vision',
  'error',
] as const;

export const PAYMENT_METHODS = ['boleto', 'pix', 'ted', 'cartao', 'outro'] as const;

export const FINANCIAL_STATUSES = ['pending', 'paid', 'cancelled', 'error'] as const;

export const DUE_STATUSES = ['A Vencer', 'Vencido'] as const;

export const documentTypeSchema = z.enum(DOCUMENT_TYPES);
export const extractionSourceSchema = z.enum(EXTRACTION_SOURCES);
export const paymentMethodSchema = z.enum(PAYMENT_METHODS);
export const financialStatusSchema = z.enum(FINANCIAL_STATUSES);
export const dueStatusSchema = z.enum(DUE_STATUSES);

// Valor monetário: aceita number ou string numérica vinda da REST.
const money = z.coerce.number();

// ── Linha completa (leitura) ────────────────────────────────────────────────

export const financialEmailSchema = z.object({
  id: z.number().int(),

  // Identificação / deduplicação
  gmail_message_id: z.string().nullable(),
  source_file: z.string().nullable(),

  // Classificação
  document_type: documentTypeSchema.nullable(),
  extraction_source: extractionSourceSchema.nullable(),

  // Fornecedor
  supplier_name: z.string().nullable(),
  supplier_cnpj: z.string().nullable(),
  supplier_cpf: z.string().nullable(),
  supplier_id: z.number().int().nullable(),

  // Documento
  invoice_number: z.string().nullable(),
  competence_date: z.string().nullable(), // YYYY-MM
  issue_date: z.string().nullable(), // DATE (ISO)
  due_date: z.string().nullable(), // DATE (ISO)

  // Financeiro
  amount: money.nullable(),
  currency: z.string().default('BRL'),
  payment_method: paymentMethodSchema.nullable(),
  barcode: z.string().nullable(),
  description: z.string().nullable(),

  // Campos de boleto (NOT NULL DEFAULT 0 no banco)
  nosso_numero: z.string().nullable(),
  discount: money.default(0),
  other_deductions: money.default(0),
  fine_interest: money.default(0),
  other_additions: money.default(0),
  amount_charged: money.default(0),

  // Status
  status: financialStatusSchema.default('pending'),
  due_status: dueStatusSchema.nullable(),

  // Corpo do e-mail (quando extraction_source = 'email_body')
  email_body_excerpt: z.string().nullable(),

  // Auditoria
  processing_notes: z.string().nullable(),
  extracted_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

// ── Entrada (gravação pelo pipeline/API) ────────────────────────────────────
// Omite os campos gerados pelo banco; usado ao validar antes de persistir.

export const financialEmailInputSchema = financialEmailSchema.omit({
  id: true,
  supplier_id: true,
  due_status: true,
  created_at: true,
  updated_at: true,
});

export type FinancialEmail = z.infer<typeof financialEmailSchema>;
export type FinancialEmailInput = z.infer<typeof financialEmailInputSchema>;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export type ExtractionSource = (typeof EXTRACTION_SOURCES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type FinancialStatus = (typeof FINANCIAL_STATUSES)[number];
export type DueStatus = (typeof DUE_STATUSES)[number];
