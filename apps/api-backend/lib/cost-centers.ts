// lib/cost-centers.ts
// CRUD de centros de custo (tabela `financial_cost_center`) sobre o Supabase
// (service_role, ignora RLS). Repository (acesso ao banco) → Service (regras +
// validação Zod). As rotas mapeiam CostCenterServiceError para o status HTTP.
//
// Regras de negócio refletidas:
// - cost_center_id é SMALLINT IDENTITY ALWAYS — gerado pelo banco, nunca no corpo.
// - o id 0 é o sentinela "não informado" — preservado, fora do CRUD (não lista,
//   não edita, não exclui).
// - código único (não há UNIQUE no banco — validado aqui, case-insensitive).
// - exclusão é HARD DELETE, bloqueada (409) quando o centro está em uso por
//   contas, planos de contas ou fornecedores (integridade referencial).

import {
  costCenterCreateSchema,
  costCenterUpdateSchema,
  type CostCenter,
  type CostCenterCreateInput,
  type CostCenterUpdateInput,
} from '@sheild/shared/schemas';
import type { ZodError } from 'zod';
import { getSupabaseAdmin } from './supabase-admin';

const COST_CENTER_TABLE = 'financial_cost_center';
// Tabelas que referenciam o centro via FK — consultadas antes do delete.
const REFERENCING_TABLES = ['financial_account_control', 'financial_chart_of_account', 'supplier'] as const;
const SENTINEL_ID = 0; // "não informado" — preservado, fora do CRUD.
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Erro de negócio com status HTTP — capturado por instanceof nos route handlers.
export class CostCenterServiceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'CostCenterServiceError';
    this.status = status;
  }
}

export interface CostCenterListParams {
  page?: number;
  limit?: number;
  search?: string;
}

export interface CostCenterListResult {
  data: CostCenter[];
  total: number;
  page: number;
  limit: number;
}

function formatZodError(error: ZodError): string {
  return error.issues.map((i) => i.message).join('; ');
}

// Sanitiza o termo para o filtro `or` do PostgREST (chars de controle da sintaxe).
function sanitizeTerm(term: string): string {
  return term.replace(/[%,()]/g, ' ').trim();
}

// Camada de acesso ao banco. Interna ao módulo — os testes exercitam-na via service.
const costCenterRepository = {
  async findAll(params: { from: number; to: number; search?: string }) {
    let query = getSupabaseAdmin()
      .from(COST_CENTER_TABLE)
      .select('cost_center_id,cost_center_code,cost_center_description', { count: 'exact' })
      .neq('cost_center_id', SENTINEL_ID); // nunca lista o sentinela "não informado".

    if (params.search) {
      const term = sanitizeTerm(params.search);
      query = query.or(`cost_center_code.ilike.%${term}%,cost_center_description.ilike.%${term}%`);
    }

    return query
      .order('cost_center_code', { ascending: true, nullsFirst: false })
      .range(params.from, params.to);
  },

  findById(id: number) {
    return getSupabaseAdmin()
      .from(COST_CENTER_TABLE)
      .select('cost_center_id,cost_center_code,cost_center_description')
      .eq('cost_center_id', id)
      .maybeSingle();
  },

  // Busca um centro com o mesmo código (case-insensitive), opcionalmente excluindo
  // um id (no update, para não colidir consigo mesmo). Match exato via ilike sem
  // wildcards. Retorna a primeira linha encontrada (ou null).
  findByCode(code: string, excludeId?: number) {
    let query = getSupabaseAdmin()
      .from(COST_CENTER_TABLE)
      .select('cost_center_id')
      .ilike('cost_center_code', code);
    if (excludeId !== undefined) query = query.neq('cost_center_id', excludeId);
    return query.limit(1).maybeSingle();
  },

  create(payload: CostCenterCreateInput) {
    return getSupabaseAdmin().from(COST_CENTER_TABLE).insert(payload).select().single();
  },

  update(id: number, payload: CostCenterUpdateInput) {
    return getSupabaseAdmin()
      .from(COST_CENTER_TABLE)
      .update(payload)
      .eq('cost_center_id', id)
      .select()
      .maybeSingle();
  },

  // Conta referências ao centro numa tabela específica (head + count, sem trazer linhas).
  countReferences(table: string, id: number) {
    return getSupabaseAdmin().from(table).select('cost_center_id', { count: 'exact', head: true }).eq('cost_center_id', id);
  },

  remove(id: number) {
    return getSupabaseAdmin().from(COST_CENTER_TABLE).delete().eq('cost_center_id', id);
  },
};

export const costCenterService = {
  /**
   * Lista centros de custo (exclui o sentinela id 0) com paginação e busca textual.
   * @param params `page` (>=1), `limit` (1..100), `search` (casa código/descrição).
   * @returns `{ data, total, page, limit }` para o envelope com `meta`.
   * @throws {CostCenterServiceError} 500 em falha do banco.
   */
  async list(params: CostCenterListParams = {}): Promise<CostCenterListResult> {
    const page = Math.max(1, Math.trunc(params.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(params.limit ?? DEFAULT_LIMIT)));
    const from = (page - 1) * limit;

    const { data, count, error } = await costCenterRepository.findAll({
      from,
      to: from + limit - 1,
      search: params.search?.trim() || undefined,
    });
    if (error) throw new CostCenterServiceError(error.message, 500);

    return { data: (data ?? []) as CostCenter[], total: count ?? 0, page, limit };
  },

  /**
   * Obtém um centro de custo por id (exceto o sentinela).
   * @throws {CostCenterServiceError} 400 (sentinela), 404 (inexistente) ou 500.
   */
  async getById(id: number): Promise<CostCenter> {
    if (id === SENTINEL_ID) throw new CostCenterServiceError('Centro de custo não encontrado', 404);
    const { data, error } = await costCenterRepository.findById(id);
    if (error) throw new CostCenterServiceError(error.message, 500);
    if (!data) throw new CostCenterServiceError('Centro de custo não encontrado', 404);
    return data as CostCenter;
  },

  /**
   * Cria um centro de custo. Valida o input (código/descrição obrigatórios) e a
   * unicidade do código (case-insensitive) antes de persistir.
   * @throws {CostCenterServiceError} 422 (payload inválido) ou 409 (código duplicado).
   */
  async create(raw: unknown): Promise<CostCenter> {
    const parsed = costCenterCreateSchema.safeParse(raw);
    if (!parsed.success) throw new CostCenterServiceError(formatZodError(parsed.error), 422);

    await this.assertCodeUnique(parsed.data.cost_center_code);

    const { data, error } = await costCenterRepository.create(parsed.data);
    if (error) throw new CostCenterServiceError(error.message, 422);
    return data as CostCenter;
  },

  /**
   * Atualiza um centro de custo (partial). Bloqueia o sentinela e valida a
   * unicidade do código (excluindo o próprio registro).
   * @throws {CostCenterServiceError} 422, 404, 409 ou 400.
   */
  async update(id: number, raw: unknown): Promise<CostCenter> {
    if (id === SENTINEL_ID) throw new CostCenterServiceError('Centro de custo não encontrado', 404);

    const parsed = costCenterUpdateSchema.safeParse(raw);
    if (!parsed.success) throw new CostCenterServiceError(formatZodError(parsed.error), 422);

    if (parsed.data.cost_center_code !== undefined) {
      await this.assertCodeUnique(parsed.data.cost_center_code, id);
    }

    const { data, error } = await costCenterRepository.update(id, parsed.data);
    if (error) throw new CostCenterServiceError(error.message, 422);
    if (!data) throw new CostCenterServiceError('Centro de custo não encontrado', 404);
    return data as CostCenter;
  },

  /**
   * Exclui um centro de custo (HARD DELETE). Bloqueada para o sentinela e quando
   * o centro está referenciado por contas, planos de contas ou fornecedores.
   * @returns `{ cost_center_id }` do centro excluído.
   * @throws {CostCenterServiceError} 404 (inexistente), 409 (em uso) ou 500.
   */
  async remove(id: number): Promise<{ cost_center_id: number }> {
    if (id === SENTINEL_ID) {
      throw new CostCenterServiceError('O centro de custo "não informado" não pode ser excluído', 409);
    }

    const existing = await costCenterRepository.findById(id);
    if (existing.error) throw new CostCenterServiceError(existing.error.message, 500);
    if (!existing.data) throw new CostCenterServiceError('Centro de custo não encontrado', 404);

    // Integridade referencial: bloqueia o delete se houver qualquer FK apontando para o centro.
    for (const table of REFERENCING_TABLES) {
      const { count, error } = await costCenterRepository.countReferences(table, id);
      if (error) throw new CostCenterServiceError(error.message, 500);
      if ((count ?? 0) > 0) {
        throw new CostCenterServiceError('Centro de custo em uso e não pode ser excluído', 409);
      }
    }

    const { error } = await costCenterRepository.remove(id);
    if (error) throw new CostCenterServiceError(error.message, 500);
    return { cost_center_id: id };
  },

  /**
   * Garante que não exista outro centro com o mesmo código (case-insensitive).
   * @throws {CostCenterServiceError} 409 quando o código já está em uso.
   */
  async assertCodeUnique(code: string, excludeId?: number): Promise<void> {
    const { data, error } = await costCenterRepository.findByCode(code, excludeId);
    if (error) throw new CostCenterServiceError(error.message, 500);
    if (data) throw new CostCenterServiceError('Código já cadastrado', 409);
  },
};
