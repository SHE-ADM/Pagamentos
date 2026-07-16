import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Stubs dos lookups (react-select async) — evitam o react-select + rede no teste.
// Um botão por select dispara onChange com um id fixo, simulando a seleção.
vi.mock('../molecules/CostCenterSelect', () => ({
  default: ({ label, onChange }: { label: string; onChange: (id: number | null) => void }) => (
    <button type="button" aria-label={label} onClick={() => onChange(5)}>
      {label}
    </button>
  ),
}));
vi.mock('../molecules/ChartAccountSelect', () => ({
  default: ({ label, onChange }: { label: string; onChange: (id: number | null) => void }) => (
    <button type="button" aria-label={label} onClick={() => onChange(9)}>
      {label}
    </button>
  ),
}));

import SupplierForm from './SupplierForm';

function setup(mode: 'create' | 'edit' = 'create') {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();
  render(<SupplierForm mode={mode} onSubmit={onSubmit} onCancel={onCancel} />);
  return { onSubmit, onCancel };
}

describe('SupplierForm', () => {
  it('renderiza os campos principais e o botão de cadastro', () => {
    setup();
    expect(screen.getByLabelText('Razão social')).toBeInTheDocument();
    expect(screen.getByLabelText('Nome fantasia')).toBeInTheDocument();
    expect(screen.getByLabelText('CNPJ (só dígitos)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Centro de custo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Plano de contas' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cadastrar' })).toBeInTheDocument();
  });

  it('exige ao menos um identificador ao submeter vazio', async () => {
    const { onSubmit } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    expect(await screen.findByText(/ao menos um identificador/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submete com um identificador preenchido (classificação 0 quando não informada)', async () => {
    const { onSubmit } = setup();
    await userEvent.type(screen.getByLabelText('Nome fantasia'), 'ACME');
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ trade_name: 'ACME', cost_center_id: 0, chart_account_id: 0 }),
    );
  });

  it('envia o centro de custo e o plano de contas selecionados', async () => {
    const { onSubmit } = setup();
    await userEvent.type(screen.getByLabelText('Nome fantasia'), 'ACME');
    await userEvent.click(screen.getByRole('button', { name: 'Centro de custo' }));
    await userEvent.click(screen.getByRole('button', { name: 'Plano de contas' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ trade_name: 'ACME', cost_center_id: 5, chart_account_id: 9 }),
    );
  });

  it('renderiza e submete os campos de contato (telefone/WhatsApp/PIX) com strip de máscara', async () => {
    const { onSubmit } = setup();
    expect(screen.getByLabelText('DDD (fone 1)')).toBeInTheDocument();
    expect(screen.getByLabelText('Telefone 1')).toBeInTheDocument();
    expect(screen.getByLabelText('WhatsApp 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Chave PIX 1')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Nome fantasia'), 'ACME');
    await userEvent.type(screen.getByLabelText('DDD (fone 1)'), '(11)');
    await userEvent.type(screen.getByLabelText('Telefone 1'), '99999-9999');
    await userEvent.type(screen.getByLabelText('Chave PIX 1'), 'financeiro@acme.com.br');
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        trade_name: 'ACME',
        phone_ddd1: '11',
        phone1: '999999999',
        pix_key1: 'financeiro@acme.com.br',
        cost_center_id: 0,
        chart_account_id: 0,
      }),
    );
  });

  it('valida o formato de e-mail', async () => {
    const { onSubmit } = setup();
    await userEvent.type(screen.getByLabelText('Nome fantasia'), 'ACME');
    await userEvent.type(screen.getByLabelText('E-mail'), 'invalido');
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }));
    expect(await screen.findByText('E-mail inválido')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
