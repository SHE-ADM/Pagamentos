import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from '../../../tests/axe';

vi.mock('../../services/suppliers', () => ({
  listSuppliers: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 }),
  createSupplier: vi.fn(),
}));

import SupplierSelect from './SupplierSelect';

describe('SupplierSelect a11y', () => {
  it('não tem violações de acessibilidade', async () => {
    const { container } = render(<SupplierSelect label="Fornecedor" value={null} onChange={vi.fn()} />);
    await screen.findByText('Fornecedor');
    expect(await axe(container)).toHaveNoViolations();
  });
});
