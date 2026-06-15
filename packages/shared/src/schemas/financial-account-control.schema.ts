import { z } from 'zod';

// Schema da tabela `financial_account_control` — controle central de contas a
// pagar. Uma linha por documento financeiro, alimentada por duas origens:
// o pipeline de extração de e-mail e o CRUD manual (baixas, consolidações,
// dashboards). Reflete o estado das migrations 018 (criação + domínios pt-BR),
// além de 005 (campos de boleto), 007/009 (company_id/supplier_id) e o
// email_body_excerpt. Campos monetários chegam como string ou número pela REST
// do Supabase — `z.coerce.number()` normaliza ambos.

// ── Enums de domínio (espelham os CHECK constraints da migration 018) ────────

export const DOCUMENT_TYPES = [
  'boleto',
  'cte',
  'nfe',
  'nfse',
  'seguro',
  'fatura',
  'recibo',
  'contrato',
  'outro',
  'darf',
  'gps',
  'das',
  'gru',
  'dae',
  'gnre',
  'ipva',
  'iptu',
  'dam / duam',
  'iss',
  'itbi',
  'gare',
  'tributo',
  'pix',
  'honorários',
] as const;

export const EXTRACTION_SOURCES = [
  'email_body',
  'pdf_text',
  'pdf_vision',
  'falha',
] as const;

export const PAYMENT_METHODS = [
  'boleto',
  'pix',
  'ted',
  'cartão',
  'depósito',
  'duplicata',
  'bancário',
  'carteira',
  'vale',
  'crédito',
  'débito',
  'dinheiro',
  'transferência',
  'cheque',
  'outro',
] as const;

// Status do ciclo de vida do pagamento (status e due_status compartilham o
// mesmo domínio no banco; a trigger só grava 'a vencer'/'vencido' em due_status).
export const ACCOUNT_STATUSES = [
  'pendente',
  'vencido',
  'a vencer',
  'prorrogado',
  'baixado',
  'protestado',
  'cartório',
  'pago',
  'pago protesto',
  'pago cartório',
  'não pago',
  'cancelado',
  'falha',
] as const;

// Situação de vencimento calculada pela trigger trg_fe_due_status.
export const DUE_STATUSES = ['a vencer', 'vencido'] as const;

export const documentTypeSchema = z.enum(DOCUMENT_TYPES);
export const extractionSourceSchema = z.enum(EXTRACTION_SOURCES);
export const paymentMethodSchema = z.enum(PAYMENT_METHODS);
export const accountStatusSchema = z.enum(ACCOUNT_STATUSES);
export const dueStatusSchema = z.enum(DUE_STATUSES);

// Valor monetário: aceita number ou string numérica vinda da REST.
const money = z.coerce.number();

// ── Linha completa (leitura) ────────────────────────────────────────────────

export const financialAccountControlSchema = z.object({
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
  status: accountStatusSchema.default('pendente'),
  due_status: dueStatusSchema.nullable(),

  // Pagador (sacado)
  company_id: z.number().int().nullable(),
  payer_cnpj: z.string().nullable(),
  payer_name: z.string().nullable(),

  // Remetente do e-mail — alinha supplier.email no trigger (migration 023)
  sender_email: z.string().nullable(),

  // Assunto do e-mail — exibido no card e buscável em /consulta (migration 025)
  subject: z.string().nullable(),

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

export const financialAccountControlInputSchema = financialAccountControlSchema.omit({
  id: true,
  supplier_id: true,
  company_id: true,
  due_status: true,
  created_at: true,
  updated_at: true,
});

export type FinancialAccountControl = z.infer<typeof financialAccountControlSchema>;
export type FinancialAccountControlInput = z.infer<typeof financialAccountControlInputSchema>;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export type ExtractionSource = (typeof EXTRACTION_SOURCES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
export type DueStatus = (typeof DUE_STATUSES)[number];
