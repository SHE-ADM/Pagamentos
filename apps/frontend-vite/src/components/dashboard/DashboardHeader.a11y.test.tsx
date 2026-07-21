// src/components/dashboard/DashboardHeader.a11y.test.tsx
// Regra 6 (WCAG 2.1 AA): todo componente relevante tem varredura axe. Cobre os dois
// estados que mudam a árvore acessível — sem filtro de KPI e com filtro (+ escopo 'all',
// que torna o grupo de meses aria-hidden e seus botões disabled).
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '../../../tests/axe';
import { DashboardHeader } from './DashboardHeader';
import type { DashboardFilters } from '../../hooks/useDashboardFilters';

const makeFilters = (over: Partial<DashboardFilters> = {}): DashboardFilters => ({
  month: 0,
  year: 2026,
  scope: 'month',
  filter: 'total',
  skCompany: undefined,
  companyOptions: [{ value: 1, label: 'OTIMOTEX TECIDOS' }],
  setMonth: vi.fn(),
  setYear: vi.fn(),
  setScope: vi.fn(),
  setSkCompany: vi.fn(),
  toggleFilter: vi.fn(),
  clearFilter: vi.fn(),
  ...over,
});

const base = {
  title: 'Dashboard financeiro',
  subject: 'Contas a pagar',
  idPrefix: 'dashboard',
  loading: false,
  onRefresh: (): void => undefined,
};

describe('DashboardHeader — acessibilidade (WCAG AA)', () => {
  it('sem filtro de KPI, escopo "mês"', async () => {
    const { container } = render(<DashboardHeader {...base} filters={makeFilters()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('com filtro de KPI e escopo "todas as contas" (meses aria-hidden + disabled)', async () => {
    const filters = makeFilters({ filter: 'aVencer', scope: 'all', skCompany: 1 });
    const { container } = render(<DashboardHeader {...base} filters={filters} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
