import { z } from 'zod';

// Cadastro `financial_chart_of_account_group` — grupos do plano de contas (topo da
// hierarquia: grupo → subgrupo → plano de contas). Tabela de CADASTRO pré-existente
// (preservada em limpezas). Gerenciada pelo CRUD "Grupos de plano de contas" (grupo
// Tabelas). PK `chart_account_group_id` é SMALLINT IDENTITY ALWAYS (gerada pelo
// banco); o id 0 é o sentinela "não informado" (preservado, fora do CRUD).

// ── Leitura (linha do banco) ────────────────────────────────────────────────

export const chartAccountGroupSchema = z.object({
  chart_account_group_id: z.number().int(),
  group_code: z.string().nullable(),
  group_description: z.string().nullable(),
  group_type: z.string().nullable(),
});

// Embed (JOIN via financial_chart_of_account_subgroup.chart_account_group_id).
export const chartAccountGroupEmbeddedSchema = z
  .object({
    group_code: z.string().nullable(),
    group_description: z.string().nullable(),
  })
  .nullable();

const MAX_CODE = 60;
const MAX_DESCRIPTION = 150;
const MAX_TYPE = 1;

const editableGroupFields = {
  group_code: z
    .string()
    .trim()
    .min(1, 'Código é obrigatório')
    .max(MAX_CODE, `Código deve ter no máximo ${MAX_CODE} caracteres`),
  group_description: z
    .string()
    .trim()
    .min(1, 'Descrição é obrigatória')
    .max(MAX_DESCRIPTION, `Descrição deve ter no máximo ${MAX_DESCRIPTION} caracteres`),
  // group_type é CHAR(1) opcional (ex.: A/P/L/R/D/O) — sem domínio fixo aqui.
  group_type: z.string().trim().max(MAX_TYPE, `Tipo deve ter no máximo ${MAX_TYPE} caractere`).optional(),
};

// ── Criação ─────────────────────────────────────────────────────────────────
export const chartAccountGroupCreateSchema = z.object(editableGroupFields);

// ── Atualização parcial (ao menos um campo) ──────────────────────────────────
export const chartAccountGroupUpdateSchema = z
  .object({
    group_code: editableGroupFields.group_code.optional(),
    group_description: editableGroupFields.group_description.optional(),
    group_type: editableGroupFields.group_type,
  })
  .refine(
    (d) => d.group_code !== undefined || d.group_description !== undefined || d.group_type !== undefined,
    { message: 'Informe ao menos um campo para atualizar' },
  );

export type ChartAccountGroup = z.infer<typeof chartAccountGroupSchema>;
export type ChartAccountGroupEmbedded = z.infer<typeof chartAccountGroupEmbeddedSchema>;
export type ChartAccountGroupCreateInput = z.infer<typeof chartAccountGroupCreateSchema>;
export type ChartAccountGroupUpdateInput = z.infer<typeof chartAccountGroupUpdateSchema>;
