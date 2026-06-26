import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from '../../tests/axe';
import type { CostCenter } from '@sheild/shared';

vi.mock('../services/costCenters', () => ({
  listCostCentersPage: vi.fn(),
  createCostCenter: vi.fn(),
  updateCostCenter: vi.fn(),
  deleteCostCenter: vi.fn(),
}));

import CostCentersPage from './CostCentersPage';
import { listCostCentersPage } from '../services/costCenters';

const sample: CostCenter = {
  cost_center_id: 5,
  cost_center_code: 'TI',
  cost_center_description: 'Tecnologia da Informação',
};

beforeEach(() => {
  vi.mocked(listCostCentersPage).mockResolvedValue({ data: [sample], total: 1, page: 1, limit: 20 });
});

describe('CostCentersPage a11y', () => {
  it('não tem violações de acessibilidade', async () => {
    const { container } = render(<CostCentersPage />);
    await screen.findByText('Tecnologia da Informação');
    expect(await axe(container)).toHaveNoViolations();
  });
});
