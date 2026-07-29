// lib/ai-chat/tools.ts
// As 6 tools do chat de IA: definição enviada ao modelo + execução via RPC no schema `analytics`.
//
// POR QUE JSON SCHEMA CRU E NÃO ZOD (§17.7 do doc de arquitetura)
// O §6 do documento já especifica os contratos em JSON Schema, que é exatamente o formato que a
// Claude API consome. Converter para Zod só para o helper `betaZodTool` reconverter para JSON
// Schema seria trabalho circular — e o projeto está em Zod 4, enquanto o helper foi escrito
// contra Zod 3. O Zod permanece onde de fato agrega: validando os parâmetros que o MODELO produz,
// antes de chegarem ao banco (`parseToolInput` abaixo).
//
// POR QUE CADA TOOL É UMA FUNÇÃO SQL, NÃO UMA VIEW FILTRADA
// O PostgREST só agrega (`sum`/`count`) com `db-aggregates-enabled`, desligado por padrão no
// Supabase. Como função: a agregação roda no banco, os parâmetros viajam como BIND (o gateway
// nunca interpola string do modelo em SQL) e, sendo SECURITY INVOKER, a RLS das tabelas base
// continua valendo com o JWT do usuário.

import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Schema exposto ao PostgREST (migration 098). */
export const ANALYTICS_SCHEMA = 'analytics';

/**
 * Teto de linhas por tool. Espelha o clamp que existe DENTRO das funções SQL — aqui é só o
 * default enviado ao modelo; quem garante o limite é o banco, porque o modelo pode pedir mais.
 */
const DEFAULT_LIMIT = 20;
const DETAIL_LIMIT = 50;

// Domínios espelhados do banco. `status` são os nomes da dimensão (migration 067+); as empresas
// são os 3 `sk_company` reais (1 OTIMOTEX TECIDOS · 2 LEBIANCO · 3 OTIMOTEX FARDOS).
const STATUS_NAMES = [
  'pendente', 'vencido', 'a vencer', 'prorrogado', 'baixado',
  'protestado', 'cartório', 'pago', 'cancelado', 'falha',
] as const;
const DATE_FIELDS = ['vencimento', 'pagamento', 'emissao'] as const;
const GRANULARITIES = ['dia', 'semana', 'mes', 'trimestre'] as const;
const CLASSIFICATION_DIMS = ['centro_custo', 'plano_contas', 'grupo', 'subgrupo'] as const;
const AGING_GROUPS = ['faixa', 'empresa', 'fornecedor', 'centro_custo', 'plano_contas'] as const;
const SK_COMPANIES = [1, 2, 3] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve ser YYYY-MM-DD');

// O domínio precisa ser o MESMO do JSON Schema enviado ao modelo. Aceitar aqui um valor que lá é
// proibido faz o modelo receber uma lista vazia e concluir "não há contas dessa empresa", em vez
// de um erro que ele consegue corrigir — o oposto do propósito desta camada.
const skCompanyId = z
  .number()
  .int()
  .refine((v): v is 1 | 2 | 3 => (SK_COMPANIES as readonly number[]).includes(v), {
    message: `Empresa inválida — use ${SK_COMPANIES.join(', ')}`,
  });

// `smallint` no banco: fora da faixa vira erro cru do Postgres no meio do loop, em vez de uma
// mensagem que o modelo entende.
const natureId = z.number().int().min(0).max(32_767);

// Validação dos parâmetros que o MODELO gera. Não substitui as guardas do banco (as funções
// clampam limit e rejeitam group_by fora do domínio) — é a primeira barreira, que devolve um erro
// legível ao modelo em vez de deixá-lo receber um resultado vazio e concluir que "não há dados".
const schemas = {
  resumo_situacao: z.object({
    sk_company: skCompanyId.optional(),
    as_of: isoDate.optional(),
  }),
  gasto_por_periodo: z.object({
    date_from: isoDate,
    date_to: isoDate,
    date_field: z.enum(DATE_FIELDS).optional(),
    granularity: z.enum(GRANULARITIES).optional(),
    status: z.array(z.enum(STATUS_NAMES)).optional(),
    sk_company: skCompanyId.optional(),
  }),
  gasto_por_fornecedor: z.object({
    date_from: isoDate,
    date_to: isoDate,
    date_field: z.enum(DATE_FIELDS).optional(),
    supplier: z.string().optional(),
    sk_company: skCompanyId.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  gasto_por_classificacao: z.object({
    date_from: isoDate,
    date_to: isoDate,
    group_by: z.enum(CLASSIFICATION_DIMS),
    date_field: z.enum(DATE_FIELDS).optional(),
    nature_ids: z.array(natureId).optional(),
    sk_company: skCompanyId.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  aging_vencidos: z.object({
    group_by: z.enum(AGING_GROUPS).optional(),
    sk_company: skCompanyId.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  listar_contas: z.object({
    date_from: isoDate,
    date_to: isoDate,
    date_field: z.enum(DATE_FIELDS).optional(),
    supplier: z.string().optional(),
    status: z.array(z.enum(STATUS_NAMES)).optional(),
    sk_company: skCompanyId.optional(),
    page: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
} as const;

// Nome válido de tool — contrato de TOOL_DEFINITIONS/isToolName, consumido via inferência.
// ts-prune-ignore-next
export type ToolName = keyof typeof schemas;

/** Definição enviada ao modelo. `input_schema` é JSON Schema puro (formato da Claude API). */
// ts-prune-ignore-next
export interface ToolDefinition {
  name: ToolName;
  description: string;
  input_schema: Record<string, unknown>;
}

const dateField = {
  type: 'string',
  enum: DATE_FIELDS,
  default: 'vencimento',
  description: 'vencimento → due_date | pagamento → payment_date | emissao → issue_date',
};
const skCompany = {
  type: 'integer',
  enum: SK_COMPANIES,
  description: 'Empresa PAGADORA: 1 OTIMOTEX TECIDOS, 2 LEBIANCO, 3 OTIMOTEX FARDOS. '
    + 'É independente do fornecedor — nunca inferir uma da outra.',
};
const limitProp = (def: number) => ({ type: 'integer', maximum: 100, default: def });

// ts-prune-ignore-next — consumido pelo gateway por inferência.
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'resumo_situacao',
    description:
      'KPIs por situação: quantidade e valor em cada status. Use para "como estamos", '
      + '"quanto tenho a pagar". Exclui cancelado. Devolve também overdue_count/overdue_amount, '
      + 'que recalculam o vencido por data de vencimento — use esses para "quanto está vencido", '
      + 'porque o rótulo de status é atualizado por batch diário e fica defasado.',
    input_schema: {
      type: 'object',
      properties: {
        sk_company: skCompany,
        as_of: { type: 'string', format: 'date', description: 'Data de referência (padrão: hoje).' },
      },
    },
  },
  {
    name: 'gasto_por_periodo',
    description:
      'Total agregado por período (série temporal). Use para "quanto paguei/devo em X", '
      + 'evolução mensal, comparação entre meses.',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', format: 'date' },
        date_to: { type: 'string', format: 'date' },
        date_field: dateField,
        granularity: { type: 'string', enum: GRANULARITIES, default: 'mes' },
        status: {
          type: 'array',
          items: { type: 'string', enum: STATUS_NAMES },
          description: 'Sem este filtro, cancelado é excluído. Informá-lo o inclui se pedido.',
        },
        sk_company: skCompany,
      },
      required: ['date_from', 'date_to'],
    },
  },
  {
    name: 'gasto_por_fornecedor',
    description:
      'Ranking/total por fornecedor. Use para "top fornecedores", "quanto paguei para X". '
      + 'O parâmetro supplier casa CNPJ exato ou parte do nome (sem acento/caixa).',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', format: 'date' },
        date_to: { type: 'string', format: 'date' },
        date_field: dateField,
        supplier: { type: 'string', description: 'Nome parcial ou CNPJ.' },
        sk_company: skCompany,
        limit: limitProp(DEFAULT_LIMIT),
      },
      required: ['date_from', 'date_to'],
    },
  },
  {
    name: 'gasto_por_classificacao',
    description:
      'Agrega pela classificação contábil. Use para "gasto por centro de custo", '
      + '"quanto em despesa fixa", "por plano de contas".',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', format: 'date' },
        date_to: { type: 'string', format: 'date' },
        group_by: { type: 'string', enum: CLASSIFICATION_DIMS },
        date_field: dateField,
        nature_ids: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Natureza do grupo: 2 = Despesas, 8 = Custo (espelha /dashboard_despesas).',
        },
        sk_company: skCompany,
        limit: limitProp(DEFAULT_LIMIT),
      },
      required: ['date_from', 'date_to', 'group_by'],
    },
  },
  {
    name: 'aging_vencidos',
    description:
      'Aging dos títulos EM ABERTO já vencidos, por faixa (1-30, 31-60, 61-90, 90+). '
      + 'Calculado por data de vencimento, não pelo rótulo de status.',
    input_schema: {
      type: 'object',
      properties: {
        group_by: { type: 'string', enum: AGING_GROUPS, default: 'faixa' },
        sk_company: skCompany,
        limit: limitProp(DETAIL_LIMIT),
      },
    },
  },
  {
    name: 'listar_contas',
    description:
      'Drill-down: lista as contas individuais de um recorte, paginado. Use DEPOIS de um '
      + 'agregado, quando o usuário pedir o detalhe ("quais são essas contas?").',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', format: 'date' },
        date_to: { type: 'string', format: 'date' },
        date_field: dateField,
        supplier: { type: 'string' },
        status: { type: 'array', items: { type: 'string', enum: STATUS_NAMES } },
        sk_company: skCompany,
        page: { type: 'integer', minimum: 1, default: 1 },
        limit: limitProp(DETAIL_LIMIT),
      },
      required: ['date_from', 'date_to'],
    },
  },
] as const;

const TOOL_NAMES = new Set<string>(TOOL_DEFINITIONS.map((t) => t.name));

export function isToolName(name: string): name is ToolName {
  return TOOL_NAMES.has(name);
}

/**
 * Valida o input gerado pelo modelo e converte para os parâmetros nomeados da função SQL
 * (prefixo `p_`, conforme a migration 098).
 *
 * @returns `{ ok: true, params }` ou `{ ok: false, message }` — a mensagem volta ao MODELO como
 *   `tool_result` com `is_error: true`, para ele corrigir a chamada. Nunca vira exceção: um
 *   parâmetro errado do modelo é fluxo normal do loop, não falha da requisição.
 */
export function parseToolInput(
  name: ToolName,
  raw: unknown,
): { ok: true; params: Record<string, unknown> } | { ok: false; message: string } {
  const parsed = schemas[name].safeParse(raw);
  if (!parsed.success) {
    const detalhe = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('; ');
    return { ok: false, message: `Parâmetros inválidos para ${name} — ${detalhe}` };
  }
  // O Zod já removeu chaves desconhecidas (strip). Prefixa para casar a assinatura SQL.
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) params[`p_${key}`] = value;
  }
  return { ok: true, params };
}

/**
 * Executa a tool via RPC no schema `analytics`, com o JWT do PRÓPRIO usuário.
 *
 * O `client` precisa ser o anon (`getAnonClient`), nunca o service_role: é o que faz a RLS da
 * migration 076 decidir o recorte — um usuário do grupo Comercial só enxerga as contas em que é
 * dono, exatamente como na tela. Com service_role o chat veria tudo.
 *
 * `.schema(ANALYTICS_SCHEMA)` faz o supabase-js enviar `Content-Profile: analytics`, que é o
 * header que seleciona o schema em POST /rpc (o `Accept-Profile` NÃO funciona aqui — verificado
 * contra o PostgREST real, que sem ele procura a função em `public` e devolve PGRST202).
 */
export async function runTool(
  client: SupabaseClient,
  token: string,
  name: ToolName,
  params: Record<string, unknown>,
): Promise<unknown[]> {
  const { data, error } = await client
    .schema(ANALYTICS_SCHEMA)
    .rpc(name, params)
    .setHeader('Authorization', `Bearer ${token}`);

  if (error) throw new Error(`${name}: ${error.message}`);
  return Array.isArray(data) ? data : [];
}
