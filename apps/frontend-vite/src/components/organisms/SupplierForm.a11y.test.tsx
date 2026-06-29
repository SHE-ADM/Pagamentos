import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '../../../tests/axe';

// Stubs dos lookups async (react-select) — evitam rede no teste de a11y.
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

import SupplierForm from './SupplierForm';

describe('SupplierForm a11y', () => {
  it('não tem violações de acessibilidade (modo criação)', async () => {
    const { container } = render(
      <SupplierForm mode="create" onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
