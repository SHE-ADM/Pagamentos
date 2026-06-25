import { describe, it, expect, vi, beforeEach } from 'vitest';
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
// Expõem value/defaultLabel em data-* para asserir o pré-preenchimento.
vi.mock('../molecules/CostCenterSelect', () => ({
  default: ({ label, value, defaultLabel }: { label: string; value: number | null; defaultLabel?: string }) => (
    <input aria-label={label} data-value={value ?? ''} data-default-label={defaultLabel ?? ''} readOnly />
  ),
}));
vi.mock('../molecules/ChartAccountSelect', () => ({
  default: ({ label, value, defaultLabel }: { label: string; value: number | null; defaultLabel?: string }) => (
    <input aria-label={label} data-value={value ?? ''} data-default-label={defaultLabel ?? ''} readOnly />
  ),
}));

// Stub do serviço — evita rede; o pré-preenchimento lê a classificação do fornecedor.
const getSupplierMock = vi.fn();
vi.mock('../../services/suppliers', () => ({
  getSupplier: (sk: number) => getSupplierMock(sk),
}));

import ContaForm from './ContaForm';

function setup() {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<ContaForm mode="create" onSubmit={onSubmit} />);
  return { onSubmit };
}

beforeEach(() => {
  // Padrão: fornecedor SEM classificação (não pré-preenche) — os testes que precisam
  // de classificação sobrescrevem com mockResolvedValueOnce.
  getSupplierMock.mockReset();
  getSupplierMock.mockResolvedValue({ sk_supplier: 1, cost_center_id: 0, chart_account_id: 0 });
});

describe('ContaForm', () => {
  it('renderiza os campos principais', () => {
    setup();
    expect(screen.getByLabelText('Valor (R$)')).toBeInTheDocument();
    expect(screen.getByLabelText('Tipo de documento')).toBeInTheDocument();
    expect(screen.getByLabelText('Tipo de pagamento')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lançar conta' })).toBeInTheDocument();
  });

  it('pré-preenche emissão e vencimento com a data de hoje na inclusão', () => {
    setup();
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(screen.getByLabelText('Emissão')).toHaveValue(today);
    expect(screen.getByLabelText('Vencimento')).toHaveValue(today);
  });

  it('exige fornecedor + tipo de documento + tipo de pagamento ao submeter vazio', async () => {
    const { onSubmit } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Lançar conta' }));
    expect(await screen.findByText('Selecione um fornecedor')).toBeInTheDocument();
    expect(screen.getByText('Selecione o tipo de documento')).toBeInTheDocument();
    expect(screen.getByText('Selecione o tipo de pagamento')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('pré-preenche centro de custo e plano de contas com o default do fornecedor', async () => {
    getSupplierMock.mockReset();
    getSupplierMock.mockResolvedValue({
      sk_supplier: 1,
      cost_center_id: 5,
      chart_account_id: 10,
      cost_center: { cost_center_code: 'CC', cost_center_description: 'Logística' },
      chart_account: { account_code: 'AC', account_description: 'Frete sobre vendas' },
    });
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Fornecedor' }));

    await waitFor(() => expect(getSupplierMock).toHaveBeenCalledWith(1));
    const cc = screen.getByLabelText('Centro de custo');
    const ca = screen.getByLabelText('Plano de contas');
    await waitFor(() => expect(cc).toHaveAttribute('data-value', '5'));
    expect(cc).toHaveAttribute('data-default-label', 'Logística');
    await waitFor(() => expect(ca).toHaveAttribute('data-value', '10'));
    expect(ca).toHaveAttribute('data-default-label', 'Frete sobre vendas');
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
