import { describe, it, expect, vi, beforeEach } from 'vitest';

type QueryResult = { data?: unknown; count?: number; error?: { code?: string; message: string } | null };

const resultQueue: QueryResult[] = [];
const builders: Record<string, ReturnType<typeof vi.fn>>[] = [];

function makeBuilder(result: QueryResult) {
  const b: Record<string, ReturnType<typeof vi.fn>> & { then?: unknown } = {};
  for (const m of ['select', 'neq', 'or', 'order', 'range', 'eq', 'ilike', 'limit', 'insert', 'update', 'delete', 'maybeSingle', 'single']) {
    b[m] = vi.fn(() => b);
  }
  b.then = (onF: (v: QueryResult) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(result).then(onF, onR);
  builders.push(b);
  return b;
}

const fromMock = vi.fn(() => makeBuilder(resultQueue.shift() ?? { data: null, error: null, count: 0 }));
vi.mock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => ({ from: fromMock }) }));

const { chartAccountGroupService } = await import('./chart-account-groups');

beforeEach(() => {
  resultQueue.length = 0;
  builders.length = 0;
  fromMock.mockClear();
});

describe('chartAccountGroupService', () => {
  it('list devolve data + total + page + limit', async () => {
    resultQueue.push({ data: [{ chart_account_group_id: 1 }], count: 1, error: null });
    const r = await chartAccountGroupService.list({ page: 1, limit: 20 });
    expect(r).toEqual({ data: [{ chart_account_group_id: 1 }], total: 1, page: 1, limit: 20 });
  });

  it('create 409 quando o código já existe', async () => {
    resultQueue.push({ data: { chart_account_group_id: 1 }, error: null }); // findByCode
    await expect(
      chartAccountGroupService.create({ group_code: '1', group_description: 'Ativo' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('create ok quando único', async () => {
    resultQueue.push({ data: null, error: null }); // findByCode
    resultQueue.push({ data: { chart_account_group_id: 9, group_code: '9' }, error: null }); // create
    expect(await chartAccountGroupService.create({ group_code: '9', group_description: 'X' })).toMatchObject({
      chart_account_group_id: 9,
    });
  });

  it('remove 409 para o sentinela id 0', async () => {
    await expect(chartAccountGroupService.remove(0)).rejects.toMatchObject({ status: 409 });
  });

  it('remove 409 quando há subgrupos vinculados', async () => {
    resultQueue.push({ data: { chart_account_group_id: 5 }, error: null }); // findById
    resultQueue.push({ count: 4, error: null }); // countReferences
    await expect(chartAccountGroupService.remove(5)).rejects.toMatchObject({ status: 409 });
  });

  it('remove exclui quando não há referências', async () => {
    resultQueue.push({ data: { chart_account_group_id: 5 }, error: null }); // findById
    resultQueue.push({ count: 0, error: null }); // countReferences
    resultQueue.push({ error: null }); // delete
    expect(await chartAccountGroupService.remove(5)).toEqual({ chart_account_group_id: 5 });
  });

  it('update 404 para o sentinela id 0', async () => {
    await expect(chartAccountGroupService.update(0, { group_code: 'X' })).rejects.toMatchObject({ status: 404 });
  });

  it('busca cobre TODAS as colunas do grid (código, descrição, tipo)', async () => {
    resultQueue.push({ data: [], count: 0, error: null }); // main query
    await chartAccountGroupService.list({ search: 'ativo' });
    const orArg = (builders[0].or.mock.calls[0]?.[0] ?? '') as string;
    expect(orArg).toContain('group_code.ilike.%ativo%');
    expect(orArg).toContain('group_description.ilike.%ativo%');
    expect(orArg).toContain('group_type.ilike.%ativo%');
  });
});
