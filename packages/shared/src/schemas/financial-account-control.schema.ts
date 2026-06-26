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
  'container',
  // Contas de concessionária — classificadas por frase do assunto/corpo (migration 043).
  'conta de água',
  'conta de luz',
  'conta de telefone / internet',
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

// Situação/ciclo de vida da conta — coluna única `status` (migration 034 fundiu o
// antigo `due_status` aqui). A trigger `fn_set_status_from_due_date` grava
// 'a vencer'/'vencido' a partir de `due_date` quando o status está em aberto
// (pendente/a vencer/vencido); 'falha' e baixas/CRUD manual (pago/baixado/cancelado/…)
// são preservados. Domínio (10 valores) = tabela de dimensão `status` (migration 035,
// que também resolve `status_id` por `status_name`):
export const ACCOUNT_STATUSES = [
  'pendente',
  'vencido',
  'a vencer',
  'prorrogado',
  'baixado',
  'protestado',
  'cartório',
  'pago',
  'cancelado',
  'falha',
] as const;

export const documentTypeSchema = z.enum(DOCUMENT_TYPES);
export const extractionSourceSchema = z.enum(EXTRACTION_SOURCES);
export const paymentMethodSchema = z.enum(PAYMENT_METHODS);
export const accountStatusSchema = z.enum(ACCOUNT_STATUSES);

// Valor monetário: aceita number ou string numérica vinda da REST.
const money = z.coerce.number();

// ── Fornecedor embutido (JOIN via supplier_id) ──────────────────────────────
// Retornado pelo PostgREST quando se usa select=*,supplier(...).
// Campos do cadastro canônico (tabela `supplier`) — fonte de verdade única do
// nome/CNPJ/CPF do fornecedor desde que as colunas denormalizadas foram dropadas.

export const supplierEmbeddedSchema = z.object({
  trade_name: z.string().nullable(),
  legal_name: z.string().nullable(),
  cnpj: z.string().nullable(),
  cpf: z.string().nullable(),
}).nullable();

export type SupplierEmbedded = z.infer<typeof supplierEmbeddedSchema>;

// ── Classificação contábil embutida (JOIN via cost_center_id / chart_account_id) ─
// Retornado pelo PostgREST quando o select inclui os aliases
// cost_center:financial_cost_center(...) e chart_account:financial_chart_of_account(...).

export const costCenterEmbeddedSchema = z.object({
  cost_center_code: z.string().nullable(),
  cost_center_description: z.string().nullable(),
}).nullable();

export const chartAccountEmbeddedSchema = z.object({
  account_code: z.string().nullable(),
  account_description: z.string().nullable(),
}).nullable();

export type CostCenterEmbedded = z.infer<typeof costCenterEmbeddedSchema>;
export type ChartAccountEmbedded = z.infer<typeof chartAccountEmbeddedSchema>;

// ── Linha completa (leitura) ────────────────────────────────────────────────

export const financialAccountControlSchema = z.object({
  id: z.number().int(),

  // Identificação / deduplicação
  gmail_message_id: z.string().nullable(),
  source_file: z.string().nullable(),

  // Classificação
  document_type: documentTypeSchema.nullable(),
  extraction_source: extractionSourceSchema.nullable(),

  // Fornecedor — referenciado APENAS pela FK sk_supplier (surrogate key snowflake,
  // NOT NULL no banco). supplier_id é chave de negócio e fica só na tabela `supplier`
  // (migration 042). Os dados denormalizados (nome/CNPJ/CPF) foram removidos
  // (migrations 040/041); a fonte de verdade é `supplier`, lida via JOIN (campo `supplier`).
  sk_supplier: z.number().int(),

  // Classificação contábil (FKs para os cadastros — migrations 047/048). NOT NULL
  // DEFAULT 0: "não informado" grava o id 0 (linha-sentinela existente em ambos os
  // cadastros), nunca NULL. cost_center_id → financial_cost_center,
  // chart_account_id → financial_chart_of_account.
  cost_center_id: z.number().int().default(0),
  chart_account_id: z.number().int().default(0),

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

  // Situação/ciclo de vida (coluna única — migration 034)
  status: accountStatusSchema.default('pendente'),
  // FK para a dimensão `status` — resolvido pela trigger a partir de `status` (035)
  status_id: z.number().int().nullable(),

  // Flags de curadoria manual (checkbox em /consulta — migration 033).
  // NOT NULL DEFAULT FALSE no banco; editados pelo usuário, não pelo pipeline.
  has_invoice: z.boolean().default(false),
  has_bank_slip: z.boolean().default(false),

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

  // Fornecedor embutido — presente quando o select inclui supplier(...).
  // Fonte de verdade única para exibição (nome/CNPJ/CPF vêm daqui via JOIN).
  supplier: supplierEmbeddedSchema.optional(),

  // Classificação contábil embutida — presente quando o select inclui os aliases
  // cost_center:financial_cost_center(...) / chart_account:financial_chart_of_account(...).
  cost_center: costCenterEmbeddedSchema.optional(),
  chart_account: chartAccountEmbeddedSchema.optional(),
});

// ── Entrada (gravação pelo pipeline/API) ────────────────────────────────────
// Omite os campos gerados pelo banco e o recurso embutido `supplier` (leitura).
// `sk_supplier` agora é entrada OBRIGATÓRIA — o pipeline resolve o fornecedor
// (RPC resolve_supplier_for_account, que devolve o surrogate sk_supplier) antes de
// persistir; não há mais trigger de resolução nem colunas denormalizadas (migrations
// 040/041/042).

export const financialAccountControlInputSchema = financialAccountControlSchema.omit({
  id: true,
  company_id: true,
  status_id: true,
  created_at: true,
  updated_at: true,
  supplier: true,
  cost_center: true,
  chart_account: true,
});

// ── Criação manual (CRUD — POST /api/contas) ─────────────────────────────────
// O pipeline de extração pode gravar uma conta sem valor (vira erro 'sem_valor',
// não cria conta — ver read_emails). Já a criação manual via API EXIGE fornecedor
// (sk_supplier) e valor positivo; os demais campos são OPCIONAIS (o banco aplica
// DEFAULT/NULL nas colunas omitidas), para um formulário de lançamento rápido.
// `status` é OMITIDO: a conta sempre nasce no default do banco ('pendente') e a
// trigger fn_set_status_from_due_date assume 'a vencer'/'vencido' — o cliente não
// pode criar uma conta já em estado fechado (pago/cancelado/baixado). A baixa/edição
// de situação é feita depois via PATCH (financialAccountControlUpdateSchema).
export const financialAccountControlCreateSchema = financialAccountControlInputSchema
  .omit({ status: true })
  .partial()
  .extend({
    sk_supplier: z.number().int(),
    amount: money.positive('O valor deve ser maior que zero'),
  });

// ── Atualização parcial (PATCH /api/contas/:id) ──────────────────────────────
// Todos os campos opcionais; permite alterar a situação (ex.: status='cancelado').
export const financialAccountControlUpdateSchema = financialAccountControlInputSchema.partial();

export type FinancialAccountControl = z.infer<typeof financialAccountControlSchema>;
export type FinancialAccountControlInput = z.infer<typeof financialAccountControlInputSchema>;
export type FinancialAccountControlCreate = z.infer<typeof financialAccountControlCreateSchema>;
export type FinancialAccountControlUpdate = z.infer<typeof financialAccountControlUpdateSchema>;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export type ExtractionSource = (typeof EXTRACTION_SOURCES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
