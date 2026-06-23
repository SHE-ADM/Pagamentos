import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../services/suppliers', () => ({
  listSuppliers: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 }),
  createSupplier: vi.fn(),
}));

import SupplierSelect from './SupplierSelect';

describe('SupplierSelect', () => {
  it('renderiza o rótulo', () => {
    render(<SupplierSelect label="Fornecedor" value={null} onChange={vi.fn()} />);
    expect(screen.getByText('Fornecedor')).toBeInTheDocument();
  });

  it('exibe o fornecedor já selecionado (modo edição)', () => {
    render(<SupplierSelect label="Fornecedor" value={7} defaultLabel="ACME LTDA" onChange={vi.fn()} />);
    expect(screen.getByText('ACME LTDA')).toBeInTheDocument();
  });
});
