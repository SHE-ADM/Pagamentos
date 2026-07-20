import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChartAccountSubgroupForm from './ChartAccountSubgroupForm';

const groupOptions = [
  { value: 1, label: '1 — Ativo' },
  { value: 2, label: '2 — Passivo' },
];

const typeGroupOptions = [
  { value: 0, label: 'Não informado' },
  { value: 5, label: 'Despesas Fixas' },
  { value: 6, label: 'Despesas Variáveis' },
];

function setup() {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(
    <ChartAccountSubgroupForm
      mode="create"
      groupOptions={groupOptions}
      typeGroupOptions={typeGroupOptions}
      onSubmit={onSubmit}
      onCancel={vi.fn()}
    />,
  );
  return { onSubmit };
}

describe('ChartAccountSubgroupForm', () => {
  it('renderiza os campos e os selects de grupo e Tipo', () => {
    setup();
    expect(screen.getByLabelText('Código')).toBeInTheDocument();
    expect(screen.getByLabelText('Descrição')).toBeInTheDocument();
    expect(screen.getByLabelText('Grupo')).toBeInTheDocument();
    expect(screen.getByLabelText('Tipo')).toBeInTheDocument();
  });

  it('exige grupo ao submeter sem seleção', async () => {
    const { onSubmit } = setup();
    await userEvent.type(screen.getByLabelText('Código'), '1.1');
    await userEvent.type(screen.getByLabelText('Descrição'), 'Ativo Circulante');
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    expect(await screen.findByText('Grupo é obrigatório')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submete com grupo selecionado e Tipo no default 0 (Não informado)', async () => {
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
        type_group_id: 0,
      }),
    );
  });

  it('envia o type_group_id do Tipo selecionado', async () => {
    const { onSubmit } = setup();
    await userEvent.type(screen.getByLabelText('Código'), '62.1');
    await userEvent.type(screen.getByLabelText('Descrição'), 'Salários');
    await userEvent.selectOptions(screen.getByLabelText('Grupo'), '1');
    await userEvent.selectOptions(screen.getByLabelText('Tipo'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        subgroup_code: '62.1',
        subgroup_description: 'Salários',
        chart_account_group_id: 1,
        type_group_id: 5,
      }),
    );
  });

  it('editando com o lookup de Tipo vazio, mantém o Tipo atual como opção (não reseta)', () => {
    render(
      <ChartAccountSubgroupForm
        mode="edit"
        groupOptions={groupOptions}
        typeGroupOptions={[]}
        defaultValues={{
          chart_account_subgroup_id: 62,
          chart_account_group_id: 1,
          subgroup_code: '62.1',
          subgroup_description: 'Salários',
          type_group_id: 5,
          type_group: { type_group_id: 5, type_group_description: 'Despesas Fixas' },
        }}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );
    const select = screen.getByLabelText<HTMLSelectElement>('Tipo');
    expect(screen.getByRole('option', { name: 'Despesas Fixas' })).toBeInTheDocument();
    expect(select.value).toBe('5');
  });
});
