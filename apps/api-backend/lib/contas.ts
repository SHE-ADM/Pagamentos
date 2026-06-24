// lib/contas.ts
// CRUD de contas a pagar (tabela financial_account_control) sobre o Supabase
// (service_role, ignora RLS). Repository → Service → Route (espelha lib/suppliers.ts).
// As rotas mapeiam ContaServiceError para o status HTTP via instanceof.
//
// Regras refletidas:
// - PK é `id` (BIGINT); o fornecedor é a FK `sk_supplier` (obrigatória).
// - SEM hard-delete: "remoção" = PATCH status='cancelado' (a lista exclui cancelado por padrão).
// - document_type/payment_method/amount validados pelos schemas de @sheild/shared.

import {
  financialAccountControlCreateSchema,
  financialAccountControlUpdateSchema,
  type FinancialAccountControl,
  type FinancialAccountControlCreate,
  type FinancialAccountControlUpdate,
} from '@sheild/shared';
import type { ZodError } from 'zod';
import { getSupabaseAdmin } from './supabase-admin';

const TABLE = 'financial_account_control';
const SUPPLIER_TABLE = 'supplier';
// Recursos embutidos: fornecedor (nome/CNPJ/CPF) + classificação contábil (centro
// de custo / plano de contas) vêm de JOINs — não há colunas próprias para exibição.
const SELECT_WITH_SUPPLIER =
  '*,supplier(trade_name,legal_name,cnpj,cpf),' +
  'cost_center:financial_cost_center(cost_center_code,cost_center_description),' +
  'chart_account:financial_chart_of_account(account_code,account_description)';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Colunas pesquisáveis no fornecedor (resolve sk_supplier por termo — índices trgm migration 029).
const SUPPLIER_SEARCH_COLUMNS = ['legal_name', 'trade_name', 'cnpj', 'cpf', 'email', 'email2', 'email3', 'email4'];

export class ContaServiceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ContaServiceError';
    this.status = status;
  }
}

export interface ContaListParams {
  page?: number;
  limit?: number;
  search?: string;
}

export interface ContaListResult {
  data: FinancialAccountControl[];
  total: number;
  page: number;
  limit: number;
}

function formatZodError(error: ZodError): string {
  return error.issues.map((i) => i.message).join('; ');
}

function duplicateMessage(detail: string): string {
  if (/cnpj/i.test(detail)) return 'CNPJ já cadastrado';
  if (/cpf/i.test(detail)) return 'CPF já cadastrado';
  return 'Registro já cadastrado';
}

// Sanitiza o termo de busca para o filtro `or` do PostgREST (chars de controle da sintaxe).
function sanitizeTerm(term: string): string {
  return term.replace(/[%,()]/g, ' ').trim();
}

const contaRepository = {
  // Resolve os sk_supplier cujo cadastro casa o termo (nome/CNPJ/CPF/e-mails).
  async supplierSkByTerm(term: string): Promise<number[]> {
    const { data, error } = await getSupabaseAdmin()
      .from(SUPPLIER_TABLE)
      .select('sk_supplier')
      .or(SUPPLIER_SEARCH_COLUMNS.map((c) => `${c}.ilike.%${term}%`).join(','))
      .limit(1000);
    if (error) throw new ContaServiceError(error.message, 500);
    return (data ?? []).map((r) => (r as { sk_supplier: number }).sk_supplier);
  },

  async findAll(params: { from: number; to: number; search?: string }) {
    let query = getSupabaseAdmin()
      .from(TABLE)
      .select(SELECT_WITH_SUPPLIER, { count: 'exact' })
      // Contas canceladas ficam fora da lista por padrão (mesmo critério de /consulta).
      .neq('status', 'cancelado');

    if (params.search) {
      const term = sanitizeTerm(params.search);
      const skIds = await contaRepository.supplierSkByTerm(term);
      const clauses = [
        `invoice_number.ilike.%${term}%`,
        `subject.ilike.%${term}%`,
        `sender_email.ilike.%${term}%`,
      ];
      if (skIds.length) clauses.push(`sk_supplier.in.(${skIds.join(',')})`);
      query = query.or(clauses.join(','));
    }

    return query.order('created_at', { ascending: false }).range(params.from, params.to);
  },

  findById(id: number) {
    return getSupabaseAdmin().from(TABLE).select(SELECT_WITH_SUPPLIER).eq('id', id).maybeSingle();
  },

  create(payload: FinancialAccountControlCreate) {
    return getSupabaseAdmin().from(TABLE).insert(payload).select(SELECT_WITH_SUPPLIER).single();
  },

  update(id: number, payload: FinancialAccountControlUpdate) {
    return getSupabaseAdmin().from(TABLE).update(payload).eq('id', id).select(SELECT_WITH_SUPPLIER).maybeSingle();
  },
};

export const contaService = {
  /**
   * Lista contas (exceto canceladas) com paginação e busca textual (fornecedor +
   * nº documento/assunto/remetente).
   * @param params `page` (>=1), `limit` (1..100), `search`.
   * @returns `{ data, total, page, limit }` para o envelope com `meta`.
   * @throws {ContaServiceError} 500 em falha do banco.
   */
  async list(params: ContaListParams = {}): Promise<ContaListResult> {
    const page = Math.max(1, Math.trunc(params.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(params.limit ?? DEFAULT_LIMIT)));
    const from = (page - 1) * limit;

    const { data, count, error } = await contaRepository.findAll({
      from,
      to: from + limit - 1,
      search: params.search?.trim() || undefined,
    });
    if (error) throw new ContaServiceError(error.message, 500);

    return { data: (data ?? []) as unknown as FinancialAccountControl[], total: count ?? 0, page, limit };
  },

  /**
   * Obtém uma conta por `id` (PK).
   * @throws {ContaServiceError} 404 quando não existe.
   */
  async getById(id: number): Promise<FinancialAccountControl> {
    const { data, error } = await contaRepository.findById(id);
    if (error) throw new ContaServiceError(error.message, 500);
    if (!data) throw new ContaServiceError('Conta não encontrada', 404);
    return data as unknown as FinancialAccountControl;
  },

  /**
   * Cria uma conta a pagar. Valida com `financialAccountControlCreateSchema`
   * (sk_supplier obrigatório, amount > 0, document_type/payment_method dos enums).
   * @throws {ContaServiceError} 422 (payload inválido) ou 409 (violação UNIQUE).
   */
  async create(raw: unknown): Promise<FinancialAccountControl> {
    const parsed = financialAccountControlCreateSchema.safeParse(raw);
    if (!parsed.success) throw new ContaServiceError(formatZodError(parsed.error), 422);

    const { data, error } = await contaRepository.create(parsed.data);
    if (error) {
      if (error.code === '23505') throw new ContaServiceError(duplicateMessage(error.details ?? error.message), 409);
      throw new ContaServiceError(error.message, 422);
    }
    return data as unknown as FinancialAccountControl;
  },

  /**
   * Atualiza campos de uma conta (partial). Permite alterar a situação
   * (ex.: `status='cancelado'` é a forma de "remover" — não há hard-delete).
   * @throws {ContaServiceError} 422 (payload inválido), 404 (inexistente) ou 409 (UNIQUE).
   */
  async update(id: number, raw: unknown): Promise<FinancialAccountControl> {
    const parsed = financialAccountControlUpdateSchema.safeParse(raw);
    if (!parsed.success) throw new ContaServiceError(formatZodError(parsed.error), 422);

    const { data, error } = await contaRepository.update(id, parsed.data);
    if (error) {
      if (error.code === '23505') throw new ContaServiceError(duplicateMessage(error.details ?? error.message), 409);
      throw new ContaServiceError(error.message, 422);
    }
    if (!data) throw new ContaServiceError('Conta não encontrada', 404);
    return data as unknown as FinancialAccountControl;
  },
};
