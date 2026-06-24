import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '../../tests/axe';

vi.mock('../services/contas', () => ({ createConta: vi.fn() }));
vi.mock('../components/molecules/SupplierSelect', () => ({
  default: ({ label }: { label: string }) => (
    <label>
      {label}
      <input aria-label={label} />
    </label>
  ),
}));

vi.mock('../components/molecules/CostCenterSelect', () => ({
  default: ({ label }: { label: string }) => (
    <label>
      {label}
      <input aria-label={label} />
    </label>
  ),
}));
vi.mock('../components/molecules/ChartAccountSelect', () => ({
  default: ({ label }: { label: string }) => (
    <label>
      {label}
      <input aria-label={label} />
    </label>
  ),
}));

import ContasNovaPage from './ContasNovaPage';

describe('ContasNovaPage a11y', () => {
  it('não tem violações de acessibilidade', async () => {
    const { container } = render(<ContasNovaPage />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
