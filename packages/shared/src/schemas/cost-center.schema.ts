import { z } from 'zod';

// Cadastro `financial_cost_center` — centro de custo. Tabela de CADASTRO
// pré-existente (preservada em limpezas), usada como lookup na classificação
// contábil das contas a pagar (FK financial_account_control.cost_center_id —
// migration 047) e gerenciada pelo CRUD "Centro de custos" (grupo Tabelas).
// PK `cost_center_id` é SMALLINT IDENTITY ALWAYS (gerada pelo banco); o id 0 é
// o sentinela "não informado" (preservado, fora do CRUD).

// ── Leitura (linha do banco) ────────────────────────────────────────────────

export const costCenterSchema = z.object({
  cost_center_id: z.number().int(),
  cost_center_code: z.string().nullable(),
  cost_center_description: z.string().nullable(),
});

// Campos editáveis (POST/PATCH). cost_center_id é IDENTITY ALWAYS — nunca entra
// no corpo. Código e descrição são obrigatórios na criação; o código deve ser
// único (validado na aplicação — não há UNIQUE no banco).
const MAX_CODE = 30;
const MAX_DESCRIPTION = 120;

const editableCostCenterFields = {
  cost_center_code: z
    .string()
    .trim()
    .min(1, 'Código é obrigatório')
    .max(MAX_CODE, `Código deve ter no máximo ${MAX_CODE} caracteres`),
  cost_center_description: z
    .string()
    .trim()
    .min(1, 'Descrição é obrigatória')
    .max(MAX_DESCRIPTION, `Descrição deve ter no máximo ${MAX_DESCRIPTION} caracteres`),
};

// ── Criação ─────────────────────────────────────────────────────────────────
export const costCenterCreateSchema = z.object(editableCostCenterFields);

// ── Atualização parcial ──────────────────────────────────────────────────────
// Ambos opcionais; ao menos um campo deve ser enviado (evita PATCH vazio).
export const costCenterUpdateSchema = z
  .object({
    cost_center_code: editableCostCenterFields.cost_center_code.optional(),
    cost_center_description: editableCostCenterFields.cost_center_description.optional(),
  })
  .refine((d) => d.cost_center_code !== undefined || d.cost_center_description !== undefined, {
    message: 'Informe ao menos um campo para atualizar',
  });

export type CostCenter = z.infer<typeof costCenterSchema>;
export type CostCenterCreateInput = z.infer<typeof costCenterCreateSchema>;
export type CostCenterUpdateInput = z.infer<typeof costCenterUpdateSchema>;
