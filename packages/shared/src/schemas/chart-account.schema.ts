import { z } from 'zod';
import { costCenterEmbeddedSchema } from './financial-account-control.schema';
import { chartAccountSubgroupEmbeddedSchema } from './chart-account-subgroup.schema';
import { chartAccountGroupEmbeddedSchema } from './chart-account-group.schema';

// Cadastro `financial_chart_of_account` — plano de contas (base da hierarquia:
// grupo → subgrupo → plano de contas). Tabela de CADASTRO pré-existente (preservada
// em limpezas), usada como lookup na classificação contábil das contas a pagar
// (FK financial_account_control.chart_account_id — migration 047; só as postáveis
// `is_postable` são elegíveis a lançamento) e gerenciada pelo CRUD "Plano de contas"
// (grupo Tabelas). PK `chart_account_id` é SMALLINT IDENTITY ALWAYS; o id 0 é o
// sentinela "não informado". `cost_center_id`/`chart_account_subgroup_id` são FKs
// com DEFAULT 0 (opcionais = "não informado").

// ── Leitura (linha do banco) ────────────────────────────────────────────────
// Os campos além de id/código/descrição são opcionais com default para não quebrar
// os consumidores do LOOKUP (services/lookups), que selecionam só 3 colunas.

export const chartAccountSchema = z.object({
  chart_account_id: z.number().int(),
  account_code: z.string().nullable(),
  account_description: z.string().nullable(),
  cost_center_id: z.number().int().default(0),
  chart_account_subgroup_id: z.number().int().default(0),
  // FK direta ao grupo (migration 058; DEFAULT 0 = "não informado"). Coexiste com a
  // ligação indireta via subgrupo — aqui é o vínculo direto do plano ao grupo.
  chart_account_group_id: z.number().int().default(0),
  account_level: z.number().int().default(2),
  is_postable: z.boolean().default(true),
  // Embeds opcionais (JOIN) — presentes quando o select inclui os aliases.
  cost_center: costCenterEmbeddedSchema.optional(),
  subgroup: chartAccountSubgroupEmbeddedSchema.optional(),
  group: chartAccountGroupEmbeddedSchema.optional(),
});

const MAX_CODE = 60;
const MAX_DESCRIPTION = 150;

const editableChartAccountFields = {
  account_code: z
    .string()
    .trim()
    .min(1, 'Código é obrigatório')
    .max(MAX_CODE, `Código deve ter no máximo ${MAX_CODE} caracteres`),
  account_description: z
    .string()
    .trim()
    .min(1, 'Descrição é obrigatória')
    .max(MAX_DESCRIPTION, `Descrição deve ter no máximo ${MAX_DESCRIPTION} caracteres`),
  // account_level (DB default 2) e is_postable (DB default true) — opcionais.
  account_level: z.number().int().min(0, 'Nível inválido').optional(),
  is_postable: z.boolean().optional(),
  // FKs opcionais (DEFAULT 0 = "não informado").
  cost_center_id: z.number().int().min(0).optional(),
  chart_account_subgroup_id: z.number().int().min(0).optional(),
  chart_account_group_id: z.number().int().min(0).optional(),
};

// ── Criação ─────────────────────────────────────────────────────────────────
export const chartAccountCreateSchema = z.object(editableChartAccountFields);

// ── Atualização parcial (ao menos um campo) ──────────────────────────────────
export const chartAccountUpdateSchema = chartAccountCreateSchema
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: 'Informe ao menos um campo para atualizar' });

export type ChartAccount = z.infer<typeof chartAccountSchema>;
export type ChartAccountCreateInput = z.infer<typeof chartAccountCreateSchema>;
export type ChartAccountUpdateInput = z.infer<typeof chartAccountUpdateSchema>;
