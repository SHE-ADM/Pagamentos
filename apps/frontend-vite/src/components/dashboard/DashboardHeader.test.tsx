// src/components/dashboard/DashboardHeader.test.tsx
// Contrato do cabeçalho compartilhado pelos dois dashboards. Cobre o que as páginas
// delegaram a ele: identidade (título/assunto/id do select), os 5 controles e o ✕ do
// filtro de KPI. As páginas seguem testando a INTEGRAÇÃO (o reload com os argumentos
// certos); aqui fica a unidade.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DashboardHeader } from './DashboardHeader';
import { MONTHS_FULL } from './constants';
import type { DashboardFilters } from '../../hooks/useDashboardFilters';

// Dublê do useDashboardFilters: o header só CONSOME o objeto, então o teste injeta um
// estado fixo + espiões e verifica quem foi chamado (o hook tem teste próprio).
const makeFilters = (over: Partial<DashboardFilters> = {}): DashboardFilters => ({
  month: 6,
  year: 2026,
  scope: 'month',
  filter: 'total',
  skCompany: undefined,
  companyOptions: [
    { value: 1, label: 'OTIMOTEX TECIDOS' },
    { value: 2, label: 'LEBIANCO' },
  ],
  setMonth: vi.fn(),
  setYear: vi.fn(),
  setScope: vi.fn(),
  setSkCompany: vi.fn(),
  toggleFilter: vi.fn(),
  clearFilter: vi.fn(),
  ...over,
});

const base = {
  title: 'Indicadores financeiros',
  subject: 'Despesas',
  idPrefix: 'dashboard-financeiro',
  loading: false,
  onRefresh: (): void => undefined,
};

describe('DashboardHeader', () => {
  it('mostra título e o assunto do período no subtítulo', () => {
    render(<DashboardHeader {...base} filters={makeFilters()} />);
    expect(screen.getByRole('heading', { name: 'Indicadores financeiros' })).toBeInTheDocument();
    expect(screen.getByText(`Despesas · ${MONTHS_FULL[6]} 2026`, { exact: false })).toBeInTheDocument();
  });

  it('no escopo "all" o subtítulo troca o mês por "Todas as contas"', () => {
    render(<DashboardHeader {...base} filters={makeFilters({ scope: 'all' })} />);
    expect(screen.getByText('Despesas · Todas as contas', { exact: false })).toBeInTheDocument();
  });

  it('o <select> de empresa recebe id/name derivados do idPrefix (autofill separado por página)', () => {
    render(<DashboardHeader {...base} filters={makeFilters()} />);
    const sel = screen.getByLabelText('Filtrar por empresa');
    expect(sel).toHaveAttribute('id', 'dashboard-financeiro-company');
    expect(sel).toHaveAttribute('name', 'dashboard-financeiro-company');
  });

  it('escolher empresa devolve o sk; voltar a "Empresa" devolve undefined (= TODAS)', () => {
    const filters = makeFilters();
    render(<DashboardHeader {...base} filters={filters} />);
    const sel = screen.getByLabelText('Filtrar por empresa');
    fireEvent.change(sel, { target: { value: '2' } });
    expect(filters.setSkCompany).toHaveBeenLastCalledWith(2);
    fireEvent.change(sel, { target: { value: '' } });
    expect(filters.setSkCompany).toHaveBeenLastCalledWith(undefined);
  });

  it('mês e ano avisam a página e marcam o selecionado', () => {
    const filters = makeFilters();
    render(<DashboardHeader {...base} filters={filters} />);
    expect(screen.getByLabelText(`Mês ${MONTHS_FULL[6]}`)).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByLabelText(`Mês ${MONTHS_FULL[0]}`));
    expect(filters.setMonth).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByRole('button', { name: '2025' }));
    expect(filters.setYear).toHaveBeenCalledWith(2025);
  });

  it('no escopo "all" os meses ficam inertes, fora do foco E fora do leitor de tela', () => {
    const { container } = render(<DashboardHeader {...base} filters={makeFilters({ scope: 'all' })} />);
    const grupoMeses = container.querySelector('[aria-hidden="true"]');
    expect(grupoMeses?.className).toContain('pointer-events-none');
    expect(grupoMeses?.className).toContain('opacity-40');
    // `disabled` é o que impede o TAB de alcançar um controle aria-hidden (WCAG 4.1.2).
    // Sem ele, teclado e leitor de tela discordariam sobre o que existe na tela.
    const meses = Array.from(grupoMeses?.querySelectorAll('button') ?? []);
    expect(meses).toHaveLength(12);
    expect(meses.every((b) => b.disabled)).toBe(true);
  });

  it('no escopo "mês" os botões de mês continuam habilitados', () => {
    const { container } = render(<DashboardHeader {...base} filters={makeFilters()} />);
    const meses = Array.from(container.querySelectorAll('button[aria-label^="Mês "]'));
    expect(meses).toHaveLength(12);
    expect(meses.every((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('alterna o escopo', () => {
    const filters = makeFilters();
    render(<DashboardHeader {...base} filters={filters} />);
    expect(screen.getByRole('button', { name: 'Este mês' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Todas as contas' }));
    expect(filters.setScope).toHaveBeenCalledWith('all');
  });

  it('sem filtro de KPI não há indicador; com filtro, o ✕ limpa', () => {
    const { rerender } = render(<DashboardHeader {...base} filters={makeFilters()} />);
    expect(screen.queryByText(/filtrando:/i)).not.toBeInTheDocument();

    const comFiltro = makeFilters({ filter: 'aVencer' });
    rerender(<DashboardHeader {...base} filters={comFiltro} />);
    const chip = screen.getByText(/filtrando: A vencer/i);
    expect(chip).toBeInTheDocument();
    fireEvent.click(chip);
    expect(comFiltro.clearFilter).toHaveBeenCalledTimes(1);
  });

  it('"Atualizar" dispara o reload e fica desabilitado enquanto carrega', () => {
    const onRefresh = vi.fn();
    const { rerender } = render(<DashboardHeader {...base} filters={makeFilters()} onRefresh={onRefresh} />);
    const btn = screen.getByRole('button', { name: /Atualizar/i });
    fireEvent.click(btn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(btn).not.toBeDisabled();

    rerender(<DashboardHeader {...base} filters={makeFilters()} loading onRefresh={onRefresh} />);
    expect(screen.getByRole('button', { name: /Atualizar/i })).toBeDisabled();
  });
});
