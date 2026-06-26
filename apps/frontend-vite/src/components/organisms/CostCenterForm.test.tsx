import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CostCenterForm from './CostCenterForm';

function setup(mode: 'create' | 'edit' = 'create') {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();
  render(<CostCenterForm mode={mode} onSubmit={onSubmit} onCancel={onCancel} />);
  return { onSubmit, onCancel };
}

describe('CostCenterForm', () => {
  it('renderiza os campos e o botão de cadastro', () => {
    setup();
    expect(screen.getByLabelText('Código')).toBeInTheDocument();
    expect(screen.getByLabelText('Descrição')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cadastrar' })).toBeInTheDocument();
  });

  it('exige código e descrição ao submeter vazio', async () => {
    const { onSubmit } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    expect(await screen.findByText('Código é obrigatório')).toBeInTheDocument();
    expect(screen.getByText('Descrição é obrigatória')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submete com código e descrição preenchidos (com trim)', async () => {
    const { onSubmit } = setup();
    await userEvent.type(screen.getByLabelText('Código'), '  TI ');
    await userEvent.type(screen.getByLabelText('Descrição'), 'Tecnologia');
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ cost_center_code: 'TI', cost_center_description: 'Tecnologia' }),
    );
  });
});
