import { z } from 'zod';

// Cadastro `financial_chart_of_account_group` — grupos do plano de contas (topo da
// hierarquia: grupo → subgrupo → plano de contas). Tabela de CADASTRO pré-existente
// (preservada em limpezas). Gerenciada pelo CRUD "Grupos de plano de contas" (grupo
// Tabelas). PK `chart_account_group_id` é SMALLINT IDENTITY ALWAYS (gerada pelo
// banco); o id 0 é o sentinela "não informado" (preservado, fora do CRUD).

// Ids fixos do catálogo `financial_type_group` (migration 094 — a coluna `applies_to`
// separa as duas taxonomias: 'group'=Natureza ids 1-4, 'subgroup'=Tipo ids 5-6, 'both'=0).
// Espelham o literal `g.type_group_id = 2` usado nas migrations 092/093 para selecionar
// despesas. Fonte única para o filtro de "despesa" do dashboard financeiro e afins.
export const TYPE_GROUP_ID_DESPESAS = 2; // Natureza do GRUPO ("Despesas")
export const TYPE_GROUP_ID_CUSTO = 8; // Natureza do GRUPO ("Custo")
export const TYPE_GROUP_ID_DESPESA_FIXA = 5; // Tipo do SUBGRUPO ("Despesas Fixas")
export const TYPE_GROUP_ID_DESPESA_VARIAVEL = 6; // Tipo do SUBGRUPO ("Despesas Variáveis")
export const TYPE_GROUP_ID_CUSTO_MERCADORIAS = 7; // Tipo do SUBGRUPO ("Custos de Mercadorias")
// applies_to='both' (migration 094) — hoje só atribuído a SUBGRUPO (migration 127, achado
// 2026-08-14). Nome do catálogo é "Custos de Importações" (plural); o rótulo do demonstrativo
// (analytics.demonstrativo_despesas, migration 128) usa o singular via override.
export const TYPE_GROUP_ID_CUSTO_IMPORTACAO = 9;

// ── Leitura (linha do banco) ────────────────────────────────────────────────

// Embed da NATUREZA contábil (FK type_group_id → financial_type_group). Presente quando
// o select inclui `type_group:financial_type_group(...)`. id 0 = "Não informado".
export const financialTypeGroupEmbeddedSchema = z
  .object({
    type_group_id: z.number().int(),
    type_group_description: z.string().nullable(),
  })
  .nullable();

export const chartAccountGroupSchema = z.object({
  chart_account_group_id: z.number().int(),
  group_code: z.string().nullable(),
  group_description: z.string().nullable(),
  group_type: z.string().nullable(),
  // Natureza contábil (Receitas/Despesas/Ativo/Passivo) — fonte de verdade nova que
  // substitui `group_type`. NOT NULL DEFAULT 0 no banco; 0 = "Não informado".
  type_group_id: z.number().int(),
  type_group: financialTypeGroupEmbeddedSchema.optional(),
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
  // Natureza (FK financial_type_group). 0 = "Não informado" é válido; opcional para não
  // exigir o campo em cargas que omitem (DB default 0).
  type_group_id: z.number().int().min(0, 'Natureza inválida').optional(),
};

// ── Criação ─────────────────────────────────────────────────────────────────
export const chartAccountGroupCreateSchema = z.object(editableGroupFields);

// ── Atualização parcial (ao menos um campo) ──────────────────────────────────
export const chartAccountGroupUpdateSchema = z
  .object({
    group_code: editableGroupFields.group_code.optional(),
    group_description: editableGroupFields.group_description.optional(),
    group_type: editableGroupFields.group_type,
    type_group_id: editableGroupFields.type_group_id,
  })
  .refine(
    (d) =>
      d.group_code !== undefined ||
      d.group_description !== undefined ||
      d.group_type !== undefined ||
      d.type_group_id !== undefined,
    { message: 'Informe ao menos um campo para atualizar' },
  );

export type ChartAccountGroup = z.infer<typeof chartAccountGroupSchema>;
export type ChartAccountGroupEmbedded = z.infer<typeof chartAccountGroupEmbeddedSchema>;
export type FinancialTypeGroupEmbedded = z.infer<typeof financialTypeGroupEmbeddedSchema>;
export type ChartAccountGroupCreateInput = z.infer<typeof chartAccountGroupCreateSchema>;
export type ChartAccountGroupUpdateInput = z.infer<typeof chartAccountGroupUpdateSchema>;
