import { describe, it, expect, vi, beforeEach } from 'vitest';
import { costCenterCreateSchema, costCenterUpdateSchema } from '@sheild/shared/schemas';

// Mock do client Supabase: cada from() devolve um builder encadeável e "thenable"
// que resolve para o próximo resultado da fila (resultQueue), na ordem das chamadas.
type QueryResult = { data?: unknown; count?: number; error?: { code?: string; message: string } | null };

const resultQueue: QueryResult[] = [];
const builders: Record<string, ReturnType<typeof vi.fn>>[] = [];

function makeBuilder(result: QueryResult) {
  const b: Record<string, ReturnType<typeof vi.fn>> & { then?: unknown } = {};
  for (const m of ['select', 'is', 'or', 'order', 'range', 'eq', 'neq', 'ilike', 'limit', 'insert', 'update', 'delete', 'maybeSingle', 'single']) {
    b[m] = vi.fn(() => b);
  }
  b.then = (onFulfilled: (v: QueryResult) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  builders.push(b);
  return b;
}

const fromMock = vi.fn(() => makeBuilder(resultQueue.shift() ?? { data: null, error: null, count: 0 }));
vi.mock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => ({ from: fromMock }) }));

const { costCenterService } = await import('./cost-centers');

beforeEach(() => {
  resultQueue.length = 0;
  builders.length = 0;
  fromMock.mockClear();
});

describe('costCenterService.list', () => {
  it('devolve data + total + page + limit', async () => {
    resultQueue.push({ data: [{ cost_center_id: 1, cost_center_code: 'ADM' }], count: 1, error: null });
    const r = await costCenterService.list({ page: 1, limit: 20 });
    expect(r).toEqual({ data: [{ cost_center_id: 1, cost_center_code: 'ADM' }], total: 1, page: 1, limit: 20 });
  });

  it('aplica filtro or() quando há search', async () => {
    resultQueue.push({ data: [], count: 0, error: null });
    await costCenterService.list({ search: 'adm' });
    expect(builders[0].or).toHaveBeenCalled();
  });

  it('limita o limit ao máximo de 100', async () => {
    resultQueue.push({ data: [], count: 0, error: null });
    const r = await costCenterService.list({ limit: 999 });
    expect(r.limit).toBe(100);
  });
});

describe('costCenterService.getById', () => {
  it('404 para o sentinela id 0 (sem tocar o banco)', async () => {
    await expect(costCenterService.getById(0)).rejects.toMatchObject({ status: 404 });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('devolve o centro encontrado', async () => {
    resultQueue.push({ data: { cost_center_id: 5, cost_center_code: 'TI' }, error: null });
    expect(await costCenterService.getById(5)).toEqual({ cost_center_id: 5, cost_center_code: 'TI' });
  });

  it('404 quando não existe', async () => {
    resultQueue.push({ data: null, error: null });
    await expect(costCenterService.getById(9)).rejects.toMatchObject({ status: 404 });
  });
});

describe('costCenterService.create', () => {
  it('cria quando o código é único', async () => {
    resultQueue.push({ data: null, error: null }); // findByCode → não há duplicado
    resultQueue.push({ data: { cost_center_id: 7, cost_center_code: 'NEW', cost_center_description: 'Novo' }, error: null });
    const r = await costCenterService.create({ cost_center_code: 'NEW', cost_center_description: 'Novo' });
    expect(r).toMatchObject({ cost_center_id: 7 });
  });

  it('409 quando o código já existe', async () => {
    resultQueue.push({ data: { cost_center_id: 1 }, error: null }); // findByCode → existe
    await expect(
      costCenterService.create({ cost_center_code: 'ADM', cost_center_description: 'Administrativo' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('422 sem código/descrição (Zod) — não toca o banco', async () => {
    await expect(costCenterService.create({})).rejects.toMatchObject({ status: 422 });
    expect(fromMock).not.toHaveBeenCalled();
  });
});

describe('costCenterService.update', () => {
  it('404 para o sentinela id 0', async () => {
    await expect(costCenterService.update(0, { cost_center_code: 'X' })).rejects.toMatchObject({ status: 404 });
  });

  it('404 quando não existe', async () => {
    resultQueue.push({ data: null, error: null }); // findByCode (unicidade) → ok
    resultQueue.push({ data: null, error: null }); // update → 0 linhas
    await expect(costCenterService.update(9, { cost_center_code: 'X' })).rejects.toMatchObject({ status: 404 });
  });

  it('409 quando o novo código colide com outro', async () => {
    resultQueue.push({ data: { cost_center_id: 2 }, error: null }); // findByCode → outro id
    await expect(costCenterService.update(5, { cost_center_code: 'ADM' })).rejects.toMatchObject({ status: 409 });
  });
});

describe('costCenterService.remove', () => {
  it('409 para o sentinela id 0', async () => {
    await expect(costCenterService.remove(0)).rejects.toMatchObject({ status: 409 });
  });

  it('404 quando não existe', async () => {
    resultQueue.push({ data: null, error: null }); // findById
    await expect(costCenterService.remove(9)).rejects.toMatchObject({ status: 404 });
  });

  it('409 quando há referências (contas)', async () => {
    resultQueue.push({ data: { cost_center_id: 5 }, error: null }); // findById
    resultQueue.push({ count: 3, error: null }); // countReferences (1ª tabela) → em uso
    await expect(costCenterService.remove(5)).rejects.toMatchObject({ status: 409 });
  });

  it('exclui quando não há referências em nenhuma tabela', async () => {
    resultQueue.push({ data: { cost_center_id: 5 }, error: null }); // findById
    resultQueue.push({ count: 0, error: null }); // financial_account_control
    resultQueue.push({ count: 0, error: null }); // financial_chart_of_account
    resultQueue.push({ count: 0, error: null }); // supplier
    resultQueue.push({ error: null }); // delete
    expect(await costCenterService.remove(5)).toEqual({ cost_center_id: 5 });
  });
});

describe('costCenterCreateSchema / costCenterUpdateSchema', () => {
  it('exige código e descrição na criação', () => {
    expect(costCenterCreateSchema.safeParse({}).success).toBe(false);
    expect(costCenterCreateSchema.safeParse({ cost_center_code: 'A', cost_center_description: 'B' }).success).toBe(true);
  });

  it('faz trim dos campos', () => {
    const r = costCenterCreateSchema.safeParse({ cost_center_code: '  TI ', cost_center_description: ' Tecnologia ' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ cost_center_code: 'TI', cost_center_description: 'Tecnologia' });
  });

  it('update rejeita corpo vazio (ao menos um campo)', () => {
    expect(costCenterUpdateSchema.safeParse({}).success).toBe(false);
    expect(costCenterUpdateSchema.safeParse({ cost_center_description: 'Nova' }).success).toBe(true);
  });
});
