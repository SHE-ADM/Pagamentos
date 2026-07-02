// lib/chart-account-groups.ts
// CRUD de grupos do plano de contas (`financial_chart_of_account_group`) sobre o
// Supabase (service_role). Repository → Service. Mesmo padrão de lib/cost-centers.ts:
// PK IDENTITY ALWAYS, sentinela id 0 preservado, código único na aplicação, hard
// delete bloqueado quando referenciado (por subgrupos).

import {
  chartAccountGroupCreateSchema,
  chartAccountGroupUpdateSchema,
  type ChartAccountGroup,
  type ChartAccountGroupCreateInput,
  type ChartAccountGroupUpdateInput,
} from '@sheild/shared/schemas';
import type { ZodError } from 'zod';
import { getSupabaseAdmin } from './supabase-admin';
import { resolveSort, type SortOrder } from './sort';

const TABLE = 'financial_chart_of_account_group';
const SORTABLE_COLUMNS = ['group_code', 'group_description', 'group_type'] as const;
const REFERENCING_TABLES = ['financial_chart_of_account_subgroup'] as const;
const REF_COLUMN = 'chart_account_group_id';
const SENTINEL_ID = 0;
const DEFAULT_LIMIT = 20;
// Teto de itens por requisição. 1000 (igual a lib/lookups.ts) para o modo lookup
// devolver o cadastro completo ao <select> de grupos; a paginação do CRUD usa DEFAULT_LIMIT.
const MAX_LIMIT = 1000;

export class ChartAccountGroupServiceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ChartAccountGroupServiceError';
    this.status = status;
  }
}

export interface ChartAccountGroupListParams {
  page?: number;
  limit?: number;
  search?: string;
  sort?: string;
  order?: SortOrder;
}

export interface ChartAccountGroupListResult {
  data: ChartAccountGroup[];
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

const SELECT_COLS = 'chart_account_group_id,group_code,group_description,group_type';

const repository = {
  async findAll(params: { from: number; to: number; search?: string; sort?: string; order?: SortOrder }) {
    let query = getSupabaseAdmin()
      .from(TABLE)
      .select(SELECT_COLS, { count: 'exact' })
      .neq('chart_account_group_id', SENTINEL_ID);

    if (params.search) {
      const term = sanitizeTerm(params.search);
      // Cobre TODAS as colunas do grid: código, descrição e tipo.
      query = query.or(`group_code.ilike.%${term}%,group_description.ilike.%${term}%,group_type.ilike.%${term}%`);
    }

    const sorted = resolveSort(params.sort, params.order, SORTABLE_COLUMNS);
    const ordered = sorted
      ? query.order(sorted.column, { ascending: sorted.ascending, nullsFirst: false })
      : query.order('group_code', { ascending: true, nullsFirst: false });

    return ordered.range(params.from, params.to);
  },

  findById(id: number) {
    return getSupabaseAdmin().from(TABLE).select(SELECT_COLS).eq('chart_account_group_id', id).maybeSingle();
  },

  findByCode(code: string, excludeId?: number) {
    let query = getSupabaseAdmin().from(TABLE).select('chart_account_group_id').ilike('group_code', code);
    if (excludeId !== undefined) query = query.neq('chart_account_group_id', excludeId);
    return query.limit(1).maybeSingle();
  },

  create(payload: ChartAccountGroupCreateInput) {
    return getSupabaseAdmin().from(TABLE).insert(payload).select().single();
  },

  update(id: number, payload: ChartAccountGroupUpdateInput) {
    return getSupabaseAdmin().from(TABLE).update(payload).eq('chart_account_group_id', id).select().maybeSingle();
  },

  countReferences(table: string, id: number) {
    return getSupabaseAdmin().from(table).select(REF_COLUMN, { count: 'exact', head: true }).eq(REF_COLUMN, id);
  },

  remove(id: number) {
    return getSupabaseAdmin().from(TABLE).delete().eq('chart_account_group_id', id);
  },
};

export const chartAccountGroupService = {
  async list(params: ChartAccountGroupListParams = {}): Promise<ChartAccountGroupListResult> {
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
    if (error) throw new ChartAccountGroupServiceError(error.message, 500);
    return { data: (data ?? []) as ChartAccountGroup[], total: count ?? 0, page, limit };
  },

  async getById(id: number): Promise<ChartAccountGroup> {
    if (id === SENTINEL_ID) throw new ChartAccountGroupServiceError('Grupo não encontrado', 404);
    const { data, error } = await repository.findById(id);
    if (error) throw new ChartAccountGroupServiceError(error.message, 500);
    if (!data) throw new ChartAccountGroupServiceError('Grupo não encontrado', 404);
    return data as ChartAccountGroup;
  },

  async create(raw: unknown): Promise<ChartAccountGroup> {
    const parsed = chartAccountGroupCreateSchema.safeParse(raw);
    if (!parsed.success) throw new ChartAccountGroupServiceError(formatZodError(parsed.error), 422);

    await this.assertCodeUnique(parsed.data.group_code);

    const { data, error } = await repository.create(parsed.data);
    if (error) throw new ChartAccountGroupServiceError(error.message, 422);
    return data as ChartAccountGroup;
  },

  async update(id: number, raw: unknown): Promise<ChartAccountGroup> {
    if (id === SENTINEL_ID) throw new ChartAccountGroupServiceError('Grupo não encontrado', 404);

    const parsed = chartAccountGroupUpdateSchema.safeParse(raw);
    if (!parsed.success) throw new ChartAccountGroupServiceError(formatZodError(parsed.error), 422);

    if (parsed.data.group_code !== undefined) await this.assertCodeUnique(parsed.data.group_code, id);

    const { data, error } = await repository.update(id, parsed.data);
    if (error) throw new ChartAccountGroupServiceError(error.message, 422);
    if (!data) throw new ChartAccountGroupServiceError('Grupo não encontrado', 404);
    return data as ChartAccountGroup;
  },

  async remove(id: number): Promise<{ chart_account_group_id: number }> {
    if (id === SENTINEL_ID) {
      throw new ChartAccountGroupServiceError('O grupo "não informado" não pode ser excluído', 409);
    }

    const existing = await repository.findById(id);
    if (existing.error) throw new ChartAccountGroupServiceError(existing.error.message, 500);
    if (!existing.data) throw new ChartAccountGroupServiceError('Grupo não encontrado', 404);

    for (const table of REFERENCING_TABLES) {
      const { count, error } = await repository.countReferences(table, id);
      if (error) throw new ChartAccountGroupServiceError(error.message, 500);
      if ((count ?? 0) > 0) {
        throw new ChartAccountGroupServiceError('Grupo em uso e não pode ser excluído', 409);
      }
    }

    const { error } = await repository.remove(id);
    if (error) throw new ChartAccountGroupServiceError(error.message, 500);
    return { chart_account_group_id: id };
  },

  async assertCodeUnique(code: string, excludeId?: number): Promise<void> {
    const { data, error } = await repository.findByCode(code, excludeId);
    if (error) throw new ChartAccountGroupServiceError(error.message, 500);
    if (data) throw new ChartAccountGroupServiceError('Código já cadastrado', 409);
  },
};
