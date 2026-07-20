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

  it('create mapeia FK inexistente (23503) para 422 — grupo ou Tipo', async () => {
    resultQueue.push({ data: null, error: null }); // findByCode → único
    resultQueue.push({ data: null, error: { code: '23503', message: 'fk' } }); // create → FK inválida
    await expect(
      chartAccountSubgroupService.create({ subgroup_code: '1.1', subgroup_description: 'X', chart_account_group_id: 999 }),
    ).rejects.toMatchObject({ status: 422, message: 'Grupo ou Tipo informado não existe' });
  });

  it('create 409 quando o código já existe', async () => {
    resultQueue.push({ data: { chart_account_subgroup_id: 1 }, error: null }); // findByCode
    await expect(
      chartAccountSubgroupService.create({ subgroup_code: '1.1', subgroup_description: 'X', chart_account_group_id: 1 }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('create 500 (genérico, sem vazar detalhe) em erro inesperado do banco', async () => {
    resultQueue.push({ data: null, error: null }); // findByCode → único
    resultQueue.push({ data: null, error: { code: '08006', message: 'connection failure' } }); // create
    await expect(
      chartAccountSubgroupService.create({ subgroup_code: '1.1', subgroup_description: 'X', chart_account_group_id: 1 }),
    ).rejects.toMatchObject({ status: 500 });
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

  it('busca cobre TODAS as colunas do grid (código, descrição, grupo e Tipo embeds)', async () => {
    resultQueue.push({ data: [], count: 0, error: null }); // main query
    resultQueue.push({ data: [{ chart_account_group_id: 4 }], error: null }); // grupo ids (embed)
    resultQueue.push({ data: [{ type_group_id: 5 }], error: null }); // tipo ids (embed)
    await chartAccountSubgroupService.list({ search: 'circulante' });
    const orArg = (builders[0].or.mock.calls[0]?.[0] ?? '') as string;
    expect(orArg).toContain('subgroup_code.ilike.%circulante%');
    expect(orArg).toContain('subgroup_description.ilike.%circulante%');
    expect(orArg).toContain('chart_account_group_id.in.(4)');
    expect(orArg).toContain('type_group_id.in.(5)');
  });

  it('create envia type_group_id quando informado (valida o escopo antes do insert)', async () => {
    resultQueue.push({ data: null, error: null }); // findByCode → único
    resultQueue.push({ data: { applies_to: 'subgroup' }, error: null }); // validateTypeGroupScope → ok
    resultQueue.push({
      data: { chart_account_subgroup_id: 9, subgroup_code: '9.1', type_group_id: 5 },
      error: null,
    }); // create
    const r = await chartAccountSubgroupService.create({
      subgroup_code: '9.1',
      subgroup_description: 'X',
      chart_account_group_id: 1,
      type_group_id: 5,
    });
    expect(r).toMatchObject({ chart_account_subgroup_id: 9, type_group_id: 5 });
  });

  it('create 422 quando o Tipo é de escopo group (Natureza de grupo)', async () => {
    resultQueue.push({ data: null, error: null }); // findByCode → único
    resultQueue.push({ data: { applies_to: 'group' }, error: null }); // validateTypeGroupScope → escopo errado
    await expect(
      chartAccountSubgroupService.create({
        subgroup_code: '9.1',
        subgroup_description: 'X',
        chart_account_group_id: 1,
        type_group_id: 2,
      }),
    ).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/Tipo inválido para subgrupo/) });
  });
});
