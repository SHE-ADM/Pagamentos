// lib/banks.ts
// CRUD de bancos (`financial_bank`) sobre o Supabase (service_role). Repository →
// Service. DIFERENÇA dos demais cadastros: a PK `bank_id` NÃO é identity (atribuição
// manual) — `create` calcula `max(bank_id)+1` (cadastro de baixíssima concorrência;
// risco de corrida aceitável). Sentinela id 0 preservado, código único na aplicação,
// hard delete bloqueado quando referenciado (por contas em `financial_account`).

import {
  bankCreateSchema,
  bankUpdateSchema,
  type Bank,
  type BankCreateInput,
  type BankUpdateInput,
} from '@sheild/shared/schemas';
import type { ZodError } from 'zod';
import { getSupabaseAdmin } from './supabase-admin';

const TABLE = 'financial_bank';
const REFERENCING_TABLES = ['financial_account'] as const;
const REF_COLUMN = 'bank_id';
const SENTINEL_ID = 0;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const SELECT_COLS = 'bank_id,bank_code,bank_name';

export class BankServiceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'BankServiceError';
    this.status = status;
  }
}

export interface BankListParams {
  page?: number;
  limit?: number;
  search?: string;
}

export interface BankListResult {
  data: Bank[];
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

const repository = {
  async findAll(params: { from: number; to: number; search?: string }) {
    let query = getSupabaseAdmin().from(TABLE).select(SELECT_COLS, { count: 'exact' }).neq('bank_id', SENTINEL_ID);

    if (params.search) {
      const term = sanitizeTerm(params.search);
      query = query.or(`bank_code.ilike.%${term}%,bank_name.ilike.%${term}%`);
    }

    return query.order('bank_code', { ascending: true, nullsFirst: false }).range(params.from, params.to);
  },

  findById(id: number) {
    return getSupabaseAdmin().from(TABLE).select(SELECT_COLS).eq('bank_id', id).maybeSingle();
  },

  findByCode(code: string, excludeId?: number) {
    let query = getSupabaseAdmin().from(TABLE).select('bank_id').ilike('bank_code', code);
    if (excludeId !== undefined) query = query.neq('bank_id', excludeId);
    return query.limit(1).maybeSingle();
  },

  // bank_id não é identity — busca o maior id para o próximo (max+1).
  maxId() {
    return getSupabaseAdmin().from(TABLE).select('bank_id').order('bank_id', { ascending: false }).limit(1).maybeSingle();
  },

  create(payload: BankCreateInput & { bank_id: number }) {
    return getSupabaseAdmin().from(TABLE).insert(payload).select(SELECT_COLS).single();
  },

  update(id: number, payload: BankUpdateInput) {
    return getSupabaseAdmin().from(TABLE).update(payload).eq('bank_id', id).select(SELECT_COLS).maybeSingle();
  },

  countReferences(table: string, id: number) {
    return getSupabaseAdmin().from(table).select(REF_COLUMN, { count: 'exact', head: true }).eq(REF_COLUMN, id);
  },

  remove(id: number) {
    return getSupabaseAdmin().from(TABLE).delete().eq('bank_id', id);
  },
};

export const bankService = {
  async list(params: BankListParams = {}): Promise<BankListResult> {
    const page = Math.max(1, Math.trunc(params.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(params.limit ?? DEFAULT_LIMIT)));
    const from = (page - 1) * limit;

    const { data, count, error } = await repository.findAll({
      from,
      to: from + limit - 1,
      search: params.search?.trim() || undefined,
    });
    if (error) throw new BankServiceError(error.message, 500);
    return { data: (data ?? []) as Bank[], total: count ?? 0, page, limit };
  },

  async getById(id: number): Promise<Bank> {
    if (id === SENTINEL_ID) throw new BankServiceError('Banco não encontrado', 404);
    const { data, error } = await repository.findById(id);
    if (error) throw new BankServiceError(error.message, 500);
    if (!data) throw new BankServiceError('Banco não encontrado', 404);
    return data as Bank;
  },

  async create(raw: unknown): Promise<Bank> {
    const parsed = bankCreateSchema.safeParse(raw);
    if (!parsed.success) throw new BankServiceError(formatZodError(parsed.error), 422);

    await this.assertCodeUnique(parsed.data.bank_code);

    // PK manual: próximo id = max+1 (0 é o sentinela, então o primeiro real é 1).
    const max = await repository.maxId();
    if (max.error) throw new BankServiceError(max.error.message, 500);
    const nextId = Math.max(SENTINEL_ID, (max.data?.bank_id ?? SENTINEL_ID)) + 1;

    const { data, error } = await repository.create({ ...parsed.data, bank_id: nextId });
    if (error) {
      if (error.code === '23505') throw new BankServiceError('Banco já cadastrado', 409);
      throw new BankServiceError(error.message, 422);
    }
    return data as Bank;
  },

  async update(id: number, raw: unknown): Promise<Bank> {
    if (id === SENTINEL_ID) throw new BankServiceError('Banco não encontrado', 404);

    const parsed = bankUpdateSchema.safeParse(raw);
    if (!parsed.success) throw new BankServiceError(formatZodError(parsed.error), 422);

    if (parsed.data.bank_code !== undefined) await this.assertCodeUnique(parsed.data.bank_code, id);

    const { data, error } = await repository.update(id, parsed.data);
    if (error) throw new BankServiceError(error.message, 422);
    if (!data) throw new BankServiceError('Banco não encontrado', 404);
    return data as Bank;
  },

  async remove(id: number): Promise<{ bank_id: number }> {
    if (id === SENTINEL_ID) throw new BankServiceError('O banco "não informado" não pode ser excluído', 409);

    const existing = await repository.findById(id);
    if (existing.error) throw new BankServiceError(existing.error.message, 500);
    if (!existing.data) throw new BankServiceError('Banco não encontrado', 404);

    for (const table of REFERENCING_TABLES) {
      const { count, error } = await repository.countReferences(table, id);
      if (error) throw new BankServiceError(error.message, 500);
      if ((count ?? 0) > 0) {
        throw new BankServiceError('Banco em uso e não pode ser excluído', 409);
      }
    }

    const { error } = await repository.remove(id);
    if (error) throw new BankServiceError(error.message, 500);
    return { bank_id: id };
  },

  async assertCodeUnique(code: string, excludeId?: number): Promise<void> {
    const { data, error } = await repository.findByCode(code, excludeId);
    if (error) throw new BankServiceError(error.message, 500);
    if (data) throw new BankServiceError('Código já cadastrado', 409);
  },
};
