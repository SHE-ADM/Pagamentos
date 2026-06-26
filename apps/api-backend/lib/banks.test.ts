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

const { bankService } = await import('./banks');

beforeEach(() => {
  resultQueue.length = 0;
  builders.length = 0;
  fromMock.mockClear();
});

describe('bankService.create', () => {
  it('atribui bank_id = max+1 e cria quando o código é único', async () => {
    resultQueue.push({ data: null, error: null }); // findByCode → único
    resultQueue.push({ data: { bank_id: 22 }, error: null }); // maxId
    resultQueue.push({ data: { bank_id: 23, bank_code: '999', bank_name: 'Novo' }, error: null }); // create
    const r = await bankService.create({ bank_code: '999', bank_name: 'Novo' });
    expect(r).toMatchObject({ bank_id: 23 });
    // builders[2] é o insert — confere o id calculado.
    expect(builders[2].insert).toHaveBeenCalledWith(expect.objectContaining({ bank_id: 23 }));
  });

  it('primeiro banco real recebe id 1 (sentinela 0 + 1)', async () => {
    resultQueue.push({ data: null, error: null }); // findByCode
    resultQueue.push({ data: null, error: null }); // maxId → tabela só com sentinela/vazia
    resultQueue.push({ data: { bank_id: 1 }, error: null }); // create
    await bankService.create({ bank_code: '001', bank_name: 'BB' });
    expect(builders[2].insert).toHaveBeenCalledWith(expect.objectContaining({ bank_id: 1 }));
  });

  it('409 quando o código já existe', async () => {
    resultQueue.push({ data: { bank_id: 5 }, error: null }); // findByCode → existe
    await expect(bankService.create({ bank_code: '001', bank_name: 'X' })).rejects.toMatchObject({ status: 409 });
  });

  it('422 sem código/nome (Zod) — não toca o banco', async () => {
    await expect(bankService.create({})).rejects.toMatchObject({ status: 422 });
    expect(fromMock).not.toHaveBeenCalled();
  });
});

describe('bankService.remove', () => {
  it('409 para o sentinela id 0', async () => {
    await expect(bankService.remove(0)).rejects.toMatchObject({ status: 409 });
  });

  it('409 quando há contas vinculadas', async () => {
    resultQueue.push({ data: { bank_id: 5 }, error: null }); // findById
    resultQueue.push({ count: 2, error: null }); // countReferences → em uso
    await expect(bankService.remove(5)).rejects.toMatchObject({ status: 409 });
  });

  it('exclui quando não há referências', async () => {
    resultQueue.push({ data: { bank_id: 5 }, error: null }); // findById
    resultQueue.push({ count: 0, error: null }); // countReferences
    resultQueue.push({ error: null }); // delete
    expect(await bankService.remove(5)).toEqual({ bank_id: 5 });
  });

  it('404 quando não existe', async () => {
    resultQueue.push({ data: null, error: null });
    await expect(bankService.remove(9)).rejects.toMatchObject({ status: 404 });
  });
});

describe('bankService.update', () => {
  it('404 para o sentinela id 0', async () => {
    await expect(bankService.update(0, { bank_name: 'X' })).rejects.toMatchObject({ status: 404 });
  });

  it('404 quando não existe', async () => {
    resultQueue.push({ data: null, error: null }); // findByCode (unicidade) — sem bank_code não consulta
    resultQueue.push({ data: null, error: null }); // update → 0 linhas
    await expect(bankService.update(9, { bank_name: 'X' })).rejects.toMatchObject({ status: 404 });
  });
});
