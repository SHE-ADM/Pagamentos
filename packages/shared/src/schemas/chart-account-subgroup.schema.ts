import { z } from 'zod';
import { chartAccountGroupEmbeddedSchema } from './chart-account-group.schema';

// Cadastro `financial_chart_of_account_subgroup` — subgrupos do plano de contas
// (meio da hierarquia: grupo → subgrupo → plano de contas). Tabela de CADASTRO
// pré-existente (preservada em limpezas). Gerenciada pelo CRUD "Sub grupos de plano
// de contas" (grupo Tabelas). PK `chart_account_subgroup_id` é SMALLINT IDENTITY
// ALWAYS (gerada pelo banco); o id 0 é o sentinela "não informado" (fora do CRUD).
// `chart_account_group_id` (FK → grupo) é NOT NULL → obrigatório.

// ── Leitura (linha do banco) ────────────────────────────────────────────────

export const chartAccountSubgroupSchema = z.object({
  chart_account_subgroup_id: z.number().int(),
  chart_account_group_id: z.number().int(),
  subgroup_code: z.string().nullable(),
  subgroup_description: z.string().nullable(),
  // Embed opcional do grupo (JOIN) — presente quando o select inclui group(...).
  group: chartAccountGroupEmbeddedSchema.optional(),
});

// Embed (JOIN via financial_chart_of_account.chart_account_subgroup_id).
export const chartAccountSubgroupEmbeddedSchema = z
  .object({
    subgroup_code: z.string().nullable(),
    subgroup_description: z.string().nullable(),
  })
  .nullable();

const MAX_CODE = 60;
const MAX_DESCRIPTION = 150;

const editableSubgroupFields = {
  subgroup_code: z
    .string()
    .trim()
    .min(1, 'Código é obrigatório')
    .max(MAX_CODE, `Código deve ter no máximo ${MAX_CODE} caracteres`),
  subgroup_description: z
    .string()
    .trim()
    .min(1, 'Descrição é obrigatória')
    .max(MAX_DESCRIPTION, `Descrição deve ter no máximo ${MAX_DESCRIPTION} caracteres`),
  // FK obrigatória (NOT NULL no banco) — o grupo deve ser informado (> 0).
  chart_account_group_id: z.number().int().min(1, 'Grupo é obrigatório'),
};

// ── Criação ─────────────────────────────────────────────────────────────────
export const chartAccountSubgroupCreateSchema = z.object(editableSubgroupFields);

// ── Atualização parcial (ao menos um campo) ──────────────────────────────────
export const chartAccountSubgroupUpdateSchema = z
  .object({
    subgroup_code: editableSubgroupFields.subgroup_code.optional(),
    subgroup_description: editableSubgroupFields.subgroup_description.optional(),
    chart_account_group_id: editableSubgroupFields.chart_account_group_id.optional(),
  })
  .refine(
    (d) =>
      d.subgroup_code !== undefined ||
      d.subgroup_description !== undefined ||
      d.chart_account_group_id !== undefined,
    { message: 'Informe ao menos um campo para atualizar' },
  );

export type ChartAccountSubgroup = z.infer<typeof chartAccountSubgroupSchema>;
export type ChartAccountSubgroupEmbedded = z.infer<typeof chartAccountSubgroupEmbeddedSchema>;
export type ChartAccountSubgroupCreateInput = z.infer<typeof chartAccountSubgroupCreateSchema>;
export type ChartAccountSubgroupUpdateInput = z.infer<typeof chartAccountSubgroupUpdateSchema>;
