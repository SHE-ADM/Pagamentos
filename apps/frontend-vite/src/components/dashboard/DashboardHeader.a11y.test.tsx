// src/components/dashboard/DashboardHeader.a11y.test.tsx
// Regra 6 (WCAG 2.1 AA): todo componente relevante tem varredura axe. Cobre os dois
// estados que mudam a árvore acessível — sem filtro de KPI e com filtro (+ escopo 'all',
// que torna o grupo de meses aria-hidden).
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '../../../tests/axe';
import { DashboardHeader } from './DashboardHeader';

const noop = (): void => undefined;
const base = {
  title: 'Dashboard financeiro',
  subject: 'Contas a pagar',
  idPrefix: 'dashboard',
  month: 0,
  year: 2026,
  scope: 'month' as const,
  filter: 'total' as const,
  skCompany: undefined,
  companyOptions: [{ value: 1, label: 'OTIMOTEX TECIDOS' }],
  loading: false,
  onMonthChange: noop,
  onYearChange: noop,
  onScopeChange: noop,
  onClearFilter: noop,
  onCompanyChange: noop,
  onRefresh: noop,
};

describe('DashboardHeader — acessibilidade (WCAG AA)', () => {
  it('sem filtro de KPI, escopo "mês"', async () => {
    const { container } = render(<DashboardHeader {...base} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('com filtro de KPI e escopo "todas as contas" (meses aria-hidden)', async () => {
    const { container } = render(<DashboardHeader {...base} filter="aVencer" scope="all" skCompany={1} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
