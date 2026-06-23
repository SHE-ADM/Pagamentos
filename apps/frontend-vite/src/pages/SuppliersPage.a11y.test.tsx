import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from '../../tests/axe';
import type { Supplier } from '@sheild/shared';

vi.mock('../services/suppliers', () => ({
  listSuppliers: vi.fn(),
  createSupplier: vi.fn(),
  updateSupplier: vi.fn(),
}));

import SuppliersPage from './SuppliersPage';
import { listSuppliers } from '../services/suppliers';

const sample: Supplier = {
  sk_supplier: 1,
  supplier_id: 1,
  legal_name: 'ACME LTDA',
  trade_name: 'ACME',
  cnpj: '12345678000199',
  cpf: null,
  email: 'contato@acme.com',
  email2: null,
  email3: null,
  email4: null,
  deleted_at: null,
};

beforeEach(() => {
  vi.mocked(listSuppliers).mockResolvedValue({ data: [sample], total: 1, page: 1, limit: 20 });
});

describe('SuppliersPage a11y', () => {
  it('não tem violações de acessibilidade', async () => {
    const { container } = render(<SuppliersPage />);
    await screen.findByText('ACME LTDA');
    expect(await axe(container)).toHaveNoViolations();
  });
});
