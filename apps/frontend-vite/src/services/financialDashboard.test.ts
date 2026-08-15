import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TYPE_GROUP_ID_DESPESAS,
  TYPE_GROUP_ID_CUSTO,
  TYPE_GROUP_ID_DESPESA_FIXA,
  TYPE_GROUP_ID_DESPESA_VARIAVEL,
  TYPE_GROUP_ID_CUSTO_MERCADORIAS,
  TYPE_GROUP_ID_CUSTO_IMPORTACAO,
} from '@sheild/shared';


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
    subgroup: {
      chart_account_subgroup_id: number; subgroup_code: string | null; subgroup_description: string | null;
      type_group: { type_group_id: number; type_group_description: string | null } | null;
    } | null;
  } | null;
};

// Tipo do SUBGRUPO: os donuts por grupo recortam pelo ID (5/6/7/9), não pelo texto.
const TIPO = {
  fixa: { id: TYPE_GROUP_ID_DESPESA_FIXA, desc: 'Despesas Fixas' },
  variavel: { id: TYPE_GROUP_ID_DESPESA_VARIAVEL, desc: 'Despesas Variáveis' },
  custoMerc: { id: TYPE_GROUP_ID_CUSTO_MERCADORIAS, desc: 'Custos de Mercadorias' },
  custoImp: { id: TYPE_GROUP_ID_CUSTO_IMPORTACAO, desc: 'Custos de Importação' },
} as const;

const desp = (
  amount: number, status_id: number, groupDesc: string,
  cc: { id: number; code: string; desc: string },
  tipo: { id: number; desc: string },
  ca: { id: number; code: string; desc: string; sg: { id: number; code: string; desc: string } }, due = '2026-01-10',
  // Natureza do GRUPO — o escopo do dashboard aceita Despesas (2) OU Custo (8).
  groupTg: number = TYPE_GROUP_ID_DESPESAS,
): Row => ({
  amount, status_id, due_date: due,
  cost_center_id: cc.id, chart_account_id: ca.id,
  cost_center: { cost_center_code: cc.code, cost_center_description: cc.desc },
  chart_account: {
    account_code: ca.code, account_description: ca.desc,
    group: { group_description: groupDesc, type_group_id: groupTg },
    subgroup: {
      chart_account_subgroup_id: ca.sg.id, subgroup_code: ca.sg.code, subgroup_description: ca.sg.desc,
      type_group: { type_group_id: tipo.id, type_group_description: tipo.desc },
    },
  },
});

const CC_ADM = { id: 1, code: '01', desc: 'Administrativo' };
const CC_LOG = { id: 4, code: '04', desc: 'Logística' };
const CC_PRO = { id: 5, code: '05', desc: 'Produção' };
// O ranking de contas agrega pelo SUBGRUPO (sg) do plano; cada conta o carrega no `ca`.
const CA_SAL = { id: 11, code: '6.1.01', desc: 'Salários e Ordenados', sg: { id: 61, code: '6.1', desc: 'Pessoal' } };
const CA_FRE = { id: 22, code: '4.5.01', desc: 'Fretes sobre Compras', sg: { id: 45, code: '4.5', desc: 'Fretes' } };
const CA_MER = { id: 33, code: '3.1.01', desc: 'Compras de Mercadorias', sg: { id: 31, code: '3.1', desc: 'Mercadorias' } };
const CA_IMP = { id: 44, code: '23.2.02', desc: 'Assessoria em Importação', sg: { id: 98, code: '23.2', desc: 'Serviços de Importação' } };

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
  desp(100, 3, 'Folha de Pagamento', CC_ADM, TIPO.fixa, CA_SAL),
  desp(300, 3, 'Transporte', CC_LOG, TIPO.variavel, CA_FRE, '2026-01-15'),
  desp(50, 8, 'Transporte', CC_LOG, TIPO.variavel, CA_FRE, '2026-01-05'),
  // Conta de CUSTO (grupo Natureza 8, subgrupo Custos de Mercadorias) — ENTRA no escopo.
  desp(200, 3, 'Custos', CC_PRO, TIPO.custoMerc, CA_MER, '2026-01-12', TYPE_GROUP_ID_CUSTO),
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
    expect(TYPE_GROUP_ID_CUSTO).toBe(8);
    expect(TYPE_GROUP_ID_DESPESA_FIXA).toBe(5);
    expect(TYPE_GROUP_ID_DESPESA_VARIAVEL).toBe(6);
    expect(TYPE_GROUP_ID_CUSTO_MERCADORIAS).toBe(7);
    expect(TYPE_GROUP_ID_CUSTO_IMPORTACAO).toBe(9);
  });
});

describe('getFinancialDashboardData', () => {
  it('escopo = Despesas + Custo nos KPIs (Passivo fora, Custo DENTRO)', async () => {
    const d = await getFinancialDashboardData(0, 2026);
    // 3 despesas (100+300+50) + 1 custo (200); o Passivo (999) é excluído.
    expect(d.kpis.totalCount).toBe(4);
    expect(d.kpis.totalValue).toBe(650);
    expect(d.kpis.pagoCount).toBe(1);
    expect(d.kpis.pagoValue).toBe(50);
  });

  it('Fixas/Variáveis/Custos de Mercadorias = GRUPO recortado pelo Tipo do subgrupo', async () => {
    const d = await getFinancialDashboardData(0, 2026);
    // Fixa: só a conta de Folha (100). Variável: as duas de Transporte (300+50).
    // Custos de Mercadorias: só a conta de Custos (200).
    expect(d.despesaFixaBreakdown).toEqual([
      expect.objectContaining({ label: 'Folha de Pagamento', count: 1, value: 100 }),
    ]);
    expect(d.despesaVariavelBreakdown).toEqual([
      expect.objectContaining({ label: 'Transporte', count: 2, value: 350 }),
    ]);
    expect(d.custoMercadoriasBreakdown).toEqual([
      expect.objectContaining({ label: 'Custos', count: 1, value: 200 }),
    ]);
    // MONTH_ROWS não tem conta do tipo 9 — o donut novo fica vazio, não "some" nem quebra.
    expect(d.custoImportacaoBreakdown).toEqual([]);
    // Cada recorte é exclusivo do seu tipo, e o Passivo fica fora dos quatro.
    const labels = [...d.despesaFixaBreakdown, ...d.despesaVariavelBreakdown].map((s) => s.label);
    expect(labels).not.toContain('Custos');
    expect(labels).not.toContain('Passivo Tributário');
  });

  // 🔴 Achado de 2026-08-14 (mesma classe de bug da migration 127/128 do lado SQL): o tipo 9
  // (Custos de Importação) existia no catálogo e contava certo no TOTAL do dashboard
  // (isExpenseRow reconhece a NATUREZA do grupo), mas não entrava em NENHUM dos donuts por
  // tipo — a partição client-side não sabia do tipo novo. Este teste trava o 4º donut.
  it('Custos de Importação = GRUPO recortado pelo Tipo do subgrupo (tipo 9)', async () => {
    serve([
      desp(150, 3, 'Importações', CC_PRO, TIPO.custoImp, CA_IMP, '2026-01-18', TYPE_GROUP_ID_CUSTO),
      desp(50, 3, 'Folha de Pagamento', CC_ADM, TIPO.fixa, CA_SAL),
    ]);
    const d = await getFinancialDashboardData(0, 2026);
    expect(d.custoImportacaoBreakdown).toEqual([
      expect.objectContaining({ label: 'Importações', count: 1, value: 150 }),
    ]);
    // Exclusivo do seu tipo: não vaza para os outros três donuts por grupo.
    expect(d.despesaFixaBreakdown.map((s) => s.label)).not.toContain('Importações');
    expect(d.custoMercadoriasBreakdown).toHaveLength(0);
    expect(d.despesaVariavelBreakdown).toHaveLength(0);
    // E aparece dinamicamente também no donut "Classificação Financeira" (esse já lia o
    // catálogo sem hardcode — não precisou de correção).
    expect(d.tipoBreakdown.map((s) => s.label)).toContain('Custos de Importação');
  });

  // O recorte é pelo type_group_id (catálogo), não pela descrição: subgrupo não
  // classificado (id 0) não entra em NENHUM dos quatro donuts por grupo.
  it('conta com subgrupo não classificado fica fora dos quatro donuts por grupo', async () => {
    serve([{
      ...MONTH_ROWS[0],
      chart_account: {
        ...MONTH_ROWS[0].chart_account!,
        subgroup: { chart_account_subgroup_id: 0, subgroup_code: null, subgroup_description: null, type_group: { type_group_id: 0, type_group_description: 'Não informado' } },
      },
    }]);
    const d = await getFinancialDashboardData(0, 2026);
    expect(d.despesaFixaBreakdown).toHaveLength(0);
    expect(d.despesaVariavelBreakdown).toHaveLength(0);
    expect(d.custoMercadoriasBreakdown).toHaveLength(0);
    expect(d.custoImportacaoBreakdown).toHaveLength(0);
    expect(d.kpis.totalCount).toBe(1); // segue contando no escopo dos KPIs
  });

  it('Classificação Financeira = Fixa/Variável/Custos de Mercadorias (type_group do subgrupo)', async () => {
    const d = await getFinancialDashboardData(0, 2026);
    const labels = d.tipoBreakdown.map((s) => s.label);
    expect(labels).toContain('Despesas Fixas');
    expect(labels).toContain('Despesas Variáveis');
    expect(labels).toContain('Custos de Mercadorias');
  });

  it('ranking de CENTROS DE CUSTO ordenado por VALOR (sem o Passivo)', async () => {
    const d = await getFinancialDashboardData(0, 2026);
    expect(d.costCenterRanking[0]).toMatchObject({ name: 'Logística', value: 350, count: 2 });
    expect(d.costCenterRanking[1]).toMatchObject({ name: 'Produção', value: 200, count: 1 });
    expect(d.costCenterRanking[2]).toMatchObject({ name: 'Administrativo', value: 100, count: 1 });
    // A conta fora do escopo (Passivo, centro "Fiscal") fica fora de tudo.
    expect(d.costCenterRanking.map((r) => r.name)).not.toContain('Fiscal');
  });

  // `pct` = % do TOTAL de registros do ESCOPO (4 contas de Despesas/Custo — a de Passivo não
  // entra no denominador), não da soma dos valores exibidos. 2/4=50%, 1/4=25%, 1/4=25%.
  it('ranking de CENTROS DE CUSTO expõe `pct` = % do total de contas do escopo', async () => {
    const d = await getFinancialDashboardData(0, 2026);
    expect(d.costCenterRanking[0]).toMatchObject({ name: 'Logística', count: 2, pct: 50 });
    expect(d.costCenterRanking[1]).toMatchObject({ name: 'Produção', count: 1, pct: 25 });
    expect(d.costCenterRanking[2]).toMatchObject({ name: 'Administrativo', count: 1, pct: 25 });
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

  it('subgrupo no sentinela (id 0) vira "não informado" no ranking de contas', async () => {
    serve([{
      ...MONTH_ROWS[0], amount: 5,
      chart_account: {
        ...MONTH_ROWS[0].chart_account!,
        subgroup: { chart_account_subgroup_id: 0, subgroup_code: '0', subgroup_description: null, type_group: { type_group_id: TYPE_GROUP_ID_DESPESA_FIXA, type_group_description: 'Despesas Fixas' } },
      },
    }]);
    const d = await getFinancialDashboardData(0, 2026);
    expect(d.subgroupRanking[0]).toMatchObject({ name: 'não informado', value: 5 });
  });

  // O cadastro NÃO tem UNIQUE em descrição (só a PK) — agregar pelo texto fundiria dois
  // centros distintos numa linha só, silenciosamente, e colidiria na `key` do RankingList.
  it('centros HOMÔNIMOS não se fundem — viram linhas separadas, prefixadas pelo código', async () => {
    const gemeo = { id: 9, code: '09', desc: CC_ADM.desc }; // mesma descrição, outro id
    serve([
      desp(100, 3, 'Folha de Pagamento', CC_ADM, TIPO.fixa, CA_SAL),
      desp(250, 3, 'Folha de Pagamento', gemeo, TIPO.fixa, CA_SAL),
    ]);
    const d = await getFinancialDashboardData(0, 2026);
    expect(d.costCenterRanking).toHaveLength(2);
    expect(d.costCenterRanking[0]).toMatchObject({ name: '09 — Administrativo', value: 250 });
    expect(d.costCenterRanking[1]).toMatchObject({ name: '01 — Administrativo', value: 100 });
    // Rótulos únicos ⇒ `key` do RankingList sem colisão.
    expect(new Set(d.costCenterRanking.map((r) => r.name)).size).toBe(2);
  });

  it('ranking de contas (por SUBGRUPO) ordenado por VALOR, sem o Passivo', async () => {
    const d = await getFinancialDashboardData(0, 2026);
    // Agrega pelo subgrupo do plano: Fretes (300+50) > Mercadorias (200) > Pessoal (100).
    // O Passivo é excluído; o subgrupo de CUSTO entra (escopo 2+8).
    expect(d.subgroupRanking).toHaveLength(3);
    expect(d.subgroupRanking[0]).toMatchObject({ name: 'Fretes', value: 350, count: 2 });
    expect(d.subgroupRanking[1]).toMatchObject({ name: 'Mercadorias', value: 200, count: 1 });
    expect(d.subgroupRanking[2]).toMatchObject({ name: 'Pessoal', value: 100, count: 1 });
    // Mesmo `pct` (% do total de contas do escopo) do ranking de centros de custo.
    expect(d.subgroupRanking[0]).toMatchObject({ pct: 50 });
    expect(d.subgroupRanking[1]).toMatchObject({ pct: 25 });
    expect(d.subgroupRanking[2]).toMatchObject({ pct: 25 });
  });

  it('faz uma ÚNICA leitura (o read do ano saiu com o gráfico mês a mês)', async () => {
    await getFinancialDashboardData(0, 2026);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
