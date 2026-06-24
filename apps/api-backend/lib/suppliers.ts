// lib/suppliers.ts
// CRUD de fornecedores (tabela `supplier`) sobre o Supabase (service_role, ignora RLS).
// Repository (acesso ao banco) → Service (regras + validação Zod). As rotas mapeiam
// SupplierServiceError para o status HTTP via instanceof (padrão de PythonBridgeError).
//
// Regras de negócio refletidas:
// - chk_supplier_has_identifier (migration 011): ao menos um identificador no create.
// - soft delete (migration 045): baixa marca deleted_at; leituras filtram deleted_at IS NULL.
// - supplier é PRESERVADO: a baixa é bloqueada (409) quando há contas vinculadas.

import {
  supplierCreateSchema,
  supplierUpdateSchema,
  type Supplier,
  type SupplierCreateInput,
  type SupplierUpdateInput,
} from '@sheild/shared/schemas';
import type { ZodError } from 'zod';
import { getSupabaseAdmin } from './supabase-admin';

const SUPPLIER_TABLE = 'supplier';
const ACCOUNTS_TABLE = 'financial_account_control';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Colunas pesquisáveis no filtro de texto (índices GIN trigram — migration 029).
const SEARCH_COLUMNS = ['legal_name', 'trade_name', 'cnpj', 'cpf', 'email', 'email2', 'email3', 'email4'];

// Erro de negócio com status HTTP — capturado por instanceof nos route handlers.
export class SupplierServiceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SupplierServiceError';
    this.status = status;
  }
}

export interface SupplierListParams {
  page?: number;
  limit?: number;
  search?: string;
  /** Ordenação: `name` = alfabética por nome fantasia (lookup); padrão = mais recentes. */
  sort?: 'name';
}

export interface SupplierListResult {
  data: Supplier[];
  total: number;
  page: number;
  limit: number;
}

function formatZodError(error: ZodError): string {
  return error.issues.map((i) => i.message).join('; ');
}

// Violação de UNIQUE (cnpj/cpf) do Postgres → 409. A mensagem distingue o campo.
function duplicateMessage(detail: string): string {
  if (/cnpj/i.test(detail)) return 'CNPJ já cadastrado';
  if (/cpf/i.test(detail)) return 'CPF já cadastrado';
  return 'Fornecedor já cadastrado';
}

// Camada de acesso ao banco. Interna ao módulo — os testes exercitam-na via service.
const supplierRepository = {
  async findAll(params: { from: number; to: number; search?: string; sort?: 'name' }) {
    let query = getSupabaseAdmin()
      .from(SUPPLIER_TABLE)
      .select('*', { count: 'exact' })
      .is('deleted_at', null);

    if (params.search) {
      const term = params.search.replace(/[%,()]/g, ' ').trim();
      query = query.or(SEARCH_COLUMNS.map((c) => `${c}.ilike.%${term}%`).join(','));
    }

    // `name` = alfabética por nome fantasia (usada pelo lookup do modal de contas);
    // padrão = mais recentes primeiro (sk_supplier desc — usado pela página /fornecedores).
    const ordered =
      params.sort === 'name'
        ? query.order('trade_name', { ascending: true, nullsFirst: false })
        : query.order('sk_supplier', { ascending: false });

    return ordered.range(params.from, params.to);
  },

  findBySk(sk: number) {
    return getSupabaseAdmin()
      .from(SUPPLIER_TABLE)
      .select('*')
      .eq('sk_supplier', sk)
      .is('deleted_at', null)
      .maybeSingle();
  },

  create(payload: SupplierCreateInput) {
    return getSupabaseAdmin().from(SUPPLIER_TABLE).insert(payload).select().single();
  },

  update(sk: number, payload: SupplierUpdateInput) {
    return getSupabaseAdmin()
      .from(SUPPLIER_TABLE)
      .update(payload)
      .eq('sk_supplier', sk)
      .is('deleted_at', null)
      .select()
      .maybeSingle();
  },

  // Conta quantas contas a pagar referenciam o fornecedor (FK reversa).
  countLinkedAccounts(sk: number) {
    return getSupabaseAdmin()
      .from(ACCOUNTS_TABLE)
      .select('sk_supplier', { count: 'exact', head: true })
      .eq('sk_supplier', sk);
  },

  softDelete(sk: number, deletedAt: string) {
    return getSupabaseAdmin()
      .from(SUPPLIER_TABLE)
      .update({ deleted_at: deletedAt })
      .eq('sk_supplier', sk)
      .is('deleted_at', null)
      .select()
      .maybeSingle();
  },
};

export const supplierService = {
  /**
   * Lista fornecedores ativos (deleted_at IS NULL) com paginação e busca textual.
   * @param params `page` (>=1), `limit` (1..100), `search` (casa nome/CNPJ/CPF/e-mails).
   * @returns `{ data, total, page, limit }` para o envelope com `meta`.
   * @throws {SupplierServiceError} 500 em falha do banco.
   */
  async list(params: SupplierListParams = {}): Promise<SupplierListResult> {
    const page = Math.max(1, Math.trunc(params.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(params.limit ?? DEFAULT_LIMIT)));
    const from = (page - 1) * limit;

    const { data, count, error } = await supplierRepository.findAll({
      from,
      to: from + limit - 1,
      search: params.search?.trim() || undefined,
      sort: params.sort,
    });
    if (error) throw new SupplierServiceError(error.message, 500);

    return { data: (data ?? []) as Supplier[], total: count ?? 0, page, limit };
  },

  /**
   * Obtém um fornecedor ativo por sk_supplier.
   * @param sk Surrogate key do fornecedor.
   * @returns O fornecedor encontrado.
   * @throws {SupplierServiceError} 404 quando não existe (ou está baixado).
   */
  async getBySk(sk: number): Promise<Supplier> {
    const { data, error } = await supplierRepository.findBySk(sk);
    if (error) throw new SupplierServiceError(error.message, 500);
    if (!data) throw new SupplierServiceError('Fornecedor não encontrado', 404);
    return data as Supplier;
  },

  /**
   * Cria um fornecedor. Valida o input (ao menos um identificador; CNPJ/CPF sem
   * máscara) e persiste via service_role.
   * @param raw Corpo da requisição (não confiável) — validado com `supplierCreateSchema`.
   * @returns O fornecedor criado.
   * @throws {SupplierServiceError} 422 (payload inválido) ou 409 (CNPJ/CPF duplicado).
   */
  async create(raw: unknown): Promise<Supplier> {
    const parsed = supplierCreateSchema.safeParse(raw);
    if (!parsed.success) throw new SupplierServiceError(formatZodError(parsed.error), 422);

    const { data, error } = await supplierRepository.create(parsed.data);
    if (error) {
      if (error.code === '23505') {
        throw new SupplierServiceError(duplicateMessage(error.details ?? error.message), 409);
      }
      throw new SupplierServiceError(error.message, 422);
    }
    return data as Supplier;
  },

  /**
   * Atualiza campos de um fornecedor (partial update).
   * @param sk Surrogate key do fornecedor.
   * @param raw Campos a atualizar — validados com `supplierUpdateSchema`.
   * @returns O fornecedor atualizado.
   * @throws {SupplierServiceError} 422 (payload inválido), 404 (inexistente) ou 409 (CNPJ/CPF de outro registro).
   */
  async update(sk: number, raw: unknown): Promise<Supplier> {
    const parsed = supplierUpdateSchema.safeParse(raw);
    if (!parsed.success) throw new SupplierServiceError(formatZodError(parsed.error), 422);

    const { data, error } = await supplierRepository.update(sk, parsed.data);
    if (error) {
      if (error.code === '23505') {
        throw new SupplierServiceError(duplicateMessage(error.details ?? error.message), 409);
      }
      throw new SupplierServiceError(error.message, 422);
    }
    if (!data) throw new SupplierServiceError('Fornecedor não encontrado', 404);
    return data as Supplier;
  },

  /**
   * Baixa lógica (soft delete) de um fornecedor. Bloqueada quando há contas a pagar
   * vinculadas (FK reversa) — fornecedor com histórico é PRESERVADO.
   * @param sk Surrogate key do fornecedor.
   * @param now Timestamp ISO da baixa (injetado pela rota para testabilidade).
   * @returns `{ sk_supplier }` do fornecedor baixado.
   * @throws {SupplierServiceError} 404 (inexistente) ou 409 (possui contas vinculadas).
   */
  async remove(sk: number, now: string): Promise<{ sk_supplier: number }> {
    const existing = await supplierRepository.findBySk(sk);
    if (existing.error) throw new SupplierServiceError(existing.error.message, 500);
    if (!existing.data) throw new SupplierServiceError('Fornecedor não encontrado', 404);

    const linked = await supplierRepository.countLinkedAccounts(sk);
    if (linked.error) throw new SupplierServiceError(linked.error.message, 500);
    if ((linked.count ?? 0) > 0) {
      throw new SupplierServiceError('Fornecedor possui contas vinculadas e não pode ser removido', 409);
    }

    const { error } = await supplierRepository.softDelete(sk, now);
    if (error) throw new SupplierServiceError(error.message, 500);
    return { sk_supplier: sk };
  },
};
