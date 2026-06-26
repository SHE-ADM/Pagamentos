import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChartAccountSubgroupForm from './ChartAccountSubgroupForm';

const groupOptions = [
  { value: 1, label: '1 — Ativo' },
  { value: 2, label: '2 — Passivo' },
];

function setup() {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(
    <ChartAccountSubgroupForm mode="create" groupOptions={groupOptions} onSubmit={onSubmit} onCancel={vi.fn()} />,
  );
  return { onSubmit };
}

describe('ChartAccountSubgroupForm', () => {
  it('renderiza os campos e o select de grupo', () => {
    setup();
    expect(screen.getByLabelText('Código')).toBeInTheDocument();
    expect(screen.getByLabelText('Descrição')).toBeInTheDocument();
    expect(screen.getByLabelText('Grupo')).toBeInTheDocument();
  });

  it('exige grupo ao submeter sem seleção', async () => {
    const { onSubmit } = setup();
    await userEvent.type(screen.getByLabelText('Código'), '1.1');
    await userEvent.type(screen.getByLabelText('Descrição'), 'Ativo Circulante');
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    expect(await screen.findByText('Grupo é obrigatório')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submete com grupo selecionado', async () => {
    const { onSubmit } = setup();
    await userEvent.type(screen.getByLabelText('Código'), '1.1');
    await userEvent.type(screen.getByLabelText('Descrição'), 'Ativo Circulante');
    await userEvent.selectOptions(screen.getByLabelText('Grupo'), '1');
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        subgroup_code: '1.1',
        subgroup_description: 'Ativo Circulante',
        chart_account_group_id: 1,
      }),
    );
  });
});
