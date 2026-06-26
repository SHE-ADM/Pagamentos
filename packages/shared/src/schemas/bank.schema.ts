import { z } from 'zod';

// Cadastro `financial_bank` — bancos. Tabela de CADASTRO pré-existente (preservada
// em limpezas), usada como lookup das contas financeiras (FK financial_account.bank_id).
// Gerenciada pelo CRUD "Bancos" (grupo Tabelas). PK `bank_id` é SMALLINT **NÃO
// identity** (atribuição manual — o service grava max+1); o id 0 é o sentinela
// "não informado" (preservado, fora do CRUD). `bank_code` é o código de 3 dígitos.

// ── Leitura (linha do banco) ────────────────────────────────────────────────

export const bankSchema = z.object({
  bank_id: z.number().int(),
  bank_code: z.string().nullable(),
  bank_name: z.string().nullable(),
});

// Embed (JOIN via financial_account.bank_id) — usado na grade de Contas.
export const bankEmbeddedSchema = z
  .object({
    bank_code: z.string().nullable(),
    bank_name: z.string().nullable(),
  })
  .nullable();

const MAX_CODE = 3;
const MAX_NAME = 150;

const editableBankFields = {
  bank_code: z
    .string()
    .trim()
    .min(1, 'Código é obrigatório')
    .max(MAX_CODE, `Código deve ter no máximo ${MAX_CODE} caracteres`),
  bank_name: z
    .string()
    .trim()
    .min(1, 'Nome é obrigatório')
    .max(MAX_NAME, `Nome deve ter no máximo ${MAX_NAME} caracteres`),
};

// ── Criação ─────────────────────────────────────────────────────────────────
export const bankCreateSchema = z.object(editableBankFields);

// ── Atualização parcial (ao menos um campo) ──────────────────────────────────
export const bankUpdateSchema = z
  .object({
    bank_code: editableBankFields.bank_code.optional(),
    bank_name: editableBankFields.bank_name.optional(),
  })
  .refine((d) => d.bank_code !== undefined || d.bank_name !== undefined, {
    message: 'Informe ao menos um campo para atualizar',
  });

export type Bank = z.infer<typeof bankSchema>;
export type BankEmbedded = z.infer<typeof bankEmbeddedSchema>;
export type BankCreateInput = z.infer<typeof bankCreateSchema>;
export type BankUpdateInput = z.infer<typeof bankUpdateSchema>;
