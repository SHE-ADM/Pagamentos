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
  id: number; amount: number; status_id: number; due_date: string;
  document_type: string | null; payment_method: string | null; description: string | null;
  supplier: { trade_name: string | null; legal_name: string | null } | null;
  chart_account: {
    group: { group_code: string | null; group_description: string | null; type_group_id: number } | null;
    subgroup: { subgroup_code: string | null; subgroup_description: string | null; type_group_id: number; type_group: { type_group_description: string | null } | null } | null;
  } | null;
};

const desp = (
  id: number, amount: number, status_id: number, groupDesc: string, subDesc: string,
  tipoId: number, tipoDesc: string, due = '2026-01-10',
): Row => ({
  id, amount, status_id, due_date: due, document_type: 'boleto', payment_method: 'boleto', description: null,
  supplier: { trade_name: `Forn ${id}`, legal_name: null },
  chart_account: {
    group: { group_code: null, group_description: groupDesc, type_group_id: TYPE_GROUP_ID_DESPESAS },
    subgroup: { subgroup_code: null, subgroup_description: subDesc, type_group_id: tipoId, type_group: { type_group_description: tipoDesc } },
  },
});

// Conta NÃO-despesa (Passivo, type_group_id=4) — deve ser EXCLUÍDA de tudo.
const naoDespesa = (id: number, amount: number): Row => ({
  id, amount, status_id: 3, due_date: '2026-01-20', document_type: 'boleto', payment_method: 'boleto', description: null,
  supplier: { trade_name: `Passivo ${id}`, legal_name: null },
  chart_account: { group: { group_code: null, group_description: 'Passivo Tributário', type_group_id: 4 }, subgroup: null },
});

const MONTH_ROWS: Row[] = [
  desp(1, 100, 3, 'Folha de Pagamento', 'Salários', TYPE_GROUP_ID_DESPESA_FIXA, 'Despesas Fixas'),
  desp(2, 300, 3, 'Transporte', 'Fretes', TYPE_GROUP_ID_DESPESA_VARIAVEL, 'Despesas Variáveis', '2026-01-15'),
  desp(4, 50, 8, 'Transporte', 'Fretes', TYPE_GROUP_ID_DESPESA_VARIAVEL, 'Despesas Variáveis', '2026-01-05'),
  naoDespesa(3, 999),
];

// Read do ANO (só amount/status/due + grupo p/ filtro de despesa).
const YEAR_ROWS = [
  { amount: 100, status_id: 3, due_date: '2026-01-10', chart_account: { group: { type_group_id: TYPE_GROUP_ID_DESPESAS } } },
  { amount: 999, status_id: 3, due_date: '2026-02-10', chart_account: { group: { type_group_id: 4 } } }, // não-despesa
  { amount: 200, status_id: 8, due_date: '2026-03-10', chart_account: { group: { type_group_id: TYPE_GROUP_ID_DESPESAS } } },
];

beforeEach(() => {
  vi.unstubAllGlobals();
  // Roteia pelo conteúdo do `select`: o read do mês traz document_type; o do ano não.
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const body = url.includes('document_type') ? MONTH_ROWS : YEAR_ROWS;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    }),
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

  it('mês a mês só soma despesas (Passivo de fevereiro fica de fora)', async () => {
    const d = await getFinancialDashboardData(0, 2026);
    expect(d.monthlyFlow[0]).toMatchObject({ month: 0, aPagar: 100 }); // jan (despesa)
    expect(d.monthlyFlow[1]).toMatchObject({ month: 1, aPagar: 0 }); // fev (só o Passivo → excluído)
    expect(d.monthlyFlow[2]).toMatchObject({ month: 2, aPagar: 200, pago: 200 }); // mar (despesa paga)
  });
});
