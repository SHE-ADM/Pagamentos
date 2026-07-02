// lib/chart-account-subgroups.ts
// CRUD de subgrupos do plano de contas (`financial_chart_of_account_subgroup`) sobre
// o Supabase (service_role). Repository → Service. PK IDENTITY ALWAYS, sentinela id 0
// preservado, código único na aplicação, FK `chart_account_group_id` obrigatória
// (NOT NULL — violação 23503 vira 422), hard delete bloqueado quando referenciado
// (por planos de contas). A leitura traz o grupo embutido (JOIN).

import {
  chartAccountSubgroupCreateSchema,
  chartAccountSubgroupUpdateSchema,
  type ChartAccountSubgroup,
  type ChartAccountSubgroupCreateInput,
  type ChartAccountSubgroupUpdateInput,
} from '@sheild/shared/schemas';
import type { ZodError } from 'zod';
import { getSupabaseAdmin } from './supabase-admin';
import { resolveSort, type SortOrder } from './sort';
import { resolveMatchingIds } from './search';

const TABLE = 'financial_chart_of_account_subgroup';
// Colunas ordenáveis (própria tabela) — o grupo é embed de JOIN, não ordenável aqui.
const SORTABLE_COLUMNS = ['subgroup_code', 'subgroup_description'] as const;
const REFERENCING_TABLES = ['financial_chart_of_account'] as const;
const REF_COLUMN = 'chart_account_subgroup_id';
const SENTINEL_ID = 0;
const DEFAULT_LIMIT = 20;
// Teto de itens por requisição. 1000 (igual a lib/lookups.ts) para o modo lookup
// devolver o cadastro completo ao <select> de subgrupos; a paginação do CRUD usa DEFAULT_LIMIT.
const MAX_LIMIT = 1000;

// Leitura com o grupo embutido (rótulo na grade).
const SELECT_WITH_GROUP =
  'chart_account_subgroup_id,chart_account_group_id,subgroup_code,subgroup_description,' +
  'group:financial_chart_of_account_group(group_code,group_description)';

export class ChartAccountSubgroupServiceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ChartAccountSubgroupServiceError';
    this.status = status;
  }
}

export interface ChartAccountSubgroupListParams {
  page?: number;
  limit?: number;
  search?: string;
  sort?: string;
  order?: SortOrder;
}

export interface ChartAccountSubgroupListResult {
  data: ChartAccountSubgroup[];
  total: number;
  page: number;
  limit: number;
}

function formatZodError(error: ZodError): string {
  return error.issues.map((i) => i.message).join('; ');
}

function sanitizeTerm(term: string): string {
  return term.replace(/[%,()]/g, ' ').trim();
}

// Mapeia erro do Postgres para status HTTP: 23503 (FK) = grupo inexistente → 422.
function mapWriteError(error: { code?: string; message: string }): ChartAccountSubgroupServiceError {
  if (error.code === '23503') return new ChartAccountSubgroupServiceError('Grupo informado não existe', 422);
  return new ChartAccountSubgroupServiceError(error.message, 422);
}

const repository = {
  async findAll(params: { from: number; to: number; search?: string; sort?: string; order?: SortOrder }) {
    let query = getSupabaseAdmin()
      .from(TABLE)
      .select(SELECT_WITH_GROUP, { count: 'exact' })
      .neq('chart_account_subgroup_id', SENTINEL_ID);

    if (params.search) {
      const term = sanitizeTerm(params.search);
      if (term) {
        // Cobre TODAS as colunas do grid: código, descrição e Grupo (embed). O grupo
        // vem de JOIN — resolvemos os ids que casam o termo e os injetamos no OR.
        const clauses = [`subgroup_code.ilike.%${term}%`, `subgroup_description.ilike.%${term}%`];
        const groupIds = await resolveMatchingIds(
          'financial_chart_of_account_group',
          'chart_account_group_id',
          ['group_code', 'group_description'],
          term,
        );
        if (groupIds.length > 0) clauses.push(`chart_account_group_id.in.(${groupIds.join(',')})`);
        query = query.or(clauses.join(','));
      }
    }

    const sorted = resolveSort(params.sort, params.order, SORTABLE_COLUMNS);
    const ordered = sorted
      ? query.order(sorted.column, { ascending: sorted.ascending, nullsFirst: false })
      : query.order('subgroup_code', { ascending: true, nullsFirst: false });

    return ordered.range(params.from, params.to);
  },

  findById(id: number) {
    return getSupabaseAdmin().from(TABLE).select(SELECT_WITH_GROUP).eq('chart_account_subgroup_id', id).maybeSingle();
  },

  findByCode(code: string, excludeId?: number) {
    let query = getSupabaseAdmin().from(TABLE).select('chart_account_subgroup_id').ilike('subgroup_code', code);
    if (excludeId !== undefined) query = query.neq('chart_account_subgroup_id', excludeId);
    return query.limit(1).maybeSingle();
  },

  create(payload: ChartAccountSubgroupCreateInput) {
    return getSupabaseAdmin().from(TABLE).insert(payload).select(SELECT_WITH_GROUP).single();
  },

  update(id: number, payload: ChartAccountSubgroupUpdateInput) {
    return getSupabaseAdmin()
      .from(TABLE)
      .update(payload)
      .eq('chart_account_subgroup_id', id)
      .select(SELECT_WITH_GROUP)
      .maybeSingle();
  },

  countReferences(table: string, id: number) {
    return getSupabaseAdmin().from(table).select(REF_COLUMN, { count: 'exact', head: true }).eq(REF_COLUMN, id);
  },

  remove(id: number) {
    return getSupabaseAdmin().from(TABLE).delete().eq('chart_account_subgroup_id', id);
  },
};

export const chartAccountSubgroupService = {
  async list(params: ChartAccountSubgroupListParams = {}): Promise<ChartAccountSubgroupListResult> {
    const page = Math.max(1, Math.trunc(params.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(params.limit ?? DEFAULT_LIMIT)));
    const from = (page - 1) * limit;

    const { data, count, error } = await repository.findAll({
      from,
      to: from + limit - 1,
      search: params.search?.trim() || undefined,
      sort: params.sort,
      order: params.order,
    });
    if (error) throw new ChartAccountSubgroupServiceError(error.message, 500);
    return { data: (data ?? []) as unknown as ChartAccountSubgroup[], total: count ?? 0, page, limit };
  },

  async getById(id: number): Promise<ChartAccountSubgroup> {
    if (id === SENTINEL_ID) throw new ChartAccountSubgroupServiceError('Subgrupo não encontrado', 404);
    const { data, error } = await repository.findById(id);
    if (error) throw new ChartAccountSubgroupServiceError(error.message, 500);
    if (!data) throw new ChartAccountSubgroupServiceError('Subgrupo não encontrado', 404);
    return data as unknown as ChartAccountSubgroup;
  },

  async create(raw: unknown): Promise<ChartAccountSubgroup> {
    const parsed = chartAccountSubgroupCreateSchema.safeParse(raw);
    if (!parsed.success) throw new ChartAccountSubgroupServiceError(formatZodError(parsed.error), 422);

    await this.assertCodeUnique(parsed.data.subgroup_code);

    const { data, error } = await repository.create(parsed.data);
    if (error) throw mapWriteError(error);
    return data as unknown as ChartAccountSubgroup;
  },

  async update(id: number, raw: unknown): Promise<ChartAccountSubgroup> {
    if (id === SENTINEL_ID) throw new ChartAccountSubgroupServiceError('Subgrupo não encontrado', 404);

    const parsed = chartAccountSubgroupUpdateSchema.safeParse(raw);
    if (!parsed.success) throw new ChartAccountSubgroupServiceError(formatZodError(parsed.error), 422);

    if (parsed.data.subgroup_code !== undefined) await this.assertCodeUnique(parsed.data.subgroup_code, id);

    const { data, error } = await repository.update(id, parsed.data);
    if (error) throw mapWriteError(error);
    if (!data) throw new ChartAccountSubgroupServiceError('Subgrupo não encontrado', 404);
    return data as unknown as ChartAccountSubgroup;
  },

  async remove(id: number): Promise<{ chart_account_subgroup_id: number }> {
    if (id === SENTINEL_ID) {
      throw new ChartAccountSubgroupServiceError('O subgrupo "não informado" não pode ser excluído', 409);
    }

    const existing = await repository.findById(id);
    if (existing.error) throw new ChartAccountSubgroupServiceError(existing.error.message, 500);
    if (!existing.data) throw new ChartAccountSubgroupServiceError('Subgrupo não encontrado', 404);

    for (const table of REFERENCING_TABLES) {
      const { count, error } = await repository.countReferences(table, id);
      if (error) throw new ChartAccountSubgroupServiceError(error.message, 500);
      if ((count ?? 0) > 0) {
        throw new ChartAccountSubgroupServiceError('Subgrupo em uso e não pode ser excluído', 409);
      }
    }

    const { error } = await repository.remove(id);
    if (error) throw new ChartAccountSubgroupServiceError(error.message, 500);
    return { chart_account_subgroup_id: id };
  },

  async assertCodeUnique(code: string, excludeId?: number): Promise<void> {
    const { data, error } = await repository.findByCode(code, excludeId);
    if (error) throw new ChartAccountSubgroupServiceError(error.message, 500);
    if (data) throw new ChartAccountSubgroupServiceError('Código já cadastrado', 409);
  },
};
