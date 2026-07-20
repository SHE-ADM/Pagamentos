// src/pages/DashboardFinanceiro.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Lookup do filtro "Empresa" (useCompanyOptions) — evita rede no teste.
const listCompaniesMock = vi.fn();
vi.mock('../services/lookups', () => ({
  listCompanies: () => listCompaniesMock(),
}));

import DashboardFinanceiro from './DashboardFinanceiro';
import * as supabase from '../services/supabase';
import type { FinancialDashboardData } from '../services/supabase';

const MOCK: FinancialDashboardData = {
  month: new Date().getMonth(),
  year: new Date().getFullYear(),
  scope: 'month',
  kpis: {
    totalCount: 90, totalValue: 32000,
    pagoCount: 30, pagoValue: 8000,
    aVencerCount: 52, aVencerValue: 20000,
    vencendoCount: 9, vencendoValue: 5000,
    vencidasCount: 8, vencidasValue: 4000,
  },
  naturezaBreakdown: [
    { label: 'Transporte', count: 40, value: 18000 },
    { label: 'Folha de Pagamento', count: 30, value: 10000 },
    { label: 'Despesas com Serviços', count: 20, value: 4000 },
  ],
  tipoBreakdown: [
    { label: 'Despesas Variáveis', count: 55, value: 22000 },
    { label: 'Despesas Fixas', count: 35, value: 10000 },
  ],
  subgroupRanking: [
    { name: 'Fretes', value: 15000, count: 25 },
    { name: 'Salários', value: 9000, count: 15 },
  ],
  monthlyFlow: Array.from({ length: 12 }, (_, m) => ({ month: m, aPagar: 1000 * (m + 1), pago: 400 * (m + 1) })),
  priorityAccounts: [
    { id: 1, kind: 'luz', supplier: 'CPFL Energia', due: '2026-01-08', amount: 1174.8, status: 'a vencer', critical: false },
    { id: 2, kind: 'agua', supplier: 'Sabesp', due: '2026-01-03', amount: 566, status: 'vencido', critical: true },
  ],
};

describe('DashboardFinanceiro', () => {
  beforeEach(() => {
    vi.spyOn(supabase, 'getFinancialDashboardData').mockResolvedValue(MOCK);
    listCompaniesMock.mockReset();
    listCompaniesMock.mockResolvedValue([
      { sk_company: 1, trade_name: 'OTIMOTEX TECIDOS' },
      { sk_company: 2, trade_name: 'LEBIANCO' },
    ]);
  });

  it('abre no mês atual e renderiza os KPIs de despesa', async () => {
    render(<DashboardFinanceiro />);
    expect(await screen.findByText('Despesas no mês')).toBeInTheDocument();
    expect(screen.getByText('Vencidas')).toBeInTheDocument();
    expect(supabase.getFinancialDashboardData).toHaveBeenCalledWith(new Date().getMonth(), new Date().getFullYear(), 'month', 'total', undefined);
  });

  it('clicar num KPI aplica o filtro e clicar de novo o limpa', async () => {
    render(<DashboardFinanceiro />);
    const pagas = await screen.findByRole('button', { name: /Pagas/i });

    fireEvent.click(pagas);
    expect(await screen.findByText(/filtrando: Pagos/i)).toBeInTheDocument();
    expect(supabase.getFinancialDashboardData).toHaveBeenLastCalledWith(
      new Date().getMonth(), new Date().getFullYear(), 'month', 'pago', undefined,
    );
    expect(pagas).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(pagas);
    expect(supabase.getFinancialDashboardData).toHaveBeenLastCalledWith(
      new Date().getMonth(), new Date().getFullYear(), 'month', 'total', undefined,
    );
    expect(pagas).toHaveAttribute('aria-pressed', 'false');
  });

  it('escolher LEBIANCO recarrega com skCompany=2', async () => {
    render(<DashboardFinanceiro />);
    await screen.findByRole('option', { name: 'LEBIANCO' });
    fireEvent.change(screen.getByLabelText('Filtrar por empresa'), { target: { value: '2' } });
    await vi.waitFor(() =>
      expect(supabase.getFinancialDashboardData).toHaveBeenLastCalledWith(
        expect.any(Number), expect.any(Number), 'month', 'total', 2,
      ),
    );
  });

  it('renderiza os donuts Natureza e Tipo', async () => {
    render(<DashboardFinanceiro />);
    expect(await screen.findByText('Natureza')).toBeInTheDocument();
    expect(screen.getByText('Tipo')).toBeInTheDocument();
    // fatias das legendas
    expect(screen.getByText('Transporte')).toBeInTheDocument();
    expect(screen.getByText('Despesas Variáveis')).toBeInTheDocument();
  });

  it('renderiza o ranking de subgrupos e as contas prioritárias', async () => {
    render(<DashboardFinanceiro />);
    expect(await screen.findByText('Ranking de subgrupos')).toBeInTheDocument();
    expect(screen.getByText('Fretes')).toBeInTheDocument();
    expect(screen.getByText('Salários')).toBeInTheDocument();
    expect(screen.getByText('Sabesp')).toBeInTheDocument();
  });
});
