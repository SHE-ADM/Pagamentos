// lib/chart-accounts.ts
// CRUD do plano de contas (`financial_chart_of_account`) sobre o Supabase
// (service_role). Repository → Service. PK IDENTITY ALWAYS, sentinela id 0
// preservado, código único na aplicação, hard delete bloqueado quando referenciado
// (por contas a pagar `financial_account_control` ou fornecedores `supplier`).
// A leitura traz centro de custo e subgrupo embutidos (JOIN). O LOOKUP da cascata
// (filtro por centro, só postáveis) permanece em lib/lookups.ts — aqui é o CRUD.

import {
  chartAccountCreateSchema,
  chartAccountUpdateSchema,
  type ChartAccount,
  type ChartAccountCreateInput,
  type ChartAccountUpdateInput,
} from '@sheild/shared/schemas';
import type { ZodError } from 'zod';
import { getSupabaseAdmin } from './supabase-admin';

const TABLE = 'financial_chart_of_account';
const REFERENCING_TABLES = ['financial_account_control', 'supplier'] as const;
const REF_COLUMN = 'chart_account_id';
const SENTINEL_ID = 0;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Leitura com centro de custo e subgrupo embutidos (rótulos na grade).
const SELECT_WITH_EMBEDS =
  'chart_account_id,account_code,account_description,account_level,is_postable,cost_center_id,chart_account_subgroup_id,' +
  'cost_center:financial_cost_center(cost_center_code,cost_center_description),' +
  'subgroup:financial_chart_of_account_subgroup(subgroup_code,subgroup_description)';

export class ChartAccountServiceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ChartAccountServiceError';
    this.status = status;
  }
}

export interface ChartAccountListParams {
  page?: number;
  limit?: number;
  search?: string;
}

export interface ChartAccountListResult {
  data: ChartAccount[];
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

// 23503 (FK) = centro de custo ou subgrupo inexistente → 422.
function mapWriteError(error: { code?: string; message: string }): ChartAccountServiceError {
  if (error.code === '23503') return new ChartAccountServiceError('Centro de custo ou subgrupo informado não existe', 422);
  return new ChartAccountServiceError(error.message, 422);
}

const repository = {
  async findAll(params: { from: number; to: number; search?: string }) {
    let query = getSupabaseAdmin()
      .from(TABLE)
      .select(SELECT_WITH_EMBEDS, { count: 'exact' })
      .neq('chart_account_id', SENTINEL_ID);

    if (params.search) {
      const term = sanitizeTerm(params.search);
      query = query.or(`account_code.ilike.%${term}%,account_description.ilike.%${term}%`);
    }

    return query.order('account_code', { ascending: true, nullsFirst: false }).range(params.from, params.to);
  },

  findById(id: number) {
    return getSupabaseAdmin().from(TABLE).select(SELECT_WITH_EMBEDS).eq('chart_account_id', id).maybeSingle();
  },

  findByCode(code: string, excludeId?: number) {
    let query = getSupabaseAdmin().from(TABLE).select('chart_account_id').ilike('account_code', code);
    if (excludeId !== undefined) query = query.neq('chart_account_id', excludeId);
    return query.limit(1).maybeSingle();
  },

  create(payload: ChartAccountCreateInput) {
    return getSupabaseAdmin().from(TABLE).insert(payload).select(SELECT_WITH_EMBEDS).single();
  },

  update(id: number, payload: ChartAccountUpdateInput) {
    return getSupabaseAdmin().from(TABLE).update(payload).eq('chart_account_id', id).select(SELECT_WITH_EMBEDS).maybeSingle();
  },

  countReferences(table: string, id: number) {
    return getSupabaseAdmin().from(table).select(REF_COLUMN, { count: 'exact', head: true }).eq(REF_COLUMN, id);
  },

  remove(id: number) {
    return getSupabaseAdmin().from(TABLE).delete().eq('chart_account_id', id);
  },
};

export const chartAccountService = {
  async list(params: ChartAccountListParams = {}): Promise<ChartAccountListResult> {
    const page = Math.max(1, Math.trunc(params.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(params.limit ?? DEFAULT_LIMIT)));
    const from = (page - 1) * limit;

    const { data, count, error } = await repository.findAll({
      from,
      to: from + limit - 1,
      search: params.search?.trim() || undefined,
    });
    if (error) throw new ChartAccountServiceError(error.message, 500);
    return { data: (data ?? []) as unknown as ChartAccount[], total: count ?? 0, page, limit };
  },

  async getById(id: number): Promise<ChartAccount> {
    if (id === SENTINEL_ID) throw new ChartAccountServiceError('Plano de contas não encontrado', 404);
    const { data, error } = await repository.findById(id);
    if (error) throw new ChartAccountServiceError(error.message, 500);
    if (!data) throw new ChartAccountServiceError('Plano de contas não encontrado', 404);
    return data as unknown as ChartAccount;
  },

  async create(raw: unknown): Promise<ChartAccount> {
    const parsed = chartAccountCreateSchema.safeParse(raw);
    if (!parsed.success) throw new ChartAccountServiceError(formatZodError(parsed.error), 422);

    await this.assertCodeUnique(parsed.data.account_code);

    const { data, error } = await repository.create(parsed.data);
    if (error) throw mapWriteError(error);
    return data as unknown as ChartAccount;
  },

  async update(id: number, raw: unknown): Promise<ChartAccount> {
    if (id === SENTINEL_ID) throw new ChartAccountServiceError('Plano de contas não encontrado', 404);

    const parsed = chartAccountUpdateSchema.safeParse(raw);
    if (!parsed.success) throw new ChartAccountServiceError(formatZodError(parsed.error), 422);

    if (parsed.data.account_code !== undefined) await this.assertCodeUnique(parsed.data.account_code, id);

    const { data, error } = await repository.update(id, parsed.data);
    if (error) throw mapWriteError(error);
    if (!data) throw new ChartAccountServiceError('Plano de contas não encontrado', 404);
    return data as unknown as ChartAccount;
  },

  async remove(id: number): Promise<{ chart_account_id: number }> {
    if (id === SENTINEL_ID) {
      throw new ChartAccountServiceError('O plano de contas "não informado" não pode ser excluído', 409);
    }

    const existing = await repository.findById(id);
    if (existing.error) throw new ChartAccountServiceError(existing.error.message, 500);
    if (!existing.data) throw new ChartAccountServiceError('Plano de contas não encontrado', 404);

    for (const table of REFERENCING_TABLES) {
      const { count, error } = await repository.countReferences(table, id);
      if (error) throw new ChartAccountServiceError(error.message, 500);
      if ((count ?? 0) > 0) {
        throw new ChartAccountServiceError('Plano de contas em uso e não pode ser excluído', 409);
      }
    }

    const { error } = await repository.remove(id);
    if (error) throw new ChartAccountServiceError(error.message, 500);
    return { chart_account_id: id };
  },

  async assertCodeUnique(code: string, excludeId?: number): Promise<void> {
    const { data, error } = await repository.findByCode(code, excludeId);
    if (error) throw new ChartAccountServiceError(error.message, 500);
    if (data) throw new ChartAccountServiceError('Código já cadastrado', 409);
  },
};
