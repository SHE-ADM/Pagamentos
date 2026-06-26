import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChartAccountForm from './ChartAccountForm';

const costCenterOptions = [{ value: 1, label: 'ADM — Administrativo' }];
const subgroupOptions = [{ value: 1, label: '1.1 — Ativo Circulante' }];

function setup() {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(
    <ChartAccountForm
      mode="create"
      costCenterOptions={costCenterOptions}
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
    expect(screen.getByLabelText('Subgrupo')).toBeInTheDocument();
    expect(screen.getByLabelText('Lançável (postável)')).toBeInTheDocument();
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
        chart_account_subgroup_id: 0,
      }),
    );
  });
});
