import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const listMock = vi.mocked(listSuppliers);

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue({ data: [sample], total: 1, page: 1, limit: 20 });
});

describe('SuppliersPage', () => {
  it('lista os fornecedores carregados', async () => {
    render(<SuppliersPage />);
    expect(await screen.findByText('ACME LTDA')).toBeInTheDocument();
    expect(listMock).toHaveBeenCalled();
  });

  it('abre o modal ao clicar em "Novo fornecedor"', async () => {
    render(<SuppliersPage />);
    await screen.findByText('ACME LTDA');
    await userEvent.click(screen.getByRole('button', { name: /novo fornecedor/i }));
    // jsdom não implementa <dialog>.showModal — o conteúdo fica hidden na a11y tree.
    expect(await screen.findByRole('button', { name: 'Cadastrar', hidden: true })).toBeInTheDocument();
  });
});
