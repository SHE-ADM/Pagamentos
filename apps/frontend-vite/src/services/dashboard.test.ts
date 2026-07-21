// src/services/dashboard.test.ts
// KPIs do dashboard de VENCIMENTOS (getDashboardData). Existia teste só do dashboard
// financeiro; como os dois passaram a compartilhar `computeKpis`, um erro na regra
// quebraria as duas telas — este arquivo cobre o helper pelo segundo consumidor.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { STATUS_ID_PAGO, STATUS_ID_A_VENCER, STATUS_ID_VENCIDO } from '@sheild/shared';

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'tok' } } }) },
  },
}));

import { getDashboardData } from './supabase';

// Datas relativas a HOJE: o KPI "a vencer em 7 dias" compara com a data corrente, então
// fixar '2026-01-10' faria o teste passar hoje e falhar amanhã.
const iso = (offsetDias: number): string =>
  new Date(Date.now() + offsetDias * 86400000).toISOString().slice(0, 10);

type Row = {
  id: number; amount: number; status_id: number; due_date: string;
  document_type: string | null; payment_method: string | null; description: string | null;
  supplier: { trade_name: string | null; legal_name: string | null } | null;
};

const row = (id: number, amount: number, status_id: number, due_date: string): Row => ({
  id, amount, status_id, due_date,
  document_type: 'boleto', payment_method: 'boleto', description: null,
  supplier: { trade_name: 'Fornecedor', legal_name: null },
});

const ROWS: Row[] = [
  row(1, 100, STATUS_ID_PAGO, iso(-10)),
  row(2, 200, STATUS_ID_A_VENCER, iso(3)), // dentro da janela de 7 dias
  row(3, 400, STATUS_ID_A_VENCER, iso(20)), // a vencer, FORA da janela
  row(4, 50, STATUS_ID_VENCIDO, iso(-2)),
];

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(ROWS) })));
});

describe('getDashboardData — KPIs', () => {
  it('soma valor e contagem por situação', async () => {
    const d = await getDashboardData(new Date().getMonth(), new Date().getFullYear());
    expect(d.kpis).toMatchObject({
      totalCount: 4, totalValue: 750,
      pagoCount: 1, pagoValue: 100,
      aVencerCount: 2, aVencerValue: 600,
      vencidasCount: 1, vencidasValue: 50,
    });
  });

  // A regra mais fácil de quebrar: exige situação "a vencer" E vencimento na janela.
  // Um vencido de ontem não entra (situação errada) e um a vencer em 20 dias também não.
  it('"a vencer em 7 dias" é subconjunto de "a vencer", limitado pela janela', async () => {
    const d = await getDashboardData(new Date().getMonth(), new Date().getFullYear());
    expect(d.kpis.vencendoCount).toBe(1);
    expect(d.kpis.vencendoValue).toBe(200);
    expect(d.kpis.vencendoCount).toBeLessThanOrEqual(d.kpis.aVencerCount);
  });

  // Clicar num card filtra os GRÁFICOS, nunca os cards — senão o dashboard se zeraria a
  // cada clique. Comportamento compartilhado com o dashboard financeiro.
  it('o filtro de KPI não altera os cards', async () => {
    const semFiltro = await getDashboardData(new Date().getMonth(), new Date().getFullYear(), 'month', 'total');
    const filtrado = await getDashboardData(new Date().getMonth(), new Date().getFullYear(), 'month', 'pago');
    expect(filtrado.kpis).toEqual(semFiltro.kpis);
    // ...mas o gráfico de situação passa a ter só a fatia filtrada.
    expect(filtrado.statusBreakdown.map((s) => s.status)).toEqual(['pago']);
  });
});
