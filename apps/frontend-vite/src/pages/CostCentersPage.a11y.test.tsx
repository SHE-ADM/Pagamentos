import { describe, it, expect, vi, beforeEach } from 'vitest';

// useAuth (gate isAdminGroup do hard delete) — mock: sem grupo Administrador nestes testes.
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: null, session: null, loading: false, isAdmin: false, groupId: 0, isAdminGroup: false, signOut: vi.fn() }),
}));
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from '../../tests/axe';
import type { CostCenter, ChartAccount } from '@sheild/shared';

vi.mock('../services/costCenters', () => ({
  listCostCentersPage: vi.fn(),
  createCostCenter: vi.fn(),
  updateCostCenter: vi.fn(),
  deleteCostCenter: vi.fn(),
}));

vi.mock('../services/chartAccounts', () => ({
  listChartAccountsByCostCenter: vi.fn(),
}));

import CostCentersPage from './CostCentersPage';
import { listCostCentersPage } from '../services/costCenters';
import { listChartAccountsByCostCenter } from '../services/chartAccounts';

const sample: CostCenter = {
  cost_center_id: 5,
  cost_center_code: 'TI',
  cost_center_description: 'Tecnologia da Informação',
};

const chartAccount: ChartAccount = {
  chart_account_id: 12,
  account_code: '3.1.01',
  account_description: 'Serviços de TI',
  cost_center_id: 5,
  chart_account_group_id: 2,
  chart_account_subgroup_id: 4,
  account_level: 3,
  is_postable: true,
  group: { group_code: 'G2', group_description: 'Despesas' },
  subgroup: { subgroup_code: 'S4', subgroup_description: 'Operacionais' },
};

beforeEach(() => {
  vi.mocked(listCostCentersPage).mockResolvedValue({ data: [sample], total: 1, page: 1, limit: 20 });
  vi.mocked(listChartAccountsByCostCenter).mockResolvedValue({ data: [chartAccount], total: 1, page: 1, limit: 20 });
});

describe('CostCentersPage a11y', () => {
  it('não tem violações de acessibilidade', async () => {
    const { container } = render(<CostCentersPage />);
    await screen.findByText('Tecnologia da Informação');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('não tem violações com o grid complementar visível', async () => {
    const { container } = render(<CostCentersPage />);
    await userEvent.click(await screen.findByText('Tecnologia da Informação'));
    await screen.findByText('Serviços de TI');
    expect(await axe(container)).toHaveNoViolations();
  });
});
