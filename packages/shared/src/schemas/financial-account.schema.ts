import { z } from 'zod';
import { bankEmbeddedSchema } from './bank.schema';

// Cadastro `financial_account` — contas bancárias/caixa (descrição, banco, moeda,
// saldo). Tabela de CADASTRO pré-existente (preservada em limpezas). Gerenciada
// pelo CRUD "Contas" (grupo Tabelas) — distinto de `financial_account_control`
// (lançamentos, rota /contas). PK `financial_account_id` é SMALLINT IDENTITY ALWAYS.
//
// Campos herdados do Firebird:
// - `payment_type_id` SMALLINT NOT NULL — sem tabela de domínio neste banco →
//   input numérico cru (sem lookup).
// - `status_id` SMALLINT NOT NULL DEFAULT 30 — FK → `status.status_id`
//   (migration 053). DEFAULT 30 = "ativo" (a tabela `status` contém os ids 1–10 do
//   ciclo de contas a pagar + o 30 "ativo" das contas bancárias).

// Valor monetário: aceita number ou string numérica vinda da REST.
const money = z.coerce.number();
const MAX_DESCRIPTION = 60;
const MAX_CURRENCY = 5;

// ── Leitura (linha do banco) ────────────────────────────────────────────────

export const financialAccountSchema = z.object({
  financial_account_id: z.number().int(),
  account_description: z.string().nullable(),
  bank_id: z.number().int(),
  payment_type_id: z.number().int(),
  currency_code: z.string().nullable(),
  balance_amount: money.default(0),
  status_id: z.number().int(),
  // Banco embutido (JOIN via bank_id) — presente quando o select inclui bank(...).
  bank: bankEmbeddedSchema.optional(),
});

// Campos editáveis. financial_account_id é IDENTITY — nunca entra no corpo.
const editableAccountFields = {
  account_description: z
    .string()
    .trim()
    .min(1, 'Descrição é obrigatória')
    .max(MAX_DESCRIPTION, `Descrição deve ter no máximo ${MAX_DESCRIPTION} caracteres`),
  // bank_id/payment_type_id aceitam 0 = "não informado"/Caixa (o form oferece a opção
  // neutra NONE_BANK e normaliza vazio→0). Logo `.min(0)` só barra negativos e a mensagem
  // NÃO afirma obrigatoriedade — diferente de status_id, que É obrigatório (.min(1)).
  // Ver achado A1-4.
  bank_id: z.number().int().min(0, 'Banco inválido'),
  payment_type_id: z.number().int().min(0, 'Tipo de pagamento inválido'),
  status_id: z.number().int().min(1, 'Situação é obrigatória'),
  currency_code: z.string().trim().max(MAX_CURRENCY, `Moeda deve ter no máximo ${MAX_CURRENCY} caracteres`).optional(),
  balance_amount: money.min(0, 'Saldo não pode ser negativo').optional(),
};

// ── Criação ─────────────────────────────────────────────────────────────────
export const financialAccountCreateSchema = z.object(editableAccountFields);

// ── Atualização parcial (ao menos um campo) ──────────────────────────────────
export const financialAccountUpdateSchema = financialAccountCreateSchema
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: 'Informe ao menos um campo para atualizar' });

export type FinancialAccount = z.infer<typeof financialAccountSchema>;
export type FinancialAccountCreateInput = z.infer<typeof financialAccountCreateSchema>;
export type FinancialAccountUpdateInput = z.infer<typeof financialAccountUpdateSchema>;
