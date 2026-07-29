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
import { resolveMatchingIds } from './search';
import { validateTypeGroupScope } from './lookups';
import { ApiServiceError } from './api-error';

const TABLE = 'financial_chart_of_account_group';
const SORTABLE_COLUMNS = ['group_code', 'group_description', 'group_type', 'type_group_id'] as const;
// O grupo é referenciado por DUAS tabelas via `chart_account_group_id`: o subgrupo
// (hierarquia clássica) e o plano de contas DIRETAMENTE (FK `fk_fin_coa_group`,
// migration 058). Ambas precisam bloquear o hard delete (→ 409), senão o Postgres
// rejeita com 23503 e o contrato quebra em 500. Ver achado A1-1.
const REFERENCING_TABLES = ['financial_chart_of_account_subgroup', 'financial_chart_of_account'] as const;
const REF_COLUMN = 'chart_account_group_id';
const SENTINEL_ID = 0;
const DEFAULT_LIMIT = 20;
// Teto de itens por requisição. 1000 (igual a lib/lookups.ts) para o modo lookup
// devolver o cadastro completo ao <select> de grupos; a paginação do CRUD usa DEFAULT_LIMIT.
const MAX_LIMIT = 1000;

export class ChartAccountGroupServiceError extends ApiServiceError {
  constructor(message: string, status: number) {
    super(message, status, 'ChartAccountGroupServiceError');
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

// Mapeia erro do Postgres para status HTTP sem VAZAR detalhe interno (§3 M-2):
// 23503 (FK) = Natureza (type_group_id) inexistente → 422; 23505 (UNIQUE) = código
// duplicado → 409 (defensivo — a unicidade já é checada em assertCodeUnique); qualquer
// outro é inesperado (5xx) → o failFromError da rota loga e responde genérico (não vaza).
function mapWriteError(error: { code?: string; message: string }): ChartAccountGroupServiceError {
  if (error.code === '23503') return new ChartAccountGroupServiceError('Natureza informada não existe', 422);
  if (error.code === '23505') return new ChartAccountGroupServiceError('Código já cadastrado', 409);
  return new ChartAccountGroupServiceError(error.message, 500);
}

const SELECT_COLS =
  'chart_account_group_id,group_code,group_description,group_type,type_group_id,' +
  'type_group:financial_type_group(type_group_id,type_group_description)';

const repository = {
  async findAll(params: { from: number; to: number; search?: string; sort?: string; order?: SortOrder }) {
    let query = getSupabaseAdmin()
      .from(TABLE)
      .select(SELECT_COLS, { count: 'exact' })
      .neq('chart_account_group_id', SENTINEL_ID);

    if (params.search) {
      const term = sanitizeTerm(params.search);
      if (term) {
        // Cobre as colunas do grid: código, descrição e NATUREZA (embed). A natureza vem
        // de JOIN — resolvemos os ids do catálogo que casam o termo e os injetamos no OR.
        const clauses = [`group_code.ilike.%${term}%`, `group_description.ilike.%${term}%`];
        const typeGroupIds = await resolveMatchingIds(
          'financial_type_group',
          'type_group_id',
          ['type_group_description'],
          term,
        );
        if (typeGroupIds.length > 0) clauses.push(`type_group_id.in.(${typeGroupIds.join(',')})`);
        query = query.or(clauses.join(','));
      }
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
    return getSupabaseAdmin().from(TABLE).insert(payload).select(SELECT_COLS).single();
  },

  update(id: number, payload: ChartAccountGroupUpdateInput) {
    return getSupabaseAdmin().from(TABLE).update(payload).eq('chart_account_group_id', id).select(SELECT_COLS).maybeSingle();
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
    // `as unknown as`: o embed type_group no SELECT muda a inferência do PostgREST
    // (o relacionamento pode aparecer como GenericStringError), sem overlap direto.
    return { data: (data ?? []) as unknown as ChartAccountGroup[], total: count ?? 0, page, limit };
  },

  async getById(id: number): Promise<ChartAccountGroup> {
    if (id === SENTINEL_ID) throw new ChartAccountGroupServiceError('Grupo não encontrado', 404);
    const { data, error } = await repository.findById(id);
    if (error) throw new ChartAccountGroupServiceError(error.message, 500);
    if (!data) throw new ChartAccountGroupServiceError('Grupo não encontrado', 404);
    return data as unknown as ChartAccountGroup;
  },

  async create(raw: unknown): Promise<ChartAccountGroup> {
    const parsed = chartAccountGroupCreateSchema.safeParse(raw);
    if (!parsed.success) throw new ChartAccountGroupServiceError(formatZodError(parsed.error), 422);

    await this.assertCodeUnique(parsed.data.group_code);
    await this.assertTypeGroupScope(parsed.data.type_group_id ?? 0);

    const { data, error } = await repository.create(parsed.data);
    if (error) throw mapWriteError(error);
    return data as unknown as ChartAccountGroup;
  },

  async update(id: number, raw: unknown): Promise<ChartAccountGroup> {
    if (id === SENTINEL_ID) throw new ChartAccountGroupServiceError('Grupo não encontrado', 404);

    const parsed = chartAccountGroupUpdateSchema.safeParse(raw);
    if (!parsed.success) throw new ChartAccountGroupServiceError(formatZodError(parsed.error), 422);

    if (parsed.data.group_code !== undefined) await this.assertCodeUnique(parsed.data.group_code, id);
    if (parsed.data.type_group_id !== undefined) await this.assertTypeGroupScope(parsed.data.type_group_id);

    const { data, error } = await repository.update(id, parsed.data);
    if (error) throw mapWriteError(error);
    if (!data) throw new ChartAccountGroupServiceError('Grupo não encontrado', 404);
    return data as unknown as ChartAccountGroup;
  },

  // Impede atribuir ao grupo uma Natureza que não seja de escopo 'group' (Finding 2 —
  // ver validateTypeGroupScope em lib/lookups.ts). 422 com mensagem amigável.
  async assertTypeGroupScope(typeGroupId: number): Promise<void> {
    const reason = await validateTypeGroupScope(typeGroupId, 'group');
    if (reason) throw new ChartAccountGroupServiceError(reason, 422);
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
