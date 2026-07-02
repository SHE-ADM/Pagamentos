import { describe, it, expect, vi, beforeEach } from 'vitest';

type QueryResult = { data?: unknown; count?: number; error?: { code?: string; message: string } | null };

const resultQueue: QueryResult[] = [];
const builders: Record<string, ReturnType<typeof vi.fn>>[] = [];

function makeBuilder(result: QueryResult) {
  const b: Record<string, ReturnType<typeof vi.fn>> & { then?: unknown } = {};
  for (const m of ['select', 'or', 'ilike', 'order', 'range', 'eq', 'insert', 'update', 'delete', 'maybeSingle', 'single']) {
    b[m] = vi.fn(() => b);
  }
  b.then = (onF: (v: QueryResult) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(result).then(onF, onR);
  builders.push(b);
  return b;
}

const fromMock = vi.fn(() => makeBuilder(resultQueue.shift() ?? { data: null, error: null, count: 0 }));
vi.mock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => ({ from: fromMock }) }));

const { financialAccountService } = await import('./financial-accounts');

beforeEach(() => {
  resultQueue.length = 0;
  builders.length = 0;
  fromMock.mockClear();
});

describe('financialAccountService', () => {
  it('list devolve data + total', async () => {
    resultQueue.push({ data: [{ financial_account_id: 1 }], count: 1, error: null });
    const r = await financialAccountService.list({ page: 1, limit: 20 });
    expect(r).toMatchObject({ total: 1 });
    expect(r.data).toHaveLength(1);
  });

  it('busca numérica cobre TODAS as colunas do grid (descrição/moeda + banco/situação embed + saldo/tipo pgto)', async () => {
    resultQueue.push({ data: [], count: 0, error: null }); // main query
    resultQueue.push({ data: [{ bank_id: 3 }], error: null }); // financial_bank ids
    resultQueue.push({ data: [{ status_id: 30 }], error: null }); // status ids

    await financialAccountService.list({ search: '391' });

    const orArg = (builders[0].or.mock.calls[0]?.[0] ?? '') as string;
    expect(orArg).toContain('account_description.ilike.%391%');
    expect(orArg).toContain('currency_code.ilike.%391%');
    expect(orArg).toContain('bank_id.in.(3)');
    expect(orArg).toContain('status_id.in.(30)');
    expect(orArg).toContain('balance_amount.eq.391');
    expect(orArg).toContain('payment_type_id.eq.391');
  });

  it('busca textual não adiciona cláusulas numéricas (saldo/tipo pgto)', async () => {
    resultQueue.push({ data: [], count: 0, error: null }); // main query
    resultQueue.push({ data: [], error: null }); // financial_bank ids
    resultQueue.push({ data: [], error: null }); // status ids

    await financialAccountService.list({ search: 'caixa' });

    const orArg = (builders[0].or.mock.calls[0]?.[0] ?? '') as string;
    expect(orArg).toContain('account_description.ilike.%caixa%');
    expect(orArg).not.toContain('balance_amount.eq');
    expect(orArg).not.toContain('payment_type_id.eq');
  });

  it('create 422 sem campos obrigatórios (Zod) — não toca o banco', async () => {
    await expect(financialAccountService.create({})).rejects.toMatchObject({ status: 422 });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('create mapeia banco inexistente (23503) para 422', async () => {
    resultQueue.push({ data: null, error: { code: '23503', message: 'fk' } });
    await expect(
      financialAccountService.create({ account_description: 'Caixa', bank_id: 999, payment_type_id: 8, status_id: 1 }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('create devolve a conta criada', async () => {
    resultQueue.push({ data: { financial_account_id: 7, account_description: 'Caixa' }, error: null });
    const r = await financialAccountService.create({
      account_description: 'Caixa',
      bank_id: 0,
      payment_type_id: 8,
      status_id: 1,
    });
    expect(r).toMatchObject({ financial_account_id: 7 });
  });

  it('remove 404 quando não existe', async () => {
    resultQueue.push({ data: null, error: null }); // findById
    await expect(financialAccountService.remove(9)).rejects.toMatchObject({ status: 404 });
  });

  it('remove exclui (sem FK reversa)', async () => {
    resultQueue.push({ data: { financial_account_id: 5 }, error: null }); // findById
    resultQueue.push({ error: null }); // delete
    expect(await financialAccountService.remove(5)).toEqual({ financial_account_id: 5 });
  });
});
