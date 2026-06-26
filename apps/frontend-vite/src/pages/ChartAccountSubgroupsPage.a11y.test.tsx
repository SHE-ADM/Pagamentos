import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from '../../tests/axe';
import type { ChartAccountSubgroup } from '@sheild/shared';

vi.mock('../services/chartAccountSubgroups', () => ({
  listChartAccountSubgroupsPage: vi.fn(),
  createChartAccountSubgroup: vi.fn(),
  updateChartAccountSubgroup: vi.fn(),
}));
vi.mock('../services/lookups', () => ({ listChartAccountGroups: vi.fn().mockResolvedValue([]) }));

import ChartAccountSubgroupsPage from './ChartAccountSubgroupsPage';
import { listChartAccountSubgroupsPage } from '../services/chartAccountSubgroups';

const sample: ChartAccountSubgroup = {
  chart_account_subgroup_id: 1,
  chart_account_group_id: 1,
  subgroup_code: '1.1',
  subgroup_description: 'Ativo Circulante',
};

beforeEach(() => {
  vi.mocked(listChartAccountSubgroupsPage).mockResolvedValue({ data: [sample], total: 1, page: 1, limit: 20 });
});

describe('ChartAccountSubgroupsPage a11y', () => {
  it('não tem violações de acessibilidade', async () => {
    const { container } = render(<ChartAccountSubgroupsPage />);
    await screen.findByText('Ativo Circulante');
    expect(await axe(container)).toHaveNoViolations();
  });
});
