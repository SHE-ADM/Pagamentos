import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from '../../tests/axe';
import type { ChartAccount } from '@sheild/shared';

vi.mock('../services/chartAccounts', () => ({
  listChartAccountsPage: vi.fn(),
  createChartAccount: vi.fn(),
  updateChartAccount: vi.fn(),
}));
vi.mock('../services/lookups', () => ({
  listCostCenters: vi.fn().mockResolvedValue([]),
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
  account_level: 2,
  is_postable: true,
};

beforeEach(() => {
  vi.mocked(listChartAccountsPage).mockResolvedValue({ data: [sample], total: 1, page: 1, limit: 20 });
});

describe('ChartAccountsPage a11y', () => {
  it('não tem violações de acessibilidade', async () => {
    const { container } = render(<ChartAccountsPage />);
    await screen.findByText('Clientes');
    expect(await axe(container)).toHaveNoViolations();
  });
});
