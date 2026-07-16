import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const createContaMock = vi.fn();
vi.mock('../services/contas', () => ({ createConta: (...a: unknown[]) => createContaMock(...a) }));

const uploadMock = vi.fn();
vi.mock('../services/contaAttachments', () => ({
  uploadContaAttachments: (...a: unknown[]) => uploadMock(...a),
}));

// Stub do SupplierSelect (evita o react-select + rede no teste da página). Reflete
// `value`/`autoFocus` em data-* para asserir a limpeza e o foco no lançamento em série.
vi.mock('../components/molecules/SupplierSelect', () => ({
  default: ({ label, value, autoFocus, onChange }: { label: string; value: number | null; autoFocus?: boolean; onChange: (sk: number | null) => void }) => (
    <button
      type="button"
      aria-label={label}
      data-value={value ?? ''}
      data-autofocus={autoFocus ? 'yes' : 'no'}
      onClick={() => onChange(1)}
    >
      {label}
    </button>
  ),
}));

vi.mock('../components/molecules/CostCenterSelect', () => ({
  default: ({ label }: { label: string }) => <input aria-label={label} />,
}));
vi.mock('../components/molecules/ChartAccountSelect', () => ({
  default: ({ label }: { label: string }) => <input aria-label={label} />,
}));
vi.mock('../services/suppliers', () => ({
  getSupplier: vi.fn().mockResolvedValue({ sk_supplier: 1, cost_center_id: 0, chart_account_id: 0 }),
}));

import ContasNovaPage from './ContasNovaPage';

const pdf = (name = 'boleto.pdf') => new File(['x'], name, { type: 'application/pdf' });

async function lancar(comAnexo?: File) {
  await userEvent.click(screen.getByRole('button', { name: 'Fornecedor' }));
  await userEvent.type(screen.getByLabelText('Valor (R$)'), '100');
  await userEvent.selectOptions(screen.getByLabelText('Tipo de documento'), 'boleto');
  await userEvent.selectOptions(screen.getByLabelText('Tipo de pagamento'), 'pix');
  if (comAnexo) await userEvent.upload(screen.getByLabelText('Anexar arquivos'), comAnexo);
  await userEvent.click(screen.getByRole('button', { name: 'Lançar conta' }));
}

beforeEach(() => {
  createContaMock.mockReset().mockResolvedValue({ id: 42 });
  uploadMock.mockReset().mockResolvedValue({ saved: [{ id: 1 }], failed: [] });
});

describe('ContasNovaPage', () => {
  it('renderiza o título e o formulário de lançamento', () => {
    render(<ContasNovaPage />);
    expect(screen.getByRole('heading', { name: 'Cadastro de contas' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lançar conta' })).toBeInTheDocument();
  });

  it('sem anexo: cria a conta e NÃO chama o upload', async () => {
    render(<ContasNovaPage />);
    await lancar();
    await waitFor(() => expect(createContaMock).toHaveBeenCalled());
    expect(uploadMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/Conta lançada com sucesso \(id 42\)\./)).toBeInTheDocument();
  });

  it('com anexo: sobe DEPOIS de criar a conta, usando o id retornado', async () => {
    render(<ContasNovaPage />);
    await lancar(pdf());

    await waitFor(() => expect(uploadMock).toHaveBeenCalled());
    // O id só existe após o POST — daí o upload não poder vir antes.
    expect(uploadMock.mock.calls[0][0]).toBe(42);
    expect((uploadMock.mock.calls[0][1] as File[]).map((f) => f.name)).toEqual(['boleto.pdf']);
    expect(await screen.findByText(/Conta lançada com sucesso \(id 42\) com 1 anexo\(s\)\./)).toBeInTheDocument();
  });

  it('falha PARCIAL: avisa que a conta foi criada e nomeia o anexo que faltou', async () => {
    uploadMock.mockResolvedValue({ saved: [], failed: [{ file: pdf('grande.pdf'), message: 'limite' }] });
    render(<ContasNovaPage />);
    await lancar(pdf('grande.pdf'));

    // Dizer só "erro" faria o usuário lançar a conta de novo — e duplicá-la.
    const aviso = await screen.findByText(/Conta lançada \(id 42\), mas 1 anexo\(s\) não foram enviados/);
    expect(aviso).toHaveTextContent('grande.pdf');
    expect(aviso).toHaveTextContent(/Anexe pela edição da conta/);
  });

  it('falha ao criar a conta: mostra erro e não tenta subir anexo', async () => {
    createContaMock.mockRejectedValue(new Error('Fornecedor informado não existe'));
    render(<ContasNovaPage />);
    await lancar(pdf());

    expect(await screen.findByText('Fornecedor informado não existe')).toBeInTheDocument();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('após o sucesso, limpa só o fornecedor (com foco) e a fila de anexos; mantém os demais campos', async () => {
    render(<ContasNovaPage />);
    await lancar(pdf());
    await screen.findByText(/Conta lançada com sucesso/);
    // A fila de anexos é descartada (já subiu)…
    expect(screen.queryByText('boleto.pdf')).not.toBeInTheDocument();
    // …o fornecedor é limpo e refocado (lançamento em série)…
    const fornecedor = screen.getByRole('button', { name: 'Fornecedor' });
    expect(fornecedor).toHaveAttribute('data-value', '');
    expect(fornecedor).toHaveAttribute('data-autofocus', 'yes');
    // …mas os demais campos PERMANECEM (não há mais remonte total do form).
    expect(screen.getByLabelText('Valor (R$)')).toHaveValue(100);
  });
});
