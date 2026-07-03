import { describe, it, expect, vi, beforeEach } from 'vitest';

type QueryResult = { data?: unknown; count?: number; error?: { code?: string; message: string } | null };

const resultQueue: QueryResult[] = [];
const builders: Record<string, ReturnType<typeof vi.fn>>[] = [];

function makeBuilder(result: QueryResult) {
  const b: Record<string, ReturnType<typeof vi.fn>> & { then?: unknown } = {};
  for (const m of ['select', 'neq', 'or', 'order', 'range', 'eq', 'is', 'ilike', 'limit', 'insert', 'update', 'delete', 'maybeSingle', 'single']) {
    b[m] = vi.fn(() => b);
  }
  b.then = (onF: (v: QueryResult) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(result).then(onF, onR);
  builders.push(b);
  return b;
}

const fromMock = vi.fn(() => makeBuilder(resultQueue.shift() ?? { data: null, error: null, count: 0 }));
vi.mock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => ({ from: fromMock }) }));

const { chartAccountService } = await import('./chart-accounts');

beforeEach(() => {
  resultQueue.length = 0;
  builders.length = 0;
  fromMock.mockClear();
});

describe('chartAccountService', () => {
  it('create ok quando único', async () => {
    resultQueue.push({ data: null, error: null }); // findByCode
    resultQueue.push({ data: { chart_account_id: 9, account_code: '1.1.01' }, error: null }); // create
    expect(await chartAccountService.create({ account_code: '1.1.01', account_description: 'X' })).toMatchObject({
      chart_account_id: 9,
    });
  });

  it('create 409 quando o código já existe', async () => {
    resultQueue.push({ data: { chart_account_id: 1 }, error: null }); // findByCode
    await expect(
      chartAccountService.create({ account_code: '1.1.01', account_description: 'X' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('create mapeia FK inexistente (23503) para 422', async () => {
    resultQueue.push({ data: null, error: null }); // findByCode
    resultQueue.push({ data: null, error: { code: '23503', message: 'fk' } }); // create
    await expect(
      chartAccountService.create({ account_code: '9', account_description: 'X', cost_center_id: 999 }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('remove 409 quando referenciado por contas/fornecedores', async () => {
    resultQueue.push({ data: { chart_account_id: 5 }, error: null }); // findById
    resultQueue.push({ count: 1, error: null }); // countReferences (financial_account_control)
    await expect(chartAccountService.remove(5)).rejects.toMatchObject({ status: 409 });
  });

  it('remove exclui quando livre em todas as tabelas', async () => {
    resultQueue.push({ data: { chart_account_id: 5 }, error: null }); // findById
    resultQueue.push({ count: 0, error: null }); // financial_account_control
    resultQueue.push({ count: 0, error: null }); // supplier
    resultQueue.push({ error: null }); // delete
    expect(await chartAccountService.remove(5)).toEqual({ chart_account_id: 5 });
  });

  it('remove 409 para o sentinela id 0', async () => {
    await expect(chartAccountService.remove(0)).rejects.toMatchObject({ status: 409 });
  });

  it('busca cobre TODAS as colunas do grid (código, descrição + embeds de classificação)', async () => {
    resultQueue.push({ data: [], count: 0, error: null }); // main query
    resultQueue.push({ data: [{ cost_center_id: 3 }], error: null }); // financial_cost_center
    resultQueue.push({ data: [], error: null }); // financial_chart_of_account_group
    resultQueue.push({ data: [{ chart_account_subgroup_id: 7 }], error: null }); // subgroup

    await chartAccountService.list({ search: 'admin' });

    const mainBuilder = builders[0];
    const orArg = (mainBuilder.or.mock.calls[0]?.[0] ?? '') as string;
    expect(orArg).toContain('account_code.ilike.%admin%');
    expect(orArg).toContain('account_description.ilike.%admin%');
    expect(orArg).toContain('cost_center_id.in.(3)');
    expect(orArg).toContain('chart_account_subgroup_id.in.(7)');
    // grupo sem match não gera cláusula
    expect(orArg).not.toContain('chart_account_group_id.in.');
  });

  it('list aplica os filtros do grid complementar (costCenterId + postableOnly)', async () => {
    resultQueue.push({ data: [], count: 0, error: null }); // main query

    await chartAccountService.list({ page: 1, limit: 20, costCenterId: 42, postableOnly: true });

    const mainBuilder = builders[0];
    expect(mainBuilder.eq).toHaveBeenCalledWith('cost_center_id', 42);
    expect(mainBuilder.is).toHaveBeenCalledWith('is_postable', true);
  });

  it('list sem os filtros não restringe por centro nem por postável', async () => {
    resultQueue.push({ data: [], count: 0, error: null }); // main query

    await chartAccountService.list({ page: 1, limit: 20 });

    const mainBuilder = builders[0];
    expect(mainBuilder.eq).not.toHaveBeenCalledWith('cost_center_id', expect.anything());
    expect(mainBuilder.is).not.toHaveBeenCalled();
  });
});
