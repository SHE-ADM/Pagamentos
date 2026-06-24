import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock do client Supabase: cada from() devolve um builder encadeável e "thenable"
// (espelha lib/suppliers.test.ts). `eq` é registrado para assertar o filtro de cascata.
type QueryResult = { data?: unknown; error?: { message: string } | null };

const resultQueue: QueryResult[] = [];
const builders: Record<string, ReturnType<typeof vi.fn>>[] = [];

function makeBuilder(result: QueryResult) {
  const b: Record<string, ReturnType<typeof vi.fn>> & { then?: unknown } = {};
  for (const m of ['select', 'is', 'not', 'or', 'order', 'limit', 'eq']) {
    b[m] = vi.fn(() => b);
  }
  b.then = (onFulfilled: (v: QueryResult) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  builders.push(b);
  return b;
}

const fromMock = vi.fn(() => makeBuilder(resultQueue.shift() ?? { data: [], error: null }));
vi.mock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => ({ from: fromMock }) }));

const { chartAccountService, costCenterService } = await import('./lookups');

beforeEach(() => {
  resultQueue.length = 0;
  builders.length = 0;
  fromMock.mockClear();
});

describe('chartAccountService.list (cascata por centro de custo)', () => {
  it('sem costCenterId devolve [] SEM consultar o banco', async () => {
    const r = await chartAccountService.list({});
    expect(r).toEqual([]);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('costCenterId=0 (sentinela) também devolve [] sem consultar', async () => {
    const r = await chartAccountService.list({ costCenterId: 0 });
    expect(r).toEqual([]);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('com costCenterId filtra por cost_center_id e devolve os planos', async () => {
    resultQueue.push({ data: [{ chart_account_id: 1, account_code: '1.1', account_description: 'Aluguel' }], error: null });
    const r = await chartAccountService.list({ costCenterId: 3 });
    expect(fromMock).toHaveBeenCalledTimes(1);
    expect(builders[0].eq).toHaveBeenCalledWith('cost_center_id', 3);
    expect(r).toEqual([{ chart_account_id: 1, account_code: '1.1', account_description: 'Aluguel' }]);
  });

  it('aplica filtro or() quando há search (com centro)', async () => {
    resultQueue.push({ data: [], error: null });
    await chartAccountService.list({ costCenterId: 3, search: 'alug' });
    expect(builders[0].or).toHaveBeenCalled();
  });
});

describe('costCenterService.list', () => {
  it('lista centros de custo (não depende de centro)', async () => {
    resultQueue.push({ data: [{ cost_center_id: 1, cost_center_code: 'ADM', cost_center_description: 'Administrativo' }], error: null });
    const r = await costCenterService.list({});
    expect(fromMock).toHaveBeenCalledTimes(1);
    expect(r).toHaveLength(1);
  });
});
