// src/pages/Dashboard.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
// Lookup do filtro "Empresa" (useCompanyOptions) — evita rede no teste.
const listCompaniesMock = vi.fn();
vi.mock('../services/lookups', () => ({
  listCompanies: () => listCompaniesMock(),
}));

import Dashboard from './Dashboard';
import * as supabase from '../services/supabase';
import type { DashboardData } from '../services/supabase';
// Fonte única do rótulo do botão de mês (`aria-label={`Mês ${MONTHS_FULL[i]}`}` no
// DashboardHeader) — repetir 'Fevereiro' aqui deixaria o teste passar a casar outro botão
// no dia em que o rótulo mudasse, sem ninguém notar.
import { MONTHS_FULL } from '../components/dashboard/constants';

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
    { key: 'sup:Avance', name: 'Avance Info/Adm/Farmácia', value: 19493.41, count: 12 },
    { key: 'sup:CPFL', name: 'CPFL Energia', value: 6420.3, count: 3 },
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
    listCompaniesMock.mockReset();
    listCompaniesMock.mockResolvedValue([
      { sk_company: 1, trade_name: 'OTIMOTEX TECIDOS' },
      { sk_company: 2, trade_name: 'LEBIANCO' },
    ]);
  });

  it('abre no mês atual, filtrado por "A vencer em 7 dias", e renderiza os KPIs', async () => {
    render(<Dashboard />);
    expect(await screen.findByText('Total a pagar no mês')).toBeInTheDocument();
    expect(screen.getByText('Vencidas')).toBeInTheDocument();
    // Mês corrente, escopo 'month', filtro de KPI 'vencendo7' (decisão do usuário
    // 2026-08-15; antes abria em 'total') e sem empresa (undefined = TODAS — o 5º argumento).
    expect(supabase.getDashboardData).toHaveBeenCalledWith(new Date().getMonth(), new Date().getFullYear(), 'month', 'vencendo7', undefined);
    expect(screen.getByText(/filtrando: A vencer em 7 dias/i)).toBeInTheDocument();
  });

  it('clicar num KPI aplica o filtro e clicar de novo o limpa', async () => {
    render(<Dashboard />);
    const pagos = await screen.findByRole('button', { name: /Pagos/i });

    fireEvent.click(pagos);
    expect(await screen.findByText(/filtrando: Pagos/i)).toBeInTheDocument();
    expect(supabase.getDashboardData).toHaveBeenLastCalledWith(
      new Date().getMonth(), new Date().getFullYear(), 'month', 'pago', undefined,
    );
    expect(pagos).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(pagos);
    expect(supabase.getDashboardData).toHaveBeenLastCalledWith(
      new Date().getMonth(), new Date().getFullYear(), 'month', 'total', undefined,
    );
    expect(pagos).toHaveAttribute('aria-pressed', 'false');
  });

  // Os dois cards cujo subtítulo faz uma afirmação POSITIVA que o filtro pode tornar
  // impossível declaram o recorte: "— 2026" desenha 12 colunas com no máximo uma barra
  // (`fYear` também é filtrado), e "…e vencidas" é inalcançável sob 'vencendo7' (a-vencer e
  // vencido são estados mutuamente exclusivos). Sem a ressalva NO CARD, os dois se leem como
  // "2026 só teve movimento em agosto" e "não há conta vencida" — o oposto do que a base diz;
  // o chip do cabeçalho é global e não desfaz uma afirmação feita dentro do card.
  it('os cards que afirmam ano/vencidas declaram o filtro ativo no próprio subtítulo', async () => {
    render(<Dashboard />);
    await screen.findByText('Total a pagar no mês');
    const ano = new Date().getFullYear();
    // ` - ` é o separador do SUFIXO DE KPI (o mesmo de /dashboard_despesas); ` · ` é o que
    // junta partes de subtítulo nesta página. Os dois papéis não se misturam.
    expect(screen.getByText(`Total a pagar vs. pago por vencimento — ${ano} - A vencer em 7 dias`)).toBeInTheDocument();
    expect(screen.getByText('Água, luz, internet, aluguel, tributos e vencidas - A vencer em 7 dias')).toBeInTheDocument();

    // Sem filtro ('total') os subtítulos voltam ao texto seco — a ressalva não é decoração
    // permanente, ela aparece exatamente quando há recorte a declarar.
    fireEvent.click(screen.getByText(/filtrando: A vencer em 7 dias/i));
    expect(await screen.findByText(`Total a pagar vs. pago por vencimento — ${ano}`)).toBeInTheDocument();
    expect(screen.getByText('Água, luz, internet, aluguel, tributos e vencidas')).toBeInTheDocument();
  });

  // WIRING da regra "navegar limpa o filtro", com a PÁGINA montada. `useDashboardFilters`
  // já a cobre isolada, e o `DashboardHeader` é testado com `setMonth` mockado — nenhum dos
  // dois observa o que o usuário enxerga: o clique no mês REFAZ a busca, uma vez, já sem o
  // filtro. Sem este caso, dois defeitos de composição passariam com a suíte verde — o `load`
  // disparando com o filtro antigo, e o par (mês, filtro) não sendo batched, o que gastaria
  // duas leituras por clique. Regra 2 item 5 do CLAUDE.md: a função pura não cobre o call site.
  it('clicar noutro mês recarrega UMA vez, já sem o filtro de abertura', async () => {
    render(<Dashboard />);
    await screen.findByText('Total a pagar no mês');
    // DELTA de chamadas, não o total: o `vi.spyOn` do `beforeEach` reencontra o mesmo spy e
    // o histórico se acumula entre os casos deste arquivo (medido: 5 chamadas ao chegar
    // aqui). Um `toHaveBeenCalledTimes` absoluto passaria a depender da ORDEM dos testes.
    const chamadas = (): number => vi.mocked(supabase.getDashboardData).mock.calls.length;
    const antes = chamadas();

    // Um mês DIFERENTE do corrente (o botão do mês atual não limparia o filtro — é a outra
    // metade da regra, coberta no teste do hook).
    const outroMes = (new Date().getMonth() + 1) % 12;
    fireEvent.click(screen.getByRole('button', { name: `Mês ${MONTHS_FULL[outroMes]}` }));

    await vi.waitFor(() => expect(supabase.getDashboardData).toHaveBeenLastCalledWith(
      outroMes, new Date().getFullYear(), 'month', 'total', undefined,
    ));
    expect(chamadas()).toBe(antes + 1); // uma leitura só — mês e filtro mudam no mesmo lote
    expect(screen.queryByText(/filtrando:/i)).not.toBeInTheDocument();
  });

  // Paridade visual com /dashboard_despesas: os dois dashboards renderizam o MESMO
  // KpiCard, então o destaque do card selecionado e a affordance de clique valem aqui
  // também. Trava a paridade — se alguém voltar a inlinear o card só numa das páginas,
  // este teste cai.
  it('o card selecionado ganha o destaque completo (anel + selo + título de limpar)', async () => {
    render(<Dashboard />);
    await screen.findByText('Total a pagar no mês');
    // Só os CARDS mostram "conta(s)" — descarta o botão "filtrando: … ✕" do cabeçalho.
    const cards = (): HTMLElement[] =>
      screen.getAllByRole('button').filter((b) => /conta\(s\)/.test(b.textContent ?? ''));

    // Abre filtrado em "A vencer em 7 dias" (igual ao financeiro desde 2026-08-15): já há
    // UM card marcado na abertura, e é esse. Clicar noutro KPI move a marcação.
    const marcadosNaAbertura = cards().filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(marcadosNaAbertura).toHaveLength(1);
    expect(marcadosNaAbertura[0].textContent).toMatch(/A vencer em 7 dias/);

    const pagos = cards().find((b) => /Pagos/.test(b.textContent ?? ''));
    expect(pagos).toBeDefined();
    fireEvent.click(pagos as HTMLElement);

    expect(pagos).toHaveAttribute('aria-pressed', 'true');
    expect(pagos).toHaveAttribute('title', 'Limpar filtro');
    expect(pagos?.className).toContain('ring-brand'); // anel do ativo (não o de foco)
    expect(pagos?.textContent).toContain('filtrando'); // sinal não-cromático (WCAG 1.4.1)
    // E só ele fica marcado.
    expect(cards().filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
  });

  it('todo card de KPI mantém a affordance de clique (hover perceptível)', async () => {
    render(<Dashboard />);
    await screen.findByText('Total a pagar no mês');
    const cards = screen.getAllByRole('button').filter((b) => /conta\(s\)/.test(b.textContent ?? ''));
    expect(cards).toHaveLength(5);
    for (const c of cards) {
      expect(c.className).toContain('cursor-pointer');
      expect(c.className).toContain('hover:bg-slate-50');
      expect(c.className).toContain('hover:-translate-y-0.5');
      expect(c.className).toContain('hover:shadow-md');
    }
  });

  // Filtro de EMPRESA — aplica NA HORA (o dashboard não tem "Buscar") e escopa tudo. Ao
  // contrário de mês/ano, trocar de EMPRESA preserva o filtro de KPI (aqui, o default
  // 'vencendo7'): a empresa não conflita com a janela móvel dos 7 dias.
  it('escolher LEBIANCO recarrega o dashboard com skCompany=2', async () => {
    render(<Dashboard />);
    await screen.findByRole('option', { name: 'LEBIANCO' });

    fireEvent.change(screen.getByLabelText('Filtrar por empresa'), { target: { value: '2' } });

    await vi.waitFor(() =>
      expect(supabase.getDashboardData).toHaveBeenLastCalledWith(
        new Date().getMonth(), new Date().getFullYear(), 'month', 'vencendo7', 2,
      ),
    );
  });

  it('voltar para "Empresa" (vazio) remove o filtro — as duas empresas', async () => {
    render(<Dashboard />);
    await screen.findByRole('option', { name: 'LEBIANCO' });
    const select = screen.getByLabelText('Filtrar por empresa');

    fireEvent.change(select, { target: { value: '2' } });
    await vi.waitFor(() => expect(supabase.getDashboardData).toHaveBeenLastCalledWith(
      expect.any(Number), expect.any(Number), 'month', 'vencendo7', 2,
    ));

    fireEvent.change(select, { target: { value: '' } });
    await vi.waitFor(() => expect(supabase.getDashboardData).toHaveBeenLastCalledWith(
      expect.any(Number), expect.any(Number), 'month', 'vencendo7', undefined,
    ));
  });

  it('o filtro de empresa CONVIVE com o filtro de KPI', async () => {
    render(<Dashboard />);
    await screen.findByRole('option', { name: 'LEBIANCO' });

    fireEvent.change(screen.getByLabelText('Filtrar por empresa'), { target: { value: '2' } });
    fireEvent.click(await screen.findByRole('button', { name: /Pagos/i }));

    await vi.waitFor(() =>
      expect(supabase.getDashboardData).toHaveBeenLastCalledWith(
        expect.any(Number), expect.any(Number), 'month', 'pago', 2,
      ),
    );
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
