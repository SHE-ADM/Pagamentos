import { describe, it, expect, vi, beforeEach } from 'vitest';

// useAuth (gate isAdminGroup do hard delete) — mock: sem grupo Administrador nestes testes.
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: null, session: null, loading: false, isAdmin: false, groupId: 0, isAdminGroup: false, signOut: vi.fn() }),
}));
import { render, screen } from '@testing-library/react';
import { axe } from '../../tests/axe';
import type { ChartAccountGroup } from '@sheild/shared';

vi.mock('../services/chartAccountGroups', () => ({
  listChartAccountGroupsPage: vi.fn(),
  createChartAccountGroup: vi.fn(),
  updateChartAccountGroup: vi.fn(),
}));
vi.mock('../services/lookups', () => ({
  listFinancialTypeGroups: vi
    .fn()
    .mockResolvedValue([{ type_group_id: 3, type_group_description: 'Ativo' }]),
}));

import ChartAccountGroupsPage from './ChartAccountGroupsPage';
import { listChartAccountGroupsPage } from '../services/chartAccountGroups';

const sample: ChartAccountGroup = {
  chart_account_group_id: 1,
  group_code: '1',
  group_description: 'Disponibilidades',
  group_type: 'A',
  type_group_id: 3,
  type_group: { type_group_id: 3, type_group_description: 'Ativo' },
};

beforeEach(() => {
  vi.mocked(listChartAccountGroupsPage).mockResolvedValue({ data: [sample], total: 1, page: 1, limit: 20 });
});

describe('ChartAccountGroupsPage a11y', () => {
  it('não tem violações de acessibilidade', async () => {
    const { container } = render(<ChartAccountGroupsPage />);
    await screen.findByText('Disponibilidades');
    expect(await axe(container)).toHaveNoViolations();
  });
});
