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

const { chartAccountSubgroupService } = await import('./chart-account-subgroups');

beforeEach(() => {
  resultQueue.length = 0;
  builders.length = 0;
  fromMock.mockClear();
});

describe('chartAccountSubgroupService', () => {
  it('create 422 sem grupo (Zod) — não toca o banco', async () => {
    await expect(
      chartAccountSubgroupService.create({ subgroup_code: '1.1', subgroup_description: 'X' }),
    ).rejects.toMatchObject({ status: 422 });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('create mapeia FK inexistente (23503) para 422', async () => {
    resultQueue.push({ data: null, error: null }); // findByCode → único
    resultQueue.push({ data: null, error: { code: '23503', message: 'fk' } }); // create → FK inválida
    await expect(
      chartAccountSubgroupService.create({ subgroup_code: '1.1', subgroup_description: 'X', chart_account_group_id: 999 }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('create 409 quando o código já existe', async () => {
    resultQueue.push({ data: { chart_account_subgroup_id: 1 }, error: null }); // findByCode
    await expect(
      chartAccountSubgroupService.create({ subgroup_code: '1.1', subgroup_description: 'X', chart_account_group_id: 1 }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('remove 409 quando há planos vinculados', async () => {
    resultQueue.push({ data: { chart_account_subgroup_id: 5 }, error: null }); // findById
    resultQueue.push({ count: 7, error: null }); // countReferences
    await expect(chartAccountSubgroupService.remove(5)).rejects.toMatchObject({ status: 409 });
  });

  it('remove exclui quando não há referências', async () => {
    resultQueue.push({ data: { chart_account_subgroup_id: 5 }, error: null }); // findById
    resultQueue.push({ count: 0, error: null }); // countReferences
    resultQueue.push({ error: null }); // delete
    expect(await chartAccountSubgroupService.remove(5)).toEqual({ chart_account_subgroup_id: 5 });
  });
});
