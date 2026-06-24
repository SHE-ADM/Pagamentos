import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/suppliers', () => ({
  listSuppliers: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 }),
  createSupplier: vi.fn(),
}));

import SupplierSelect from './SupplierSelect';
import { createSupplier } from '../../services/suppliers';

describe('SupplierSelect', () => {
  it('renderiza o rótulo', () => {
    render(<SupplierSelect label="Fornecedor" value={null} onChange={vi.fn()} />);
    expect(screen.getByText('Fornecedor')).toBeInTheDocument();
  });

  it('exibe o fornecedor já selecionado (modo edição)', () => {
    render(<SupplierSelect label="Fornecedor" value={7} defaultLabel="ACME LTDA" onChange={vi.fn()} />);
    expect(screen.getByText('ACME LTDA')).toBeInTheDocument();
  });

  it('exibe mensagem quando a criação inline do fornecedor falha (não engole o erro)', async () => {
    vi.mocked(createSupplier).mockRejectedValueOnce(new Error('Falha ao criar fornecedor'));
    render(<SupplierSelect label="Fornecedor" value={null} onChange={vi.fn()} />);
    // Digita um nome novo e confirma com Enter — dispara onCreateOption → handleCreate.
    await userEvent.type(screen.getByRole('combobox'), 'Fornecedor Novo');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText('Falha ao criar fornecedor')).toBeInTheDocument();
  });
});
