import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock do client Supabase: cada from() devolve um builder encadeável "thenable"
// que resolve para o próximo resultado da fila (na ordem das chamadas de from()).
type QueryResult = { data?: unknown; count?: number; error?: { code?: string; message: string; details?: string } | null };

const resultQueue: QueryResult[] = [];
const builders: Record<string, ReturnType<typeof vi.fn>>[] = [];

function makeBuilder(result: QueryResult) {
  const b: Record<string, ReturnType<typeof vi.fn>> & { then?: unknown } = {};
  for (const m of ['select', 'neq', 'or', 'order', 'range', 'eq', 'maybeSingle', 'single', 'insert', 'update', 'limit']) {
    b[m] = vi.fn(() => b);
  }
  b.then = (onFulfilled: (v: QueryResult) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  builders.push(b);
  return b;
}

const fromMock = vi.fn(() => makeBuilder(resultQueue.shift() ?? { data: null, error: null, count: 0 }));
vi.mock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => ({ from: fromMock }) }));

const { contaService } = await import('./contas');

beforeEach(() => {
  resultQueue.length = 0;
  builders.length = 0;
  fromMock.mockClear();
});

describe('contaService.list', () => {
  it('devolve data + total + page + limit', async () => {
    resultQueue.push({ data: [{ id: 2 }, { id: 1 }], count: 2, error: null });
    const r = await contaService.list({ page: 1, limit: 20 });
    expect(r).toEqual({ data: [{ id: 2 }, { id: 1 }], total: 2, page: 1, limit: 20 });
  });

  it('com search resolve sk_supplier e aplica or()', async () => {
    // from() #1 = contas (query base); from() #2 = supplier (supplierSkByTerm).
    resultQueue.push({ data: [{ id: 1 }], count: 1, error: null }); // contas
    resultQueue.push({ data: [{ sk_supplier: 5 }], error: null }); // supplier
    const r = await contaService.list({ search: 'acme' });
    expect(r.total).toBe(1);
    expect(builders[0].or).toHaveBeenCalled(); // builder de contas recebeu o filtro
  });

  it('limita o limit ao máximo de 100', async () => {
    resultQueue.push({ data: [], count: 0, error: null });
    const r = await contaService.list({ limit: 999 });
    expect(r.limit).toBe(100);
  });
});

describe('contaService.getById', () => {
  it('devolve a conta encontrada', async () => {
    resultQueue.push({ data: { id: 5 }, error: null });
    expect(await contaService.getById(5)).toEqual({ id: 5 });
  });

  it('404 quando não existe', async () => {
    resultQueue.push({ data: null, error: null });
    await expect(contaService.getById(9)).rejects.toMatchObject({ status: 404 });
  });
});

describe('contaService.create', () => {
  it('cria a conta (sk_supplier + amount obrigatórios)', async () => {
    resultQueue.push({ data: { id: 7, sk_supplier: 1, amount: 100 }, error: null });
    expect(await contaService.create({ sk_supplier: 1, amount: 100 })).toEqual({ id: 7, sk_supplier: 1, amount: 100 });
  });

  it('422 sem fornecedor (sk_supplier) — não toca o banco', async () => {
    await expect(contaService.create({ amount: 100 })).rejects.toMatchObject({ status: 422 });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('422 com amount <= 0', async () => {
    await expect(contaService.create({ sk_supplier: 1, amount: 0 })).rejects.toMatchObject({ status: 422 });
  });

  it('409 em violação UNIQUE (23505)', async () => {
    resultQueue.push({ data: null, error: { code: '23505', message: 'duplicate', details: 'barcode' } });
    await expect(contaService.create({ sk_supplier: 1, amount: 100 })).rejects.toMatchObject({ status: 409 });
  });
});

describe('contaService.update', () => {
  it('cancela a conta (PATCH status) → 200', async () => {
    resultQueue.push({ data: { id: 5, status: 'cancelado' }, error: null });
    expect(await contaService.update(5, { status: 'cancelado' })).toEqual({ id: 5, status: 'cancelado' });
  });

  it('404 quando não existe', async () => {
    resultQueue.push({ data: null, error: null });
    await expect(contaService.update(9, { status: 'cancelado' })).rejects.toMatchObject({ status: 404 });
  });

  it('422 com document_type fora do enum', async () => {
    await expect(contaService.update(5, { document_type: 'xxx' })).rejects.toMatchObject({ status: 422 });
    expect(fromMock).not.toHaveBeenCalled();
  });
});
