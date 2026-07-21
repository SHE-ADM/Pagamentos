// src/components/dashboard/DashboardHeader.test.tsx
// Contrato do cabeçalho compartilhado pelos dois dashboards. Cobre o que as páginas
// delegaram a ele: identidade (título/assunto/id do select), os 5 controles e o ✕ do
// filtro de KPI. As páginas seguem testando a INTEGRAÇÃO (o reload com os argumentos
// certos); aqui fica a unidade.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DashboardHeader } from './DashboardHeader';
import { MONTHS_FULL } from './constants';

const noop = (): void => undefined;
const base = {
  title: 'Indicadores financeiros',
  subject: 'Despesas',
  idPrefix: 'dashboard-financeiro',
  month: 6,
  year: 2026,
  scope: 'month' as const,
  filter: 'total' as const,
  skCompany: undefined,
  companyOptions: [
    { value: 1, label: 'OTIMOTEX TECIDOS' },
    { value: 2, label: 'LEBIANCO' },
  ],
  loading: false,
  onMonthChange: noop,
  onYearChange: noop,
  onScopeChange: noop,
  onClearFilter: noop,
  onCompanyChange: noop,
  onRefresh: noop,
};

describe('DashboardHeader', () => {
  it('mostra título e o assunto do período no subtítulo', () => {
    render(<DashboardHeader {...base} />);
    expect(screen.getByRole('heading', { name: 'Indicadores financeiros' })).toBeInTheDocument();
    expect(screen.getByText(`Despesas · ${MONTHS_FULL[6]} 2026`, { exact: false })).toBeInTheDocument();
  });

  it('no escopo "all" o subtítulo troca o mês por "Todas as contas"', () => {
    render(<DashboardHeader {...base} scope="all" />);
    expect(screen.getByText('Despesas · Todas as contas', { exact: false })).toBeInTheDocument();
  });

  it('o <select> de empresa recebe id/name derivados do idPrefix (autofill separado por página)', () => {
    render(<DashboardHeader {...base} />);
    const sel = screen.getByLabelText('Filtrar por empresa');
    expect(sel).toHaveAttribute('id', 'dashboard-financeiro-company');
    expect(sel).toHaveAttribute('name', 'dashboard-financeiro-company');
  });

  it('escolher empresa devolve o sk; voltar a "Empresa" devolve undefined (= TODAS)', () => {
    const onCompanyChange = vi.fn();
    render(<DashboardHeader {...base} onCompanyChange={onCompanyChange} />);
    const sel = screen.getByLabelText('Filtrar por empresa');
    fireEvent.change(sel, { target: { value: '2' } });
    expect(onCompanyChange).toHaveBeenLastCalledWith(2);
    fireEvent.change(sel, { target: { value: '' } });
    expect(onCompanyChange).toHaveBeenLastCalledWith(undefined);
  });

  it('mês e ano avisam a página e marcam o selecionado', () => {
    const onMonthChange = vi.fn();
    const onYearChange = vi.fn();
    render(<DashboardHeader {...base} onMonthChange={onMonthChange} onYearChange={onYearChange} />);
    expect(screen.getByLabelText(`Mês ${MONTHS_FULL[6]}`)).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByLabelText(`Mês ${MONTHS_FULL[0]}`));
    expect(onMonthChange).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByRole('button', { name: '2025' }));
    expect(onYearChange).toHaveBeenCalledWith(2025);
  });

  it('no escopo "all" os meses ficam inertes, fora do foco E fora do leitor de tela', () => {
    const { container } = render(<DashboardHeader {...base} scope="all" />);
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
    const { container } = render(<DashboardHeader {...base} />);
    const meses = Array.from(container.querySelectorAll('button[aria-label^="Mês "]'));
    expect(meses).toHaveLength(12);
    expect(meses.every((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('alterna o escopo', () => {
    const onScopeChange = vi.fn();
    render(<DashboardHeader {...base} onScopeChange={onScopeChange} />);
    expect(screen.getByRole('button', { name: 'Este mês' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Todas as contas' }));
    expect(onScopeChange).toHaveBeenCalledWith('all');
  });

  it('sem filtro de KPI não há indicador; com filtro, o ✕ limpa', () => {
    const onClearFilter = vi.fn();
    const { rerender } = render(<DashboardHeader {...base} onClearFilter={onClearFilter} />);
    expect(screen.queryByText(/filtrando:/i)).not.toBeInTheDocument();

    rerender(<DashboardHeader {...base} filter="aVencer" onClearFilter={onClearFilter} />);
    const chip = screen.getByText(/filtrando: A vencer/i);
    expect(chip).toBeInTheDocument();
    fireEvent.click(chip);
    expect(onClearFilter).toHaveBeenCalledTimes(1);
  });

  it('"Atualizar" dispara o reload e fica desabilitado enquanto carrega', () => {
    const onRefresh = vi.fn();
    const { rerender } = render(<DashboardHeader {...base} onRefresh={onRefresh} />);
    const btn = screen.getByRole('button', { name: /Atualizar/i });
    fireEvent.click(btn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(btn).not.toBeDisabled();

    rerender(<DashboardHeader {...base} loading onRefresh={onRefresh} />);
    expect(screen.getByRole('button', { name: /Atualizar/i })).toBeDisabled();
  });
});
