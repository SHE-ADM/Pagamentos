import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from '../../tests/axe';
import type { ChartAccountGroup } from '@sheild/shared';

vi.mock('../services/chartAccountGroups', () => ({
  listChartAccountGroupsPage: vi.fn(),
  createChartAccountGroup: vi.fn(),
  updateChartAccountGroup: vi.fn(),
}));

import ChartAccountGroupsPage from './ChartAccountGroupsPage';
import { listChartAccountGroupsPage } from '../services/chartAccountGroups';

const sample: ChartAccountGroup = { chart_account_group_id: 1, group_code: '1', group_description: 'Ativo', group_type: 'A' };

beforeEach(() => {
  vi.mocked(listChartAccountGroupsPage).mockResolvedValue({ data: [sample], total: 1, page: 1, limit: 20 });
});

describe('ChartAccountGroupsPage a11y', () => {
  it('não tem violações de acessibilidade', async () => {
    const { container } = render(<ChartAccountGroupsPage />);
    await screen.findByText('Ativo');
    expect(await axe(container)).toHaveNoViolations();
  });
});
