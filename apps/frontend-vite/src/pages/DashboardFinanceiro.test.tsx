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
  despesaFixaBreakdown: [
    { label: 'Folha de Pagamento', count: 30, value: 10000 },
  ],
  despesaVariavelBreakdown: [
    { label: 'Transporte', count: 40, value: 18000 },
    { label: 'Despesas com Serviços', count: 20, value: 4000 },
  ],
  tipoBreakdown: [
    { label: 'Despesas Variáveis', count: 55, value: 22000 },
    { label: 'Despesas Fixas', count: 35, value: 10000 },
  ],
  costCenterRanking: [
    { name: 'Logística', value: 15000, count: 25 },
    { name: 'Administrativo', value: 9000, count: 15 },
  ],
  chartAccountRanking: [
    { name: '4.4.01 — GNRE a Recolher', value: 12000, count: 8 },
    { name: '6.4.01 — IPTU', value: 3000, count: 2 },
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

  it('abre no mês atual, filtrado por "A vencer", e renderiza os KPIs de despesa', async () => {
    render(<DashboardFinanceiro />);
    expect(await screen.findByText('Despesas no mês')).toBeInTheDocument();
    expect(screen.getByText('Vencidas')).toBeInTheDocument();
    // Default de abertura = KPI "A vencer" (não 'total').
    expect(supabase.getFinancialDashboardData).toHaveBeenCalledWith(new Date().getMonth(), new Date().getFullYear(), 'month', 'aVencer', undefined);
    expect(screen.getByText(/filtrando: A vencer/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /A vencer em 7 dias/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('o card "A vencer" já ABRE visualmente marcado como ativo', async () => {
    render(<DashboardFinanceiro />);
    await screen.findByText('Despesas no mês');
    // Só os CARDS mostram "conta(s)" — descarta o botão "filtrando: … ✕" do cabeçalho,
    // que também contém "A vencer" e "filtrando".
    const cards = screen.getAllByRole('button').filter((b) => /conta\(s\)/.test(b.textContent ?? ''));
    expect(cards).toHaveLength(5);

    const marcados = cards.filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(marcados).toHaveLength(1); // exatamente um card ativo na abertura
    const aVencer = marcados[0];
    expect(aVencer.textContent).toMatch(/A vencer(?! em 7)/);
    expect(aVencer).toHaveAttribute('title', 'Limpar filtro');
    expect(aVencer.className).toContain('ring-brand'); // anel de destaque (não o de foco)
    expect(aVencer.textContent).toContain('filtrando'); // sinal não-cromático (WCAG 1.4.1)
  });

  it('o ✕ do cabeçalho limpa o filtro inicial "A vencer"', async () => {
    render(<DashboardFinanceiro />);
    fireEvent.click(await screen.findByText(/filtrando: A vencer/i));
    await vi.waitFor(() =>
      expect(supabase.getFinancialDashboardData).toHaveBeenLastCalledWith(
        expect.any(Number), expect.any(Number), 'month', 'total', undefined,
      ),
    );
    expect(screen.queryByText(/filtrando:/i)).not.toBeInTheDocument();
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
        expect.any(Number), expect.any(Number), 'month', 'aVencer', 2,
      ),
    );
  });

  it('renderiza os donuts Tipo, Despesas Fixas e Despesas Variáveis (nesta ordem)', async () => {
    render(<DashboardFinanceiro />);
    expect(await screen.findByRole('heading', { name: 'Tipo' })).toBeInTheDocument();
    const titulos = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(titulos.slice(0, 3)).toEqual(['Tipo', 'Despesas Fixas', 'Despesas Variáveis']);
    // fatias das legendas (cada donut com o seu recorte)
    expect(screen.getByText('Folha de Pagamento')).toBeInTheDocument();
    expect(screen.getByText('Transporte')).toBeInTheDocument();
  });

  it('renderiza os rankings de centros de custo e de plano de contas', async () => {
    render(<DashboardFinanceiro />);
    expect(await screen.findByText('Ranking de centros de custo')).toBeInTheDocument();
    expect(screen.getByText('Logística')).toBeInTheDocument();
    expect(screen.getByText('Administrativo')).toBeInTheDocument();

    expect(screen.getByText('Ranking de contas')).toBeInTheDocument();
    expect(screen.getByText('4.4.01 — GNRE a Recolher')).toBeInTheDocument();
    expect(screen.getByText('6.4.01 — IPTU')).toBeInTheDocument();
  });

  it('não exibe mais as contas críticas e prioritárias', async () => {
    render(<DashboardFinanceiro />);
    await screen.findByText('Ranking de contas');
    expect(screen.queryByText('Contas críticas e prioritárias')).not.toBeInTheDocument();
  });
});
