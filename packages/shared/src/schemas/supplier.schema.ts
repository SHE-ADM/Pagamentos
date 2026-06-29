import { z } from 'zod';
import { costCenterEmbeddedSchema, chartAccountEmbeddedSchema } from './financial-account-control.schema';

// Schema da tabela `supplier` — cadastro de fornecedores. PK = sk_supplier
// (surrogate key snowflake, migration 042); supplier_id é chave de negócio.
// IMPORTANTE: a tabela NÃO possui created_at/updated_at (confirmado nos migrants);
// `deleted_at` foi adicionado na migration 045 (soft delete).
// CNPJ/CPF são SEMPRE dígitos sem máscara (CHAR(14)/CHAR(11)).
// Classificação contábil DEFAULT do fornecedor (migration 052): cost_center_id /
// chart_account_id (SMALLINT NOT NULL DEFAULT 0, sentinela 0 = "não informado").

// Remove máscara de CNPJ/CPF, mantendo só dígitos.
const stripMask = (v: string): string => v.replace(/\D/g, '');

const cnpjInput = z
  .string()
  .transform(stripMask)
  .refine((v) => v.length === 14, 'CNPJ deve conter 14 dígitos');

const cpfInput = z
  .string()
  .transform(stripMask)
  .refine((v) => v.length === 11, 'CPF deve conter 11 dígitos');

// ── Leitura (linha do banco) ────────────────────────────────────────────────

export const supplierSchema = z.object({
  sk_supplier: z.number().int(),
  supplier_id: z.number().int(),
  legal_name: z.string().nullable(),
  trade_name: z.string().nullable(),
  cnpj: z.string().nullable(),
  cpf: z.string().nullable(),
  email: z.string().nullable(),
  email2: z.string().nullable(),
  email3: z.string().nullable(),
  email4: z.string().nullable(),
  deleted_at: z.string().nullable(),
  // Classificação contábil DEFAULT (migration 052) — usada para pré-preencher o
  // lançamento de contas; embeds opcionais vêm do JOIN (GET /suppliers/:sk).
  cost_center_id: z.number().int().default(0),
  chart_account_id: z.number().int().default(0),
  cost_center: costCenterEmbeddedSchema.optional(),
  chart_account: chartAccountEmbeddedSchema.optional(),
});

// Campos editáveis (POST/PATCH). sk_supplier/supplier_id são gerados pelo banco
// e pelo trigger trg_supplier_mirror_id — nunca entram no corpo.
// Classificação contábil DEFAULT (cost_center_id/chart_account_id): editável pelo
// CRUD de fornecedores (SMALLINT NOT NULL DEFAULT 0; 0 = "não informado"). Continua
// gravável também pelo write-back do modal de contas (setSupplierClassification).
const editableFields = {
  legal_name: z.string().min(1, 'Razão social não pode ser vazia').max(200).optional(),
  trade_name: z.string().min(1, 'Nome fantasia não pode ser vazio').max(200).optional(),
  cnpj: cnpjInput.optional(),
  cpf: cpfInput.optional(),
  email: z.email('E-mail inválido').optional(),
  email2: z.email('E-mail inválido').optional(),
  email3: z.email('E-mail inválido').optional(),
  email4: z.email('E-mail inválido').optional(),
  cost_center_id: z.number().int().min(0).optional(),
  chart_account_id: z.number().int().min(0).optional(),
};

// ── Criação ─────────────────────────────────────────────────────────────────
// Espelha chk_supplier_has_identifier (migration 011): ao menos um identificador.
export const supplierCreateSchema = z.object(editableFields).refine(
  (d) => Boolean(d.legal_name ?? d.trade_name ?? d.cnpj ?? d.cpf),
  { message: 'Informe ao menos um identificador: razão social, nome fantasia, CNPJ ou CPF' },
);

// ── Atualização parcial ──────────────────────────────────────────────────────
// Todos opcionais; não exige identificador (o registro já existe).
export const supplierUpdateSchema = z.object(editableFields);

export type Supplier = z.infer<typeof supplierSchema>;
export type SupplierCreateInput = z.infer<typeof supplierCreateSchema>;
export type SupplierUpdateInput = z.infer<typeof supplierUpdateSchema>;
