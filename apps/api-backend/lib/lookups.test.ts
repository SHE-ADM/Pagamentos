import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock do client Supabase: cada from() devolve um builder encadeável e "thenable"
// (espelha lib/suppliers.test.ts). `eq` é registrado para assertar o filtro.
type QueryResult = { data?: unknown; error?: { message: string } | null };

const resultQueue: QueryResult[] = [];
const builders: Record<string, ReturnType<typeof vi.fn>>[] = [];

function makeBuilder(result: QueryResult) {
  const b: Record<string, ReturnType<typeof vi.fn>> & { then?: unknown } = {};
  for (const m of ['select', 'is', 'not', 'or', 'order', 'limit', 'eq', 'gt', 'in', 'maybeSingle']) {
    b[m] = vi.fn(() => b);
  }
  b.then = (onFulfilled: (v: QueryResult) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  builders.push(b);
  return b;
}

const fromMock = vi.fn(() => makeBuilder(resultQueue.shift() ?? { data: [], error: null }));
vi.mock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => ({ from: fromMock }) }));

const { chartAccountService, costCenterService, financialTypeGroupService, validateTypeGroupScope } =
  await import('./lookups');

beforeEach(() => {
  resultQueue.length = 0;
  builders.length = 0;
  fromMock.mockClear();
});

describe('chartAccountService.listPlanoDescriptions (1º select — descrições distintas)', () => {
  it('deduplica descrições e só traz planos postáveis com centro (gt cost_center_id 0)', async () => {
    resultQueue.push({
      data: [
        { account_description: 'Serviços Gerais' },
        { account_description: 'Serviços Gerais' }, // repetida (outro centro)
        { account_description: 'Aluguel' },
      ],
      error: null,
    });
    const r = await chartAccountService.listPlanoDescriptions({});
    expect(fromMock).toHaveBeenCalledTimes(1);
    expect(builders[0].is).toHaveBeenCalledWith('is_postable', true);
    expect(builders[0].gt).toHaveBeenCalledWith('cost_center_id', 0);
    expect(r).toEqual([{ account_description: 'Serviços Gerais' }, { account_description: 'Aluguel' }]);
  });

  it('aplica filtro or() quando há search', async () => {
    resultQueue.push({ data: [], error: null });
    await chartAccountService.listPlanoDescriptions({ search: 'serv' });
    expect(builders[0].or).toHaveBeenCalled();
  });
});

describe('chartAccountService.listCentersForPlano (2º select — centros do plano)', () => {
  it('sem descrição devolve [] SEM consultar o banco', async () => {
    const r = await chartAccountService.listCentersForPlano({});
    expect(r).toEqual([]);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('com descrição filtra por account_description e achata o embed do centro', async () => {
    resultQueue.push({
      data: [
        {
          chart_account_id: 10,
          account_code: '18.1.02',
          cost_center_id: 12,
          cost_center: { cost_center_code: 'CC12', cost_center_description: 'Comercial' },
        },
      ],
      error: null,
    });
    const r = await chartAccountService.listCentersForPlano({ description: 'Hospedagens' });
    expect(fromMock).toHaveBeenCalledTimes(1);
    expect(builders[0].eq).toHaveBeenCalledWith('account_description', 'Hospedagens');
    expect(builders[0].gt).toHaveBeenCalledWith('cost_center_id', 0);
    expect(r).toEqual([
      { chart_account_id: 10, account_code: '18.1.02', cost_center_id: 12, cost_center_description: 'Comercial' },
    ]);
  });
});

describe('costCenterService.list', () => {
  it('lista centros de custo', async () => {
    resultQueue.push({ data: [{ cost_center_id: 1, cost_center_code: 'ADM', cost_center_description: 'Administrativo' }], error: null });
    const r = await costCenterService.list({});
    expect(fromMock).toHaveBeenCalledTimes(1);
    expect(r).toHaveLength(1);
  });
});

describe('financialTypeGroupService.list (lookup de Natureza)', () => {
  it('lista o catálogo ordenado por id, incluindo o sentinela 0', async () => {
    resultQueue.push({
      data: [
        { type_group_id: 0, type_group_description: 'Não informado' },
        { type_group_id: 1, type_group_description: 'Receitas' },
        { type_group_id: 2, type_group_description: 'Despesas' },
      ],
      error: null,
    });
    const r = await financialTypeGroupService.list();
    expect(fromMock).toHaveBeenCalledTimes(1);
    expect(builders[0].select).toHaveBeenCalledWith('type_group_id,type_group_description');
    expect(builders[0].order).toHaveBeenCalledWith('type_group_id', { ascending: true });
    expect(r).toHaveLength(3);
    expect(r[0]).toEqual({ type_group_id: 0, type_group_description: 'Não informado' });
  });

  it('propaga erro do banco como LookupServiceError 500', async () => {
    resultQueue.push({ data: null, error: { message: 'db down' } });
    await expect(financialTypeGroupService.list()).rejects.toMatchObject({ status: 500 });
  });

  it('sem escopo NÃO filtra applies_to (retrocompat)', async () => {
    resultQueue.push({ data: [], error: null });
    await financialTypeGroupService.list();
    expect(builders[0].in).not.toHaveBeenCalled();
  });

  it('com escopo filtra applies_to por [both, scope]', async () => {
    resultQueue.push({ data: [], error: null });
    await financialTypeGroupService.list({ scope: 'subgroup' });
    expect(builders[0].in).toHaveBeenCalledWith('applies_to', ['both', 'subgroup']);
  });
});

describe('validateTypeGroupScope (Finding 2 — impede atribuição cross-taxonomia)', () => {
  it('id 0 ("Não informado") é válido SEM consultar o banco', async () => {
    expect(await validateTypeGroupScope(0, 'group')).toBeNull();
    expect(await validateTypeGroupScope(0, 'subgroup')).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('escopo compatível (subgroup ← subgroup) devolve null', async () => {
    resultQueue.push({ data: { applies_to: 'subgroup' }, error: null });
    expect(await validateTypeGroupScope(5, 'subgroup')).toBeNull();
  });

  it("escopo 'both' é válido em qualquer cadastro", async () => {
    resultQueue.push({ data: { applies_to: 'both' }, error: null });
    expect(await validateTypeGroupScope(9, 'group')).toBeNull();
  });

  it('Natureza de subgrupo (5) num GRUPO devolve mensagem', async () => {
    resultQueue.push({ data: { applies_to: 'subgroup' }, error: null });
    expect(await validateTypeGroupScope(5, 'group')).toMatch(/Natureza inválida para grupo/);
  });

  it('Tipo de grupo (2) num SUBGRUPO devolve mensagem', async () => {
    resultQueue.push({ data: { applies_to: 'group' }, error: null });
    expect(await validateTypeGroupScope(2, 'subgroup')).toMatch(/Tipo inválido para subgrupo/);
  });

  it('id inexistente devolve mensagem de "não existe" por escopo', async () => {
    resultQueue.push({ data: null, error: null });
    expect(await validateTypeGroupScope(999, 'subgroup')).toBe('Tipo informado não existe');
  });

  it('erro do banco propaga como 500', async () => {
    resultQueue.push({ data: null, error: { message: 'db down' } });
    await expect(validateTypeGroupScope(5, 'group')).rejects.toMatchObject({ status: 500 });
  });
});
