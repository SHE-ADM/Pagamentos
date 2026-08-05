import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Mocks dos 3 lookups. Ficam em escopo de módulo porque o cache do hook é de MÓDULO:
// cada caso reimporta o hook com vi.resetModules() para começar com o cache frio.
const listCostCenters = vi.fn();
const listChartAccountGroups = vi.fn();
const listChartAccountSubgroups = vi.fn();

vi.mock('../services/lookups', () => ({
  listCostCenters: (...a: unknown[]) => listCostCenters(...a),
  listChartAccountGroups: (...a: unknown[]) => listChartAccountGroups(...a),
  listChartAccountSubgroups: (...a: unknown[]) => listChartAccountSubgroups(...a),
}));

// Reimporta o módulo com o cache zerado. Sem isso, o primeiro caso que resolvesse
// contaminaria todos os seguintes (o cache é justamente o comportamento sob teste).
async function freshHook() {
  vi.resetModules();
  const mod = await import('./useClassificationFilterOptions');
  return mod.useClassificationFilterOptions;
}

beforeEach(() => {
  listCostCenters.mockReset();
  listChartAccountGroups.mockReset();
  listChartAccountSubgroups.mockReset();
  listCostCenters.mockResolvedValue([
    { cost_center_id: 4, cost_center_code: '004', cost_center_description: 'Logística' },
  ]);
  listChartAccountGroups.mockResolvedValue([
    { chart_account_group_id: 24, group_code: '24', group_description: 'Despesas Fixas' },
  ]);
  listChartAccountSubgroups.mockResolvedValue([
    { chart_account_subgroup_id: 93, subgroup_code: '93', subgroup_description: 'Copa e Cozinha' },
  ]);
});

describe('useClassificationFilterOptions', () => {
  it('mapeia as 3 listas para { value, label } com "código — descrição"', async () => {
    const useHook = await freshHook();
    const { result } = renderHook(() => useHook());

    await waitFor(() => expect(result.current.costCenters).toHaveLength(1));
    expect(result.current.costCenters[0]).toEqual({ value: 4, label: '004 — Logística' });
    expect(result.current.groups[0]).toEqual({ value: 24, label: '24 — Despesas Fixas' });
    expect(result.current.subgroups[0]).toEqual({ value: 93, label: '93 — Copa e Cozinha' });
  });

  it('começa vazio (não bloqueia o primeiro render da página)', async () => {
    const useHook = await freshHook();
    const { result } = renderHook(() => useHook());
    expect(result.current).toEqual({ costCenters: [], groups: [], subgroups: [] });
  });

  // allSettled (e não all): uma lista que falha não pode zerar as outras duas — senão o
  // usuário perderia 3 filtros porque 1 endpoint piscou.
  it('falha de UMA lista não derruba as outras duas', async () => {
    listChartAccountGroups.mockRejectedValue(new Error('502'));
    const useHook = await freshHook();
    const { result } = renderHook(() => useHook());

    await waitFor(() => expect(result.current.costCenters).toHaveLength(1));
    expect(result.current.groups).toEqual([]); // silencioso: select fica só com o placeholder
    expect(result.current.subgroups).toHaveLength(1);
  });

  it('cacheia entre montagens: a 2ª visita à página não vai à rede', async () => {
    const useHook = await freshHook();
    const { result, unmount } = renderHook(() => useHook());
    await waitFor(() => expect(result.current.groups).toHaveLength(1));
    unmount();

    const { result: r2 } = renderHook(() => useHook());
    // Cache quente: já vem preenchido no PRIMEIRO render, sem piscar vazio.
    expect(r2.current.groups).toHaveLength(1);
    expect(listCostCenters).toHaveBeenCalledTimes(1);
    expect(listChartAccountGroups).toHaveBeenCalledTimes(1);
    expect(listChartAccountSubgroups).toHaveBeenCalledTimes(1);
  });

  // Resultado PARCIAL não é memoizado — senão uma indisponibilidade momentânea deixaria
  // o filtro morto até o reload da aba.
  it('NÃO cacheia resultado parcial: a montagem seguinte tenta de novo', async () => {
    listChartAccountGroups.mockRejectedValueOnce(new Error('502'));
    const useHook = await freshHook();
    const { result, unmount } = renderHook(() => useHook());
    await waitFor(() => expect(result.current.costCenters).toHaveLength(1));
    expect(result.current.groups).toEqual([]);
    unmount();

    const { result: r2 } = renderHook(() => useHook());
    await waitFor(() => expect(r2.current.groups).toHaveLength(1)); // recuperou
    expect(listChartAccountGroups).toHaveBeenCalledTimes(2);
  });

  it('rotula com a descrição quando não há código, e com #id quando não há nenhum', async () => {
    listCostCenters.mockResolvedValue([
      { cost_center_id: 7, cost_center_code: null, cost_center_description: 'Sem código' },
      { cost_center_id: 8, cost_center_code: null, cost_center_description: null },
    ]);
    const useHook = await freshHook();
    const { result } = renderHook(() => useHook());

    await waitFor(() => expect(result.current.costCenters).toHaveLength(2));
    expect(result.current.costCenters[0].label).toBe('Sem código');
    expect(result.current.costCenters[1].label).toBe('#8');
  });
});
