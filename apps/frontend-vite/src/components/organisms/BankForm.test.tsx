import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BankForm from './BankForm';

function setup() {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<BankForm mode="create" onSubmit={onSubmit} onCancel={vi.fn()} />);
  return { onSubmit };
}

describe('BankForm', () => {
  it('renderiza os campos e o botão', () => {
    setup();
    expect(screen.getByLabelText('Código (3 dígitos)')).toBeInTheDocument();
    expect(screen.getByLabelText('Nome')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cadastrar' })).toBeInTheDocument();
  });

  it('exige código e nome ao submeter vazio', async () => {
    const { onSubmit } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    expect(await screen.findByText('Código é obrigatório')).toBeInTheDocument();
    expect(screen.getByText('Nome é obrigatório')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submete com código e nome', async () => {
    const { onSubmit } = setup();
    await userEvent.type(screen.getByLabelText('Código (3 dígitos)'), '001');
    await userEvent.type(screen.getByLabelText('Nome'), 'Banco do Brasil');
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ bank_code: '001', bank_name: 'Banco do Brasil' }));
  });
});
