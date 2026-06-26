import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FinancialAccountForm from './FinancialAccountForm';

const bankOptions = [{ value: 1, label: '001 — Banco do Brasil' }];
const statusOptions = [{ value: 1, label: 'pendente' }];

function setup() {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(
    <FinancialAccountForm
      mode="create"
      bankOptions={bankOptions}
      statusOptions={statusOptions}
      onSubmit={onSubmit}
      onCancel={vi.fn()}
    />,
  );
  return { onSubmit };
}

describe('FinancialAccountForm', () => {
  it('renderiza descrição, banco, situação e campos numéricos', () => {
    setup();
    expect(screen.getByLabelText('Descrição')).toBeInTheDocument();
    expect(screen.getByLabelText('Banco')).toBeInTheDocument();
    expect(screen.getByLabelText('Situação')).toBeInTheDocument();
    expect(screen.getByLabelText('Tipo de pagamento (código)')).toBeInTheDocument();
  });

  it('exige situação ao submeter sem seleção', async () => {
    const { onSubmit } = setup();
    await userEvent.type(screen.getByLabelText('Descrição'), 'Caixa');
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    expect(await screen.findByText('Situação é obrigatória')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submete com descrição + situação (defaults banco 0, moeda R$)', async () => {
    const { onSubmit } = setup();
    await userEvent.type(screen.getByLabelText('Descrição'), 'Caixa');
    await userEvent.selectOptions(screen.getByLabelText('Situação'), '1');
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        account_description: 'Caixa',
        bank_id: 0,
        status_id: 1,
        payment_type_id: 0,
        currency_code: 'R$',
        balance_amount: 0,
      }),
    );
  });
});
