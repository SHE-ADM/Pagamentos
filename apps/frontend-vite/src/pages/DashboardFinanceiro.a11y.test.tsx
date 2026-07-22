// src/pages/DashboardFinanceiro.a11y.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from '../../tests/axe';
import type { FinancialDashboardData } from '../services/supabase';

const listCompaniesMock = vi.fn();
vi.mock('../services/lookups', () => ({ listCompanies: () => listCompaniesMock() }));

const getFinancialDashboardData = vi.fn();
vi.mock('../services/supabase', () => ({
  getFinancialDashboardData: (...a: unknown[]) => getFinancialDashboardData(...a),
}));

import DashboardFinanceiro from './DashboardFinanceiro';

const MOCK: FinancialDashboardData = {
  month: 0,
  year: 2026,
  scope: 'month',
  kpis: {
    totalCount: 90, totalValue: 32000, pagoCount: 30, pagoValue: 8000,
    aVencerCount: 52, aVencerValue: 20000, vencendoCount: 9, vencendoValue: 5000,
    vencidasCount: 8, vencidasValue: 4000,
  },
  despesaFixaBreakdown: [{ label: 'Folha de Pagamento', count: 30, value: 10000 }],
  despesaVariavelBreakdown: [{ label: 'Transporte', count: 40, value: 18000 }],
  tipoBreakdown: [
    { label: 'Despesas Variáveis', count: 55, value: 22000 },
    { label: 'Despesas Fixas', count: 35, value: 10000 },
  ],
  costCenterRanking: [{ key: 'cc:4', name: 'Logística', value: 15000, count: 25 }],
  subgroupRanking: [{ key: 'sg:44', name: '4.4.01 — GNRE a Recolher', value: 12000, count: 8 }],
  detailRows: [],
};

describe('DashboardFinanceiro — acessibilidade (WCAG AA)', () => {
  beforeEach(() => {
    listCompaniesMock.mockResolvedValue([{ sk_company: 1, trade_name: 'OTIMOTEX TECIDOS' }]);
    getFinancialDashboardData.mockResolvedValue(MOCK);
  });

  it('página (filtros + KPIs + donuts + ranking) não tem violações', async () => {
    const { container } = render(<DashboardFinanceiro />);
    await screen.findByText('Ranking de centros de custo');
    expect(await axe(container)).toHaveNoViolations();
  });
});
