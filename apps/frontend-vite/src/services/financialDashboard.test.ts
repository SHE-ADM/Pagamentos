import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TYPE_GROUP_ID_DESPESAS, TYPE_GROUP_ID_DESPESA_FIXA, TYPE_GROUP_ID_DESPESA_VARIAVEL } from '@sheild/shared';

// Sessão mockada — o wrapper query() lê o token pela sessão.
vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'tok-123' } } }) },
  },
}));

import { getFinancialDashboardData } from './supabase';

// Linha do read do MÊS (embed de classificação de 3 níveis).
type Row = {
  amount: number; status_id: number; due_date: string;
  chart_account: {
    account_code: string | null; account_description: string | null;
    group: { group_code: string | null; group_description: string | null; type_group_id: number } | null;
    subgroup: { subgroup_code: string | null; subgroup_description: string | null; type_group_id: number; type_group: { type_group_description: string | null } | null } | null;
  } | null;
};

const desp = (
  amount: number, status_id: number, groupDesc: string, subDesc: string,
  tipoId: number, tipoDesc: string, accCode: string, accDesc: string, due = '2026-01-10',
): Row => ({
  amount, status_id, due_date: due,
  chart_account: {
    account_code: accCode, account_description: accDesc,
    group: { group_code: null, group_description: groupDesc, type_group_id: TYPE_GROUP_ID_DESPESAS },
    subgroup: { subgroup_code: null, subgroup_description: subDesc, type_group_id: tipoId, type_group: { type_group_description: tipoDesc } },
  },
});

// Conta NÃO-despesa (Passivo, type_group_id=4) — deve ser EXCLUÍDA de tudo.
const naoDespesa = (amount: number): Row => ({
  amount, status_id: 3, due_date: '2026-01-20',
  chart_account: {
    account_code: '2.1.01', account_description: 'Tributos a Recolher',
    group: { group_code: null, group_description: 'Passivo Tributário', type_group_id: 4 },
    subgroup: null,
  },
});

const MONTH_ROWS: Row[] = [
  desp(100, 3, 'Folha de Pagamento', 'Salários', TYPE_GROUP_ID_DESPESA_FIXA, 'Despesas Fixas', '6.1.01', 'Salários e Ordenados'),
  desp(300, 3, 'Transporte', 'Fretes', TYPE_GROUP_ID_DESPESA_VARIAVEL, 'Despesas Variáveis', '4.5.01', 'Fretes sobre Compras', '2026-01-15'),
  desp(50, 8, 'Transporte', 'Fretes', TYPE_GROUP_ID_DESPESA_VARIAVEL, 'Despesas Variáveis', '4.5.01', 'Fretes sobre Compras', '2026-01-05'),
  naoDespesa(999),
];

beforeEach(() => {
  vi.unstubAllGlobals();
  // Leitura única (a do ANO saiu junto com o gráfico mês a mês).
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(MONTH_ROWS) })),
  );
});

describe('constantes de type_group (guarda — migration 094)', () => {
  it('mantém os ids do catálogo', () => {
    expect(TYPE_GROUP_ID_DESPESAS).toBe(2);
    expect(TYPE_GROUP_ID_DESPESA_FIXA).toBe(5);
    expect(TYPE_GROUP_ID_DESPESA_VARIAVEL).toBe(6);
  });
});

describe('getFinancialDashboardData', () => {
  it('exclui contas NÃO-despesa dos KPIs (Passivo fora)', async () => {
    const d = await getFinancialDashboardData(0, 2026);
    // 3 despesas (ids 1,2,4); a conta 3 (Passivo 999) é excluída.
    expect(d.kpis.totalCount).toBe(3);
    expect(d.kpis.totalValue).toBe(450);
    expect(d.kpis.pagoCount).toBe(1); // id 4
    expect(d.kpis.pagoValue).toBe(50);
  });

  it('Natureza = por GRUPO de despesa (sem o Passivo)', async () => {
    const d = await getFinancialDashboardData(0, 2026);
    const labels = d.naturezaBreakdown.map((s) => s.label);
    expect(labels).toContain('Transporte');
    expect(labels).toContain('Folha de Pagamento');
    expect(labels).not.toContain('Passivo Tributário');
    // Transporte tem 2 contas (ids 2,4) → maior contagem, vem primeiro.
    expect(d.naturezaBreakdown[0]).toMatchObject({ label: 'Transporte', count: 2 });
  });

  it('Tipo = Fixa/Variável (descrição do type_group do subgrupo)', async () => {
    const d = await getFinancialDashboardData(0, 2026);
    const labels = d.tipoBreakdown.map((s) => s.label);
    expect(labels).toContain('Despesas Fixas');
    expect(labels).toContain('Despesas Variáveis');
  });

  it('ranking de subgrupos ordenado por VALOR', async () => {
    const d = await getFinancialDashboardData(0, 2026);
    expect(d.subgroupRanking[0]).toMatchObject({ name: 'Fretes', value: 350, count: 2 });
    expect(d.subgroupRanking[1]).toMatchObject({ name: 'Salários', value: 100, count: 1 });
  });

  it('ranking de plano de contas ordenado por VALOR (código — descrição, sem o Passivo)', async () => {
    const d = await getFinancialDashboardData(0, 2026);
    expect(d.chartAccountRanking[0]).toMatchObject({ name: '4.5.01 — Fretes sobre Compras', value: 350, count: 2 });
    expect(d.chartAccountRanking[1]).toMatchObject({ name: '6.1.01 — Salários e Ordenados', value: 100, count: 1 });
    expect(d.chartAccountRanking.map((r) => r.name)).not.toContain('2.1.01 — Tributos a Recolher');
  });

  it('faz uma ÚNICA leitura (o read do ano saiu com o gráfico mês a mês)', async () => {
    await getFinancialDashboardData(0, 2026);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
