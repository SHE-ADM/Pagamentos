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
import { resolveSort, type SortOrder } from './sort';
import { resolveMatchingIds } from './search';

const TABLE = 'financial_chart_of_account';
// Colunas ordenáveis. Além das colunas próprias (código/descrição), as 3 colunas de
// classificação ordenam ALFABETICAMENTE pela descrição do embed, via a sintaxe do
// PostgREST `alias(coluna)` (mesmo padrão do /consulta; o alias casa o SELECT_WITH_EMBEDS).
// O allowlist contém os valores literais permitidos (defesa contra coluna arbitrária).
const SORTABLE_COLUMNS = [
  'account_code',
  'account_description',
  'cost_center(cost_center_description)',
  'group(group_description)',
  'subgroup(subgroup_description)',
] as const;
const REFERENCING_TABLES = ['financial_account_control', 'supplier'] as const;
const REF_COLUMN = 'chart_account_id';
const SENTINEL_ID = 0;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Leitura com centro de custo, grupo e subgrupo embutidos (rótulos na grade).
const SELECT_WITH_EMBEDS =
  'chart_account_id,account_code,account_description,account_level,is_postable,cost_center_id,chart_account_subgroup_id,chart_account_group_id,' +
  'cost_center:financial_cost_center(cost_center_code,cost_center_description),' +
  'subgroup:financial_chart_of_account_subgroup(subgroup_code,subgroup_description),' +
  'group:financial_chart_of_account_group(group_code,group_description)';

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
  sort?: string;
  order?: SortOrder;
  /** Filtra os planos pelo centro de custo (grid complementar de /tabelas/centros-de-custo). */
  costCenterId?: number;
  /** Restringe aos planos lançáveis (is_postable = true). */
  postableOnly?: boolean;
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

// Tabelas de classificação exibidas em colunas (embeds) — o termo casa TAMBÉM o
// código/descrição delas. Como são JOINs, resolvemos os ids que casam o termo e os
// injetamos no OR da query principal (mesmo padrão da busca por fornecedor em /consulta).
const CLASSIFICATION_LOOKUPS = [
  { table: 'financial_cost_center', idColumn: 'cost_center_id', searchColumns: ['cost_center_code', 'cost_center_description'], accountColumn: 'cost_center_id' },
  { table: 'financial_chart_of_account_group', idColumn: 'chart_account_group_id', searchColumns: ['group_code', 'group_description'], accountColumn: 'chart_account_group_id' },
  { table: 'financial_chart_of_account_subgroup', idColumn: 'chart_account_subgroup_id', searchColumns: ['subgroup_code', 'subgroup_description'], accountColumn: 'chart_account_subgroup_id' },
] as const;

// Monta as cláusulas do OR da busca cobrindo TODAS as colunas do grid: código e
// descrição próprios + centro de custo, grupo e sub grupo (via ids pré-resolvidos).
async function buildSearchClauses(term: string): Promise<string[]> {
  const clauses = [`account_code.ilike.%${term}%`, `account_description.ilike.%${term}%`];

  const idLists = await Promise.all(
    CLASSIFICATION_LOOKUPS.map((l) => resolveMatchingIds(l.table, l.idColumn, l.searchColumns, term)),
  );
  CLASSIFICATION_LOOKUPS.forEach((lookup, i) => {
    const ids = idLists[i];
    if (ids.length > 0) clauses.push(`${lookup.accountColumn}.in.(${ids.join(',')})`);
  });

  return clauses;
}

// 23503 (FK) = centro de custo, grupo ou subgrupo inexistente → 422.
function mapWriteError(error: { code?: string; message: string }): ChartAccountServiceError {
  if (error.code === '23503') return new ChartAccountServiceError('Centro de custo, grupo ou subgrupo informado não existe', 422);
  return new ChartAccountServiceError(error.message, 422);
}

const repository = {
  async findAll(params: {
    from: number;
    to: number;
    search?: string;
    sort?: string;
    order?: SortOrder;
    costCenterId?: number;
    postableOnly?: boolean;
  }) {
    let query = getSupabaseAdmin()
      .from(TABLE)
      .select(SELECT_WITH_EMBEDS, { count: 'exact' })
      .neq('chart_account_id', SENTINEL_ID);

    // Filtros aditivos do grid complementar (plano de contas de um centro de custo).
    if (params.costCenterId != null) query = query.eq('cost_center_id', params.costCenterId);
    if (params.postableOnly) query = query.is('is_postable', true);

    if (params.search) {
      const term = sanitizeTerm(params.search);
      if (term) {
        const clauses = await buildSearchClauses(term);
        query = query.or(clauses.join(','));
      }
    }

    const sorted = resolveSort(params.sort, params.order, SORTABLE_COLUMNS);
    const ordered = sorted
      ? query.order(sorted.column, { ascending: sorted.ascending, nullsFirst: false })
      : query.order('account_code', { ascending: true, nullsFirst: false });

    return ordered.range(params.from, params.to);
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
      sort: params.sort,
      order: params.order,
      costCenterId: params.costCenterId,
      postableOnly: params.postableOnly,
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
