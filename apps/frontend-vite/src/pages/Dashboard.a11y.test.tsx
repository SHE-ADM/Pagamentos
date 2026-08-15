// src/pages/Dashboard.a11y.test.tsx
//
// A7-2 (pendência aberta desde o review de 2026-07-08): `/dashboard_vencimentos` era a única
// página de dados sem varredura do axe — o `DashboardFinanceiro` já tinha.
//
// A página tem duas árvores acessíveis distintas: SEM filtro de KPI e COM filtro (que acrescenta
// o chip "filtrando: X ✕" e muda o `aria-pressed` dos cards). Escanear só o estado inicial
// deixaria o segundo sem cobertura, e é ele que o usuário mais vê — o mesmo cuidado que o
// `DashboardHeader.a11y.test.tsx` já toma.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { axe } from '../../tests/axe';

const listCompaniesMock = vi.fn();
vi.mock('../services/lookups', () => ({
  listCompanies: () => listCompaniesMock(),
}));

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
  documentTypeBreakdown: [{ label: 'boleto', count: 70, value: 30000 }],
  taxTypeBreakdown: [{ label: 'darf', count: 18, value: 6000 }],
  paymentMethodBreakdown: [{ label: 'boleto', count: 80, value: 35000 }],
  supplierRanking: [
    { key: 'sup:Avance', name: 'Avance Info/Adm/Farmácia', value: 19493.41, count: 12 },
  ],
  monthlyFlow: Array.from({ length: 12 }, (_, m) => ({ month: m, aPagar: 1000 * (m + 1), pago: 500 * (m + 1) })),
  priorityAccounts: [
    { id: 1, kind: 'luz', supplier: 'CPFL Energia', due: '2025-02-08', amount: 1174.8, status: 'a vencer', critical: false },
    { id: 2, kind: 'agua', supplier: 'Sabesp', due: '2025-02-03', amount: 566, status: 'vencido', critical: true },
  ],
};

describe('Dashboard de vencimentos — acessibilidade (WCAG AA)', () => {
  beforeEach(() => {
    vi.spyOn(supabase, 'getDashboardData').mockResolvedValue(MOCK);
    listCompaniesMock.mockReset();
    listCompaniesMock.mockResolvedValue([
      { sk_company: 1, trade_name: 'OTIMOTEX TECIDOS' },
      { sk_company: 2, trade_name: 'LEBIANCO' },
    ]);
  });

  it('estado inicial (KPIs + donuts + rankings) não tem violações', async () => {
    const { container } = render(<Dashboard />);
    await screen.findByText('Total a pagar no mês');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('com filtro de KPI aplicado também não tem violações', async () => {
    const { container } = render(<Dashboard />);
    fireEvent.click(await screen.findByRole('button', { name: /Pagos/i }));
    await screen.findByText(/filtrando: Pagos/i);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('no escopo "todas as contas" os meses ficam fora da ordem de tabulação', async () => {
    // Mês desabilitado dentro de um contêiner `aria-hidden` seria alcançável por TAB e invisível
    // ao leitor de tela (axe `aria-hidden-focus`, WCAG 4.1.2) — o defeito que o
    // `DashboardHeader` corrigiu com `disabled`. Aqui a página inteira é escaneada nesse estado.
    const { container } = render(<Dashboard />);
    await screen.findByText('Total a pagar no mês');
    fireEvent.click(screen.getByRole('button', { name: /todas as contas/i }));
    // O filtro de KPI da abertura ('vencendo7') SOBREVIVE à troca de escopo — só mês/ano o
    // limpam (ver useDashboardFilters): "todas as contas" + próximos 7 dias é combinação válida.
    await waitFor(() => expect(supabase.getDashboardData).toHaveBeenCalledWith(
      expect.any(Number), expect.any(Number), 'all', 'vencendo7', undefined,
    ));
    expect(await axe(container)).toHaveNoViolations();
  });
});
