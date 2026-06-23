import { describe, it, expect, vi, beforeEach } from 'vitest';
import { supplierCreateSchema, supplierUpdateSchema } from '@sheild/shared/schemas';

// Mock do client Supabase: cada from() devolve um builder encadeável e "thenable"
// que resolve para o próximo resultado da fila (resultQueue), na ordem das chamadas.
type QueryResult = { data?: unknown; count?: number; error?: { code?: string; message: string; details?: string } | null };

const resultQueue: QueryResult[] = [];
const builders: Record<string, ReturnType<typeof vi.fn>>[] = [];

function makeBuilder(result: QueryResult) {
  const b: Record<string, ReturnType<typeof vi.fn>> & { then?: unknown } = {};
  for (const m of ['select', 'is', 'or', 'order', 'range', 'eq', 'insert', 'update', 'maybeSingle', 'single']) {
    b[m] = vi.fn(() => b);
  }
  // Torna o builder aguardável: await <chain> resolve o resultado pré-configurado.
  b.then = (onFulfilled: (v: QueryResult) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  builders.push(b);
  return b;
}

const fromMock = vi.fn(() => makeBuilder(resultQueue.shift() ?? { data: null, error: null, count: 0 }));
vi.mock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => ({ from: fromMock }) }));

const { supplierService } = await import('./suppliers');

beforeEach(() => {
  resultQueue.length = 0;
  builders.length = 0;
  fromMock.mockClear();
});

describe('supplierService.list', () => {
  it('devolve data + total + page + limit', async () => {
    resultQueue.push({ data: [{ sk_supplier: 2 }, { sk_supplier: 1 }], count: 2, error: null });
    const r = await supplierService.list({ page: 1, limit: 20 });
    expect(r).toEqual({ data: [{ sk_supplier: 2 }, { sk_supplier: 1 }], total: 2, page: 1, limit: 20 });
  });

  it('aplica filtro or() quando há search', async () => {
    resultQueue.push({ data: [], count: 0, error: null });
    await supplierService.list({ search: 'acme' });
    expect(builders[0].or).toHaveBeenCalled();
  });

  it('limita o limit ao máximo de 100', async () => {
    resultQueue.push({ data: [], count: 0, error: null });
    const r = await supplierService.list({ limit: 999 });
    expect(r.limit).toBe(100);
  });
});

describe('supplierService.getBySk', () => {
  it('devolve o fornecedor encontrado', async () => {
    resultQueue.push({ data: { sk_supplier: 5 }, error: null });
    expect(await supplierService.getBySk(5)).toEqual({ sk_supplier: 5 });
  });

  it('404 quando não existe', async () => {
    resultQueue.push({ data: null, error: null });
    await expect(supplierService.getBySk(9)).rejects.toMatchObject({ status: 404 });
  });
});

describe('supplierService.create', () => {
  it('devolve o fornecedor criado', async () => {
    resultQueue.push({ data: { sk_supplier: 7, trade_name: 'ACME' }, error: null });
    expect(await supplierService.create({ trade_name: 'ACME' })).toEqual({ sk_supplier: 7, trade_name: 'ACME' });
  });

  it('409 em CNPJ duplicado (23505)', async () => {
    resultQueue.push({
      data: null,
      error: { code: '23505', message: 'duplicate', details: 'Key (cnpj)=(12345678000199) already exists' },
    });
    await expect(supplierService.create({ cnpj: '12345678000199' })).rejects.toMatchObject({ status: 409 });
  });

  it('422 sem identificador (Zod) — não toca o banco', async () => {
    await expect(supplierService.create({})).rejects.toMatchObject({ status: 422 });
    expect(fromMock).not.toHaveBeenCalled();
  });
});

describe('supplierService.update', () => {
  it('404 quando não existe', async () => {
    resultQueue.push({ data: null, error: null });
    await expect(supplierService.update(9, { trade_name: 'X' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('supplierService.remove', () => {
  it('409 quando há contas vinculadas', async () => {
    resultQueue.push({ data: { sk_supplier: 5 }, error: null }); // findBySk
    resultQueue.push({ count: 3, error: null }); // countLinkedAccounts
    await expect(supplierService.remove(5, 'NOW')).rejects.toMatchObject({ status: 409 });
  });

  it('soft delete quando não há contas vinculadas', async () => {
    resultQueue.push({ data: { sk_supplier: 5 }, error: null }); // findBySk
    resultQueue.push({ count: 0, error: null }); // countLinkedAccounts
    resultQueue.push({ data: { sk_supplier: 5, deleted_at: 'NOW' }, error: null }); // softDelete
    expect(await supplierService.remove(5, 'NOW')).toEqual({ sk_supplier: 5 });
  });

  it('404 quando não existe', async () => {
    resultQueue.push({ data: null, error: null });
    await expect(supplierService.remove(9, 'NOW')).rejects.toMatchObject({ status: 404 });
  });
});

describe('supplierCreateSchema / supplierUpdateSchema', () => {
  it('strip de máscara no CNPJ → 14 dígitos', () => {
    const r = supplierCreateSchema.safeParse({ cnpj: '12.345.678/0001-99' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.cnpj).toBe('12345678000199');
  });

  it('CNPJ de tamanho errado após strip → falha', () => {
    expect(supplierCreateSchema.safeParse({ cnpj: '123' }).success).toBe(false);
  });

  it('sem nenhum identificador → falha', () => {
    expect(supplierCreateSchema.safeParse({}).success).toBe(false);
  });

  it('update vazio (todos opcionais) → ok', () => {
    expect(supplierUpdateSchema.safeParse({}).success).toBe(true);
  });
});
