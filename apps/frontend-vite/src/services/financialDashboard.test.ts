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
  // Os ids sao a IDENTIDADE da agregacao dos rankings (o texto e so rotulo).
  cost_center_id: number; chart_account_id: number;
  cost_center: { cost_center_code: string | null; cost_center_description: string | null } | null;
  chart_account: {
    account_code: string | null; account_description: string | null;
    group: { group_description: string | null; type_group_id: number } | null;
    subgroup: { type_group: { type_group_description: string | null } | null } | null;
  } | null;
};

const desp = (
  amount: number, status_id: number, groupDesc: string,
  cc: { id: number; code: string; desc: string },
  tipoDesc: string, ca: { id: number; code: string; desc: string }, due = '2026-01-10',
): Row => ({
  amount, status_id, due_date: due,
  cost_center_id: cc.id, chart_account_id: ca.id,
  cost_center: { cost_center_code: cc.code, cost_center_description: cc.desc },
  chart_account: {
    account_code: ca.code, account_description: ca.desc,
    group: { group_description: groupDesc, type_group_id: TYPE_GROUP_ID_DESPESAS },
    subgroup: { type_group: { type_group_description: tipoDesc } },
  },
});

const CC_ADM = { id: 1, code: '01', desc: 'Administrativo' };
const CC_LOG = { id: 4, code: '04', desc: 'Logística' };
const CA_SAL = { id: 11, code: '6.1.01', desc: 'Salários e Ordenados' };
const CA_FRE = { id: 22, code: '4.5.01', desc: 'Fretes sobre Compras' };

// Conta NÃO-despesa (Passivo, type_group_id=4) — deve ser EXCLUÍDA de tudo.
const naoDespesa = (amount: number): Row => ({
  amount, status_id: 3, due_date: '2026-01-20',
  cost_center_id: 3, chart_account_id: 99,
  cost_center: { cost_center_code: '03', cost_center_description: 'Fiscal' },
  chart_account: {
    account_code: '2.1.01', account_description: 'Tributos a Recolher',
    group: { group_description: 'Passivo Tributário', type_group_id: 4 },
    subgroup: null,
  },
});

const MONTH_ROWS: Row[] = [
  desp(100, 3, 'Folha de Pagamento', CC_ADM, 'Despesas Fixas', CA_SAL),
  desp(300, 3, 'Transporte', CC_LOG, 'Despesas Variáveis', CA_FRE, '2026-01-15'),
  desp(50, 8, 'Transporte', CC_LOG, 'Despesas Variáveis', CA_FRE, '2026-01-05'),
  naoDespesa(999),
];

// Troca a resposta do fetch para um conjunto especifico de linhas.
const serve = (rows: Row[]): void => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(rows) })));
};

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

  it('ranking de CENTROS DE CUSTO ordenado por VALOR (sem o Passivo)', async () => {
    const d = await getFinancialDashboardData(0, 2026);
    expect(d.costCenterRanking[0]).toMatchObject({ name: 'Logística', value: 350, count: 2 });
    expect(d.costCenterRanking[1]).toMatchObject({ name: 'Administrativo', value: 100, count: 1 });
    // A conta não-despesa (Passivo, centro "Fiscal") fica fora de tudo.
    expect(d.costCenterRanking.map((r) => r.name)).not.toContain('Fiscal');
  });

  // O sentinela id 0 EXISTE nos dois cadastros (descrição NULL no banco real), então o
  // embed vem PREENCHIDO — testar só "embed != null" deixaria passar um rótulo técnico.
  it('conta no sentinela (id 0) cai em "não informado", com ou sem embed', async () => {
    serve([
      { ...MONTH_ROWS[0], cost_center_id: 0, cost_center: { cost_center_code: null, cost_center_description: null }, amount: 7 },
      { ...MONTH_ROWS[0], cost_center_id: 0, cost_center: null, amount: 3 },
    ]);
    const d = await getFinancialDashboardData(0, 2026);
    expect(d.costCenterRanking).toHaveLength(1);
    expect(d.costCenterRanking[0]).toMatchObject({ name: 'não informado', value: 10, count: 2 });
    expect(d.costCenterRanking[0].name).not.toContain('#');
  });

  it('plano de contas no sentinela (id 0, código "0") também vira "não informado"', async () => {
    serve([{
      ...MONTH_ROWS[0], amount: 5, chart_account_id: 0,
      chart_account: { ...MONTH_ROWS[0].chart_account!, account_code: '0', account_description: null },
    }]);
    const d = await getFinancialDashboardData(0, 2026);
    expect(d.chartAccountRanking[0]).toMatchObject({ name: 'não informado', value: 5 });
  });

  // O cadastro NÃO tem UNIQUE em descrição (só a PK) — agregar pelo texto fundiria dois
  // centros distintos numa linha só, silenciosamente, e colidiria na `key` do RankingList.
  it('centros HOMÔNIMOS não se fundem — viram linhas separadas, prefixadas pelo código', async () => {
    const gemeo = { id: 9, code: '09', desc: CC_ADM.desc }; // mesma descrição, outro id
    serve([
      desp(100, 3, 'Folha de Pagamento', CC_ADM, 'Despesas Fixas', CA_SAL),
      desp(250, 3, 'Folha de Pagamento', gemeo, 'Despesas Fixas', CA_SAL),
    ]);
    const d = await getFinancialDashboardData(0, 2026);
    expect(d.costCenterRanking).toHaveLength(2);
    expect(d.costCenterRanking[0]).toMatchObject({ name: '09 — Administrativo', value: 250 });
    expect(d.costCenterRanking[1]).toMatchObject({ name: '01 — Administrativo', value: 100 });
    // Rótulos únicos ⇒ `key` do RankingList sem colisão.
    expect(new Set(d.costCenterRanking.map((r) => r.name)).size).toBe(2);
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
