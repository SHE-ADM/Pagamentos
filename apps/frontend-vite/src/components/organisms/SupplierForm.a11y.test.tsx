import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '../../../tests/axe';
import SupplierForm from './SupplierForm';

describe('SupplierForm a11y', () => {
  it('não tem violações de acessibilidade (modo criação)', async () => {
    const { container } = render(
      <SupplierForm mode="create" onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
