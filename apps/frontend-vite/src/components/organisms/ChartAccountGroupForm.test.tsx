import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SelectOption } from '../atoms/LabeledSelect';
import ChartAccountGroupForm from './ChartAccountGroupForm';

const typeGroupOptions: SelectOption[] = [
  { value: 0, label: 'Não informado' },
  { value: 1, label: 'Receitas' },
  { value: 2, label: 'Despesas' },
];

function setup() {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(
    <ChartAccountGroupForm
      mode="create"
      typeGroupOptions={typeGroupOptions}
      onSubmit={onSubmit}
      onCancel={vi.fn()}
    />,
  );
  return { onSubmit };
}

describe('ChartAccountGroupForm', () => {
  it('renderiza os campos (com o select de Natureza)', () => {
    setup();
    expect(screen.getByLabelText('Código')).toBeInTheDocument();
    expect(screen.getByLabelText('Descrição')).toBeInTheDocument();
    expect(screen.getByLabelText('Natureza')).toBeInTheDocument();
  });

  it('exige código e descrição ao submeter vazio', async () => {
    const { onSubmit } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    expect(await screen.findByText('Código é obrigatório')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submete com Natureza no default 0 (Não informado) quando não selecionada', async () => {
    const { onSubmit } = setup();
    await userEvent.type(screen.getByLabelText('Código'), '1');
    await userEvent.type(screen.getByLabelText('Descrição'), 'Ativo');
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ group_code: '1', group_description: 'Ativo', type_group_id: 0 }),
    );
  });

  it('envia o type_group_id da Natureza selecionada', async () => {
    const { onSubmit } = setup();
    await userEvent.type(screen.getByLabelText('Código'), '2');
    await userEvent.type(screen.getByLabelText('Descrição'), 'Receitas');
    await userEvent.selectOptions(screen.getByLabelText('Natureza'), '1');
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ group_code: '2', group_description: 'Receitas', type_group_id: 1 }),
    );
  });

  it('editando com o lookup vazio, mantém a Natureza atual como opção (não reseta)', () => {
    render(
      <ChartAccountGroupForm
        mode="edit"
        typeGroupOptions={[]}
        defaultValues={{
          chart_account_group_id: 6,
          group_code: '6',
          group_description: 'Despesas Tributárias',
          group_type: null,
          type_group_id: 2,
          type_group: { type_group_id: 2, type_group_description: 'Despesas' },
        }}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );
    const select = screen.getByLabelText<HTMLSelectElement>('Natureza');
    expect(screen.getByRole('option', { name: 'Despesas' })).toBeInTheDocument();
    expect(select.value).toBe('2');
  });
});
