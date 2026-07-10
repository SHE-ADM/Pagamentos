// src/pages/Dashboard.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Dashboard from './Dashboard';
import * as supabase from '../services/supabase';
import type { DashboardData } from '../services/supabase';

const MOCK: DashboardData = {
  month: new Date().getMonth(),
  year: new Date().getFullYear(),
  scope: 'month',
  kpis: {
    totalCount: 128, totalValue: 47121.73,
    pagoCount: 42, pagoValue: 10903.7,
    aVencerCount: 67, aVencerValue: 24187.02,
    vencendoCount: 11, vencendoValue: 21778.02,
    vencidasCount: 8, vencidasValue: 12031.01,
  },
  statusBreakdown: [
    { status: 'a vencer', count: 67, value: 24187.02 },
    { status: 'pago', count: 42, value: 10903.7 },
    { status: 'vencido', count: 8, value: 12031.01 },
  ],
  documentTypeBreakdown: [
    { label: 'boleto', count: 70, value: 30000 },
    { label: 'Tributos', count: 30, value: 10000 },
    { label: 'outros', count: 28, value: 7121.73 },
  ],
  taxTypeBreakdown: [
    { label: 'darf', count: 18, value: 6000 },
    { label: 'gnre', count: 12, value: 4000 },
  ],
  paymentMethodBreakdown: [
    { label: 'boleto', count: 80, value: 35000 },
    { label: 'ted', count: 48, value: 12121.73 },
  ],
  supplierRanking: [
    { name: 'Avance Info/Adm/Farmácia', value: 19493.41, count: 12 },
    { name: 'CPFL Energia', value: 6420.3, count: 3 },
  ],
  monthlyFlow: Array.from({ length: 12 }, (_, m) => ({ month: m, aPagar: 1000 * (m + 1), pago: 500 * (m + 1) })),
  priorityAccounts: [
    { id: 1, kind: 'luz', supplier: 'CPFL Energia', due: '2025-02-08', amount: 1174.8, status: 'a vencer', critical: false },
    { id: 2, kind: 'agua', supplier: 'Sabesp', due: '2025-02-03', amount: 566, status: 'vencido', critical: true },
  ],
};

describe('Dashboard', () => {
  beforeEach(() => {
    vi.spyOn(supabase, 'getDashboardData').mockResolvedValue(MOCK);
  });

  it('abre no mês atual e renderiza os KPIs', async () => {
    render(<Dashboard />);
    expect(await screen.findByText('Total a pagar no mês')).toBeInTheDocument();
    expect(screen.getByText('Vencidas')).toBeInTheDocument();
    // getDashboardData chamado com o mês corrente, escopo 'month' e sem filtro ('total')
    expect(supabase.getDashboardData).toHaveBeenCalledWith(new Date().getMonth(), new Date().getFullYear(), 'month', 'total');
  });

  it('clicar num KPI aplica o filtro e clicar de novo o limpa', async () => {
    render(<Dashboard />);
    const pagos = await screen.findByRole('button', { name: /Pagos/i });

    fireEvent.click(pagos);
    expect(await screen.findByText(/filtrando: Pagos/i)).toBeInTheDocument();
    expect(supabase.getDashboardData).toHaveBeenLastCalledWith(
      new Date().getMonth(), new Date().getFullYear(), 'month', 'pago',
    );
    expect(pagos).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(pagos);
    expect(supabase.getDashboardData).toHaveBeenLastCalledWith(
      new Date().getMonth(), new Date().getFullYear(), 'month', 'total',
    );
    expect(pagos).toHaveAttribute('aria-pressed', 'false');
  });

  it('renderiza ranking e contas prioritárias', async () => {
    render(<Dashboard />);
    expect(await screen.findByText('Avance Info/Adm/Farmácia')).toBeInTheDocument();
    expect(screen.getByText('Sabesp')).toBeInTheDocument();
  });

  it('renderiza os donuts de tipos de contas, tributos e formas de pagamento', async () => {
    render(<Dashboard />);
    expect(await screen.findByText('Tipos de contas')).toBeInTheDocument();
    // "Tributos" aparece como título do donut e como fatia de "Tipos de contas".
    expect(screen.getAllByText('Tributos').length).toBeGreaterThan(0);
    expect(screen.getByText('Tipos de pagamentos')).toBeInTheDocument();
    // fatias das legendas (rótulos crus dos enums)
    expect(screen.getAllByText('boleto').length).toBeGreaterThan(0);
    expect(screen.getByText('ted')).toBeInTheDocument();
    expect(screen.getByText('outros')).toBeInTheDocument();
    // detalhamento por tipo de guia no donut "Tributos"
    expect(screen.getByText('darf')).toBeInTheDocument();
    expect(screen.getByText('gnre')).toBeInTheDocument();
  });
});
