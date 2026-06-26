import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChartAccountGroupForm from './ChartAccountGroupForm';

function setup() {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<ChartAccountGroupForm mode="create" onSubmit={onSubmit} onCancel={vi.fn()} />);
  return { onSubmit };
}

describe('ChartAccountGroupForm', () => {
  it('renderiza os campos', () => {
    setup();
    expect(screen.getByLabelText('Código')).toBeInTheDocument();
    expect(screen.getByLabelText('Descrição')).toBeInTheDocument();
    expect(screen.getByLabelText('Tipo (1 caractere)')).toBeInTheDocument();
  });

  it('exige código e descrição ao submeter vazio', async () => {
    const { onSubmit } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    expect(await screen.findByText('Código é obrigatório')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submete com código e descrição (tipo opcional omitido)', async () => {
    const { onSubmit } = setup();
    await userEvent.type(screen.getByLabelText('Código'), '1');
    await userEvent.type(screen.getByLabelText('Descrição'), 'Ativo');
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ group_code: '1', group_description: 'Ativo' }));
  });
});
