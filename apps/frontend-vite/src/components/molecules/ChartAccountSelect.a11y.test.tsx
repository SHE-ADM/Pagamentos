import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from '../../../tests/axe';

vi.mock('../../services/lookups', () => ({
  listChartAccounts: vi.fn().mockResolvedValue([]),
  listCostCenters: vi.fn(),
}));

import ChartAccountSelect from './ChartAccountSelect';

describe('ChartAccountSelect a11y', () => {
  it('não tem violações de acessibilidade', async () => {
    const { container } = render(
      <ChartAccountSelect label="Plano de contas" value={null} costCenterId={1} onChange={vi.fn()} />,
    );
    await screen.findByText('Plano de contas');
    expect(await axe(container)).toHaveNoViolations();
  });
});
