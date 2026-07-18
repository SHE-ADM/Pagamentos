import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock do client Supabase: cada from() devolve um builder encadeável "thenable" que
// resolve para o próximo resultado da fila (na ordem das chamadas de from()).
type QueryResult = { data?: unknown; error?: { message: string } | null };

const resultQueue: QueryResult[] = [];

function makeBuilder(result: QueryResult) {
  const b: Record<string, ReturnType<typeof vi.fn>> & { then?: unknown } = {};
  for (const m of ['select', 'eq', 'maybeSingle']) b[m] = vi.fn(() => b);
  b.then = (onFulfilled: (v: QueryResult) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return b;
}

const fromMock = vi.fn(() => makeBuilder(resultQueue.shift() ?? { data: null, error: null }));
vi.mock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => ({ from: fromMock }) }));

const { checkClassificationPair } = await import('./classification');

beforeEach(() => {
  resultQueue.length = 0;
  fromMock.mockClear();
});

describe('checkClassificationPair', () => {
  it('ambos 0 (não informado) → null, sem tocar o banco', async () => {
    expect(await checkClassificationPair(0, 0)).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('só o centro informado → erro de par incompleto, sem tocar o banco', async () => {
    expect(await checkClassificationPair(5, 0)).toMatch(/juntos/i);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('só o plano informado → erro de par incompleto, sem tocar o banco', async () => {
    expect(await checkClassificationPair(0, 10)).toMatch(/juntos/i);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('plano inexistente → "não existe"', async () => {
    resultQueue.push({ data: null, error: null }); // chart não encontrado
    expect(await checkClassificationPair(5, 10)).toMatch(/plano de contas informado não existe/i);
  });

  it('centro não pertence ao plano (cost_center_id diverge) → erro de relacionamento', async () => {
    resultQueue.push({ data: { cost_center_id: 7 }, error: null });
    expect(await checkClassificationPair(5, 10)).toMatch(/não pertence ao plano/i);
  });

  it('par consistente mas centro inexistente → "Centro de custo informado não existe"', async () => {
    resultQueue.push({ data: { cost_center_id: 5 }, error: null }); // chart ok
    resultQueue.push({ data: null, error: null }); // centro não encontrado
    expect(await checkClassificationPair(5, 10)).toMatch(/centro de custo informado não existe/i);
  });

  it('par consistente e ambos existem → null (não valida lançabilidade)', async () => {
    resultQueue.push({ data: { cost_center_id: 5 }, error: null }); // chart
    resultQueue.push({ data: { cost_center_id: 5 }, error: null }); // centro
    expect(await checkClassificationPair(5, 10)).toBeNull();
  });

  it('erro de INFRAESTRUTURA na consulta do plano → lança (vira 500 no chamador)', async () => {
    resultQueue.push({ data: null, error: { message: 'db down' } });
    await expect(checkClassificationPair(5, 10)).rejects.toThrow();
  });
});
