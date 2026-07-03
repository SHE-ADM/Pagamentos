import { describe, it, expect, vi, beforeEach } from 'vitest';

// useAuth (gate isAdminGroup do hard delete) — mock: sem grupo Administrador nestes testes.
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: null, session: null, loading: false, isAdmin: false, groupId: 0, isAdminGroup: false, signOut: vi.fn() }),
}));
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChartAccount } from '@sheild/shared';

vi.mock('../services/chartAccounts', () => ({
  listChartAccountsPage: vi.fn(),
  createChartAccount: vi.fn(),
  updateChartAccount: vi.fn(),
}));
vi.mock('../services/lookups', () => ({
  listCostCenters: vi.fn().mockResolvedValue([]),
  listChartAccountGroups: vi.fn().mockResolvedValue([]),
  listChartAccountSubgroups: vi.fn().mockResolvedValue([]),
}));

import ChartAccountsPage from './ChartAccountsPage';
import { listChartAccountsPage } from '../services/chartAccounts';

const sample: ChartAccount = {
  chart_account_id: 1,
  account_code: '1.1.01',
  account_description: 'Clientes',
  cost_center_id: 0,
  chart_account_subgroup_id: 0,
  chart_account_group_id: 0,
  account_level: 2,
  is_postable: true,
};

beforeEach(() => {
  vi.mocked(listChartAccountsPage).mockReset();
  vi.mocked(listChartAccountsPage).mockResolvedValue({ data: [sample], total: 1, page: 1, limit: 20 });
});

describe('ChartAccountsPage', () => {
  it('lista os planos de contas carregados', async () => {
    render(<ChartAccountsPage />);
    expect(await screen.findByText('Clientes')).toBeInTheDocument();
  });

  it('abre o modal ao clicar em "Novo plano de contas"', async () => {
    render(<ChartAccountsPage />);
    await screen.findByText('Clientes');
    await userEvent.click(screen.getByRole('button', { name: /novo plano de contas/i }));
    expect(await screen.findByRole('button', { name: 'Cadastrar', hidden: true })).toBeInTheDocument();
  });
});
