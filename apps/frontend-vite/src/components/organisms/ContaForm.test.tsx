import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Stub do SupplierSelect (react-select) — clicar seta o sk_supplier = 1.
vi.mock('../molecules/SupplierSelect', () => ({
  default: ({ label, error, onChange }: { label: string; error?: string; onChange: (sk: number | null) => void }) => (
    <div>
      <button type="button" aria-label={label} onClick={() => onChange(1)}>
        {label}
      </button>
      {error && <span>{error}</span>}
    </div>
  ),
}));

// Stubs dos lookups (react-select async) — evitam o react-select + rede no teste.
vi.mock('../molecules/CostCenterSelect', () => ({
  default: ({ label }: { label: string }) => <input aria-label={label} />,
}));
vi.mock('../molecules/ChartAccountSelect', () => ({
  default: ({ label }: { label: string }) => <input aria-label={label} />,
}));

import ContaForm from './ContaForm';

function setup() {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<ContaForm mode="create" onSubmit={onSubmit} />);
  return { onSubmit };
}

describe('ContaForm', () => {
  it('renderiza os campos principais', () => {
    setup();
    expect(screen.getByLabelText('Valor (R$)')).toBeInTheDocument();
    expect(screen.getByLabelText('Tipo de documento')).toBeInTheDocument();
    expect(screen.getByLabelText('Tipo de pagamento')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lançar conta' })).toBeInTheDocument();
  });

  it('exige fornecedor + tipo de documento + tipo de pagamento ao submeter vazio', async () => {
    const { onSubmit } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Lançar conta' }));
    expect(await screen.findByText('Selecione um fornecedor')).toBeInTheDocument();
    expect(screen.getByText('Selecione o tipo de documento')).toBeInTheDocument();
    expect(screen.getByText('Selecione o tipo de pagamento')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submete com fornecedor, valor e enums preenchidos', async () => {
    const { onSubmit } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Fornecedor' }));
    await userEvent.type(screen.getByLabelText('Valor (R$)'), '100');
    await userEvent.selectOptions(screen.getByLabelText('Tipo de documento'), 'boleto');
    await userEvent.selectOptions(screen.getByLabelText('Tipo de pagamento'), 'pix');
    await userEvent.click(screen.getByRole('button', { name: 'Lançar conta' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      sk_supplier: 1,
      amount: 100,
      document_type: 'boleto',
      payment_method: 'pix',
    });
  });
});
