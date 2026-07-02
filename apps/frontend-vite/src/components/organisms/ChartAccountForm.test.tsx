import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChartAccountForm from './ChartAccountForm';

const costCenterOptions = [{ value: 1, label: 'ADM — Administrativo' }];
const groupOptions = [{ value: 1, label: '1 — Ativo' }];
const subgroupOptions = [{ value: 1, label: '1.1 — Ativo Circulante' }];

function setup() {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(
    <ChartAccountForm
      mode="create"
      costCenterOptions={costCenterOptions}
      groupOptions={groupOptions}
      subgroupOptions={subgroupOptions}
      onSubmit={onSubmit}
      onCancel={vi.fn()}
    />,
  );
  return { onSubmit };
}

describe('ChartAccountForm', () => {
  it('renderiza campos, selects (com "não informado") e checkbox', () => {
    setup();
    expect(screen.getByLabelText('Código')).toBeInTheDocument();
    expect(screen.getByLabelText('Centro de custo')).toBeInTheDocument();
    expect(screen.getByLabelText('Grupo')).toBeInTheDocument();
    expect(screen.getByLabelText('Subgrupo')).toBeInTheDocument();
    expect(screen.getByLabelText('Lançável (postável)')).toBeInTheDocument();
  });

  it('resetSignal (lançamento rápido): limpa só a descrição e foca o código', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ChartAccountForm
        mode="create"
        costCenterOptions={costCenterOptions}
        groupOptions={groupOptions}
        subgroupOptions={subgroupOptions}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        resetSignal={0}
      />,
    );

    const codigo = screen.getByLabelText('Código');
    const descricao = screen.getByLabelText('Descrição');
    await userEvent.type(codigo, '1.1.01');
    await userEvent.type(descricao, 'Clientes');

    // Simula uma criação bem-sucedida: o CrudTablePage incrementa o resetSignal.
    rerender(
      <ChartAccountForm
        mode="create"
        costCenterOptions={costCenterOptions}
        groupOptions={groupOptions}
        subgroupOptions={subgroupOptions}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        resetSignal={1}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText('Descrição')).toHaveValue(''));
    // Código é preservado (não é limpo) e recebe o foco.
    expect(screen.getByLabelText('Código')).toHaveValue('1.1.01');
    expect(screen.getByLabelText('Código')).toHaveFocus();
  });

  it('submete com defaults (FKs = 0, nível 2, postável)', async () => {
    const { onSubmit } = setup();
    await userEvent.type(screen.getByLabelText('Código'), '1.1.01');
    await userEvent.type(screen.getByLabelText('Descrição'), 'Clientes');
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        account_code: '1.1.01',
        account_description: 'Clientes',
        account_level: 2,
        is_postable: true,
        cost_center_id: 0,
        chart_account_group_id: 0,
        chart_account_subgroup_id: 0,
      }),
    );
  });
});
