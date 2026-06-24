import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from '../../../tests/axe';

vi.mock('../../services/lookups', () => ({
  listCostCenters: vi.fn().mockResolvedValue([]),
  listChartAccounts: vi.fn(),
}));

import CostCenterSelect from './CostCenterSelect';

describe('CostCenterSelect a11y', () => {
  it('não tem violações de acessibilidade', async () => {
    const { container } = render(<CostCenterSelect label="Centro de custo" value={null} onChange={vi.fn()} />);
    await screen.findByText('Centro de custo');
    expect(await axe(container)).toHaveNoViolations();
  });
});
