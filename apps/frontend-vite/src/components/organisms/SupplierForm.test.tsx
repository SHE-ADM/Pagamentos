import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SupplierForm from './SupplierForm';

function setup(mode: 'create' | 'edit' = 'create') {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();
  render(<SupplierForm mode={mode} onSubmit={onSubmit} onCancel={onCancel} />);
  return { onSubmit, onCancel };
}

describe('SupplierForm', () => {
  it('renderiza os campos principais e o botão de cadastro', () => {
    setup();
    expect(screen.getByLabelText('Razão social')).toBeInTheDocument();
    expect(screen.getByLabelText('Nome fantasia')).toBeInTheDocument();
    expect(screen.getByLabelText('CNPJ (só dígitos)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cadastrar' })).toBeInTheDocument();
  });

  it('exige ao menos um identificador ao submeter vazio', async () => {
    const { onSubmit } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    expect(await screen.findByText(/ao menos um identificador/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submete com um identificador preenchido', async () => {
    const { onSubmit } = setup();
    await userEvent.type(screen.getByLabelText('Nome fantasia'), 'ACME');
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ trade_name: 'ACME' }));
  });

  it('valida o formato de e-mail', async () => {
    const { onSubmit } = setup();
    await userEvent.type(screen.getByLabelText('Nome fantasia'), 'ACME');
    await userEvent.type(screen.getByLabelText('E-mail'), 'invalido');
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    expect(await screen.findByText('E-mail inválido')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
