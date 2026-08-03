// lib/financial-accounts.ts
// CRUD de contas bancárias/caixa (`financial_account`) sobre o Supabase (service_role).
// Repository → Service. PK IDENTITY ALWAYS. Diferente dos demais cadastros: NÃO tem
// sentinela id 0, NÃO tem código único (a chave de exibição é a descrição) e NÃO é
// referenciada por nenhuma FK → exclusão livre (404 se inexistente). FKs `bank_id`
// (→ financial_bank) e `status_id` (→ status, migration 053) obrigatórias (violação
// 23503 → 422). A leitura traz o banco embutido (JOIN). `payment_type_id` é SMALLINT
// sem tabela de domínio (código herdado do Firebird).

import {
  financialAccountCreateSchema,
  financialAccountUpdateSchema,
  type FinancialAccount,
  type FinancialAccountCreateInput,
  type FinancialAccountUpdateInput,
} from '@sheild/shared/schemas';
import type { ZodError } from 'zod';
import { getSupabaseAdmin } from './supabase-admin';
import { applyOrder, resolveSort, type SortOrder } from './sort';
import { resolveMatchingIds, parseNumericTerm } from './search';
import { ApiServiceError } from './api-error';

const TABLE = 'financial_account';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
// Colunas ordenáveis (própria tabela) — o banco é embed de JOIN, não ordenável aqui.
const SORTABLE_COLUMNS = ['account_description', 'currency_code', 'balance_amount', 'payment_type_id', 'status_id'] as const;

// Leitura com o banco embutido (rótulo na grade).
const SELECT_WITH_BANK =
  'financial_account_id,account_description,bank_id,payment_type_id,currency_code,balance_amount,status_id,' +
  'bank:financial_bank(bank_code,bank_name)';

export class FinancialAccountServiceError extends ApiServiceError {
  constructor(message: string, status: number) {
    super(message, status, 'FinancialAccountServiceError');
  }
}

export interface FinancialAccountListParams {
  page?: number;
  limit?: number;
  search?: string;
  sort?: string;
  order?: SortOrder;
}

export interface FinancialAccountListResult {
  data: FinancialAccount[];
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

// 23503 (FK) = banco ou situação inexistente → 422. A mensagem distingue o campo
// pela constraint citada (fk_fin_account_bank / fk_financial_account_status).
function mapWriteError(error: { code?: string; message: string; details?: string }): FinancialAccountServiceError {
  if (error.code === '23503') {
    const detail = `${error.details ?? ''} ${error.message}`;
    if (/status/i.test(detail)) return new FinancialAccountServiceError('Situação informada não existe', 422);
    if (/bank/i.test(detail)) return new FinancialAccountServiceError('Banco informado não existe', 422);
    return new FinancialAccountServiceError('Banco ou situação informada não existe', 422);
  }
  return new FinancialAccountServiceError(error.message, 422);
}

// Monta as cláusulas do OR da busca cobrindo TODAS as colunas do grid: descrição e
// moeda (texto), banco e situação (embeds de JOIN → ids pré-resolvidos), saldo e tipo
// de pagamento (numéricos → igualdade exata quando o termo é um número).
async function buildSearchClauses(term: string): Promise<string[]> {
  const clauses = [`account_description.ilike.%${term}%`, `currency_code.ilike.%${term}%`];

  const [bankIds, statusIds] = await Promise.all([
    resolveMatchingIds('financial_bank', 'bank_id', ['bank_code', 'bank_name'], term),
    resolveMatchingIds('status', 'status_id', ['status_name', 'status_short_name'], term),
  ]);
  if (bankIds.length > 0) clauses.push(`bank_id.in.(${bankIds.join(',')})`);
  if (statusIds.length > 0) clauses.push(`status_id.in.(${statusIds.join(',')})`);

  const num = parseNumericTerm(term);
  if (num !== null) {
    clauses.push(`balance_amount.eq.${num}`);
    if (Number.isInteger(num)) clauses.push(`payment_type_id.eq.${num}`);
  }

  return clauses;
}

const repository = {
  async findAll(params: { from: number; to: number; search?: string; sort?: string; order?: SortOrder }) {
    let query = getSupabaseAdmin().from(TABLE).select(SELECT_WITH_BANK, { count: 'exact' });

    if (params.search) {
      const term = sanitizeTerm(params.search);
      if (term) query = query.or((await buildSearchClauses(term)).join(','));
    }

    // applyOrder desempata pela PK — obrigatório com paginação por range (ver lib/sort.ts).
    // O fallback já É a PK; nesse caso applyOrder não duplica a coluna.
    const sorted = resolveSort(params.sort, params.order, SORTABLE_COLUMNS);
    const fallback = { column: 'financial_account_id', ascending: true };

    return applyOrder(query, sorted, fallback, 'financial_account_id').range(params.from, params.to);
  },

  findById(id: number) {
    return getSupabaseAdmin().from(TABLE).select(SELECT_WITH_BANK).eq('financial_account_id', id).maybeSingle();
  },

  create(payload: FinancialAccountCreateInput) {
    return getSupabaseAdmin().from(TABLE).insert(payload).select(SELECT_WITH_BANK).single();
  },

  update(id: number, payload: FinancialAccountUpdateInput) {
    return getSupabaseAdmin().from(TABLE).update(payload).eq('financial_account_id', id).select(SELECT_WITH_BANK).maybeSingle();
  },

  remove(id: number) {
    return getSupabaseAdmin().from(TABLE).delete().eq('financial_account_id', id);
  },
};

export const financialAccountService = {
  async list(params: FinancialAccountListParams = {}): Promise<FinancialAccountListResult> {
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
    if (error) throw new FinancialAccountServiceError(error.message, 500);
    return { data: (data ?? []) as unknown as FinancialAccount[], total: count ?? 0, page, limit };
  },

  async getById(id: number): Promise<FinancialAccount> {
    const { data, error } = await repository.findById(id);
    if (error) throw new FinancialAccountServiceError(error.message, 500);
    if (!data) throw new FinancialAccountServiceError('Conta não encontrada', 404);
    return data as unknown as FinancialAccount;
  },

  async create(raw: unknown): Promise<FinancialAccount> {
    const parsed = financialAccountCreateSchema.safeParse(raw);
    if (!parsed.success) throw new FinancialAccountServiceError(formatZodError(parsed.error), 422);

    const { data, error } = await repository.create(parsed.data);
    if (error) throw mapWriteError(error);
    return data as unknown as FinancialAccount;
  },

  async update(id: number, raw: unknown): Promise<FinancialAccount> {
    const parsed = financialAccountUpdateSchema.safeParse(raw);
    if (!parsed.success) throw new FinancialAccountServiceError(formatZodError(parsed.error), 422);

    const { data, error } = await repository.update(id, parsed.data);
    if (error) throw mapWriteError(error);
    if (!data) throw new FinancialAccountServiceError('Conta não encontrada', 404);
    return data as unknown as FinancialAccount;
  },

  async remove(id: number): Promise<{ financial_account_id: number }> {
    const existing = await repository.findById(id);
    if (existing.error) throw new FinancialAccountServiceError(existing.error.message, 500);
    if (!existing.data) throw new FinancialAccountServiceError('Conta não encontrada', 404);

    const { error } = await repository.remove(id);
    if (error) throw new FinancialAccountServiceError(error.message, 500);
    return { financial_account_id: id };
  },
};
