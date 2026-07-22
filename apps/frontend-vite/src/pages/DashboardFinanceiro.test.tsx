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
  custoMercadoriasBreakdown: [
    { label: 'Custos', count: 10, value: 6000 },
  ],
  tipoBreakdown: [
    { label: 'Despesas Variáveis', count: 55, value: 22000 },
    { label: 'Despesas Fixas', count: 35, value: 10000 },
    { label: 'Custos de Mercadorias', count: 10, value: 6000 },
  ],
  costCenterRanking: [
    { key: 'cc:4', name: 'Logística', value: 15000, count: 25 },
    { key: 'cc:1', name: 'Administrativo', value: 9000, count: 15 },
  ],
  subgroupRanking: [
    { key: 'sg:44', name: '4.4.01 — GNRE a Recolher', value: 12000, count: 8 },
    { key: 'sg:64', name: '6.4.01 — IPTU', value: 3000, count: 2 },
  ],
  // Uma conta cujo cost_center_id (4) casa a linha 'Logística' (key cc:4) — o clique no
  // ranking filtra por essa key e o card de detalhe mostra o fornecedor dela. A 2ª conta
  // (CUSTO, subgrupo tipo 7) prova que o donut "Custos de Mercadorias" passa typeGroupId=7
  // (o drill devolve SÓ ela, nunca a de tipo 6).
  detailRows: [
    {
      id: 1, amount: 500, status_id: 3, due_date: '2026-07-10', cost_center_id: 4,
      supplier: { trade_name: 'Fornecedor ABC', legal_name: null },
      cost_center: { cost_center_code: '04', cost_center_description: 'Logística' },
      chart_account: {
        account_code: '4.5.01', account_description: 'Fretes',
        group: { group_description: 'Transporte', type_group_id: 2 },
        subgroup: {
          chart_account_subgroup_id: 22, subgroup_code: '4.5', subgroup_description: 'Transportadoras',
          type_group: { type_group_id: 6, type_group_description: 'Despesas Variáveis' },
        },
      },
    },
    {
      id: 2, amount: 700, status_id: 3, due_date: '2026-07-12', cost_center_id: 5,
      supplier: { trade_name: 'Fornecedor CM', legal_name: null },
      cost_center: { cost_center_code: '05', cost_center_description: 'Produção' },
      chart_account: {
        account_code: '3.1.01', account_description: 'Compras de Mercadorias',
        group: { group_description: 'Custos', type_group_id: 8 },
        subgroup: {
          chart_account_subgroup_id: 31, subgroup_code: '3.1', subgroup_description: 'Mercadorias',
          type_group: { type_group_id: 7, type_group_description: 'Custos de Mercadorias' },
        },
      },
    },
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
    // Isola os 5 KpiCards pela INTERSEÇÃO: têm aria-pressed (como os botões de mês/ano/escopo
    // do cabeçalho) E "conta(s)" (como os botões de ranking/legenda de donut). Só os KPIs têm
    // os dois — cada filtro sozinho pega botões demais.
    const cards = screen
      .getAllByRole('button')
      .filter((b) => b.hasAttribute('aria-pressed') && /conta\(s\)/.test(b.textContent ?? ''));
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

  it('renderiza os 4 donuts na ordem Classificação → Custos de Mercadorias → Fixas → Variáveis', async () => {
    render(<DashboardFinanceiro />);
    expect(await screen.findByRole('heading', { name: 'Classificação Financeira' })).toBeInTheDocument();
    const titulos = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(titulos.slice(0, 4)).toEqual(['Classificação Financeira', 'Custos de Mercadorias', 'Despesas Fixas', 'Despesas Variáveis']);
    // fatias das legendas (cada donut com o seu recorte)
    expect(screen.getByText('Folha de Pagamento')).toBeInTheDocument();
    expect(screen.getByText('Transporte')).toBeInTheDocument();
    expect(screen.getByText('Custos')).toBeInTheDocument();
  });

  it('o anel escala PROPORCIONALMENTE ao valor total (R$) de cada donut entre si', async () => {
    render(<DashboardFinanceiro />);
    await screen.findByRole('heading', { name: 'Classificação Financeira' });
    const ringOf = (title: string): HTMLElement | null =>
      (screen.getByRole('heading', { name: title }).closest('.card') as HTMLElement | null)
        ?.querySelector('.relative.shrink-0') as HTMLElement | null;
    // tipoBreakdown soma 38000 (22000+10000+6000) — é o MAIOR total dos 4 (superset dos
    // demais) → ratio 1 → diâmetro no MÁXIMO da escala.
    const tipo = ringOf('Classificação Financeira');
    // custoMercadoriasBreakdown soma 6000 — o MENOR total dos 4 → diâmetro bem menor.
    const custoMerc = ringOf('Custos de Mercadorias');
    expect(tipo?.style.width).toBe('124px');
    expect(parseFloat(custoMerc?.style.width ?? '0')).toBeLessThan(parseFloat(tipo?.style.width ?? '0'));
    // Furo (inset) acompanha o diâmetro — nunca um valor fixo entre donuts de tamanhos diferentes.
    const tipoHole = tipo?.closest('.relative')?.querySelector('.rounded-full.bg-white') as HTMLElement | null;
    const custoHole = custoMerc?.closest('.relative')?.querySelector('.rounded-full.bg-white') as HTMLElement | null;
    expect(tipoHole?.style.inset).not.toBe(custoHole?.style.inset);
  });

  it('o subtítulo do donut "Classificação Financeira" mostra mês + KPI (sem "Por tipo…")', async () => {
    render(<DashboardFinanceiro />);
    // Abre filtrado por "A vencer" → subtítulo = "<mês> - A vencer", SEM o prefixo antigo.
    const sub = await screen.findByText(/ - A vencer$/);
    expect(sub.textContent).not.toMatch(/Por tipo/);
    // Limpar o filtro (✕) → volta a 'total' → só o mês, sem sufixo de KPI.
    fireEvent.click(screen.getByText(/filtrando: A vencer/i));
    await vi.waitFor(() => expect(screen.queryByText(/ - A vencer$/)).toBeNull());
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

  it('clicar numa linha do ranking abre o card de detalhe com as contas do balde', async () => {
    render(<DashboardFinanceiro />);
    await screen.findByText('Ranking de centros de custo');
    // O modal fica oculto até o clique.
    expect(screen.queryByRole('heading', { name: /Centro de custo · Logística/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Logística/ }));

    expect(await screen.findByRole('heading', { name: 'Centro de custo · Logística' })).toBeInTheDocument();
    expect(screen.getByText('Fornecedor ABC')).toBeInTheDocument();       // fornecedor da conta filtrada
    expect(screen.getByText('4.5.01 — Fretes')).toBeInTheDocument();      // plano de conta
    expect(screen.getByText('1 conta(s) · Total R$ 500,00')).toBeInTheDocument();
  });

  it('clicar numa fatia da legenda de um donut abre o card de detalhe', async () => {
    render(<DashboardFinanceiro />);
    await screen.findByRole('heading', { name: 'Despesas Variáveis' });
    // A fatia "Transporte" do donut de despesas variáveis é um botão da legenda.
    fireEvent.click(screen.getByRole('button', { name: /Transporte/ }));
    expect(await screen.findByRole('heading', { name: 'Despesas Variáveis · Transporte' })).toBeInTheDocument();
  });

  it('o donut "Custos de Mercadorias" filtra o detalhe por typeGroupId=7 (não vaza tipo 6)', async () => {
    render(<DashboardFinanceiro />);
    await screen.findByRole('heading', { name: 'Custos de Mercadorias' });
    // A fatia 'Custos' do donut CM (nome acessível concatena SEM espaço: "CustosR$…";
    // a fatia da Classificação é "Custos de MercadoriasR$…" e não casa este regex).
    fireEvent.click(screen.getByRole('button', { name: /^CustosR\$/ }));
    expect(await screen.findByRole('heading', { name: 'Custos de Mercadorias · Custos' })).toBeInTheDocument();
    // Só a conta de subgrupo tipo 7 entra; a de tipo 6 (Fornecedor ABC) fica fora.
    expect(screen.getByText('Fornecedor CM')).toBeInTheDocument();
    expect(screen.queryByText('Fornecedor ABC')).toBeNull();
  });
});
