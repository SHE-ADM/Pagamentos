import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '../../../tests/axe';

vi.mock('../molecules/SupplierSelect', () => ({
  default: ({ label }: { label: string }) => (
    <label>
      {label}
      <input aria-label={label} />
    </label>
  ),
}));

vi.mock('../molecules/CostCenterSelect', () => ({
  default: ({ label }: { label: string }) => (
    <label>
      {label}
      <input aria-label={label} />
    </label>
  ),
}));
vi.mock('../molecules/ChartAccountSelect', () => ({
  default: ({ label }: { label: string }) => (
    <label>
      {label}
      <input aria-label={label} />
    </label>
  ),
}));

import ContaForm from './ContaForm';

describe('ContaForm a11y', () => {
  it('não tem violações de acessibilidade', async () => {
    const { container } = render(<ContaForm mode="create" onSubmit={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
