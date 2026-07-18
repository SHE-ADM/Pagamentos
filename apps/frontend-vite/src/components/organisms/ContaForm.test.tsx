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

// Stubs dos lookups (react-select async) — evitam o react-select + rede no teste. Cascata
// INVERTIDA: ChartAccountSelect (plano) tem value = DESCRIÇÃO; CostCenterSelect (centro) tem
// value = chart_account_id e onChange devolve (chartAccountId, costCenterId). Expõem os
// valores em data-* e um botão para simular a seleção.
vi.mock('../molecules/ChartAccountSelect', () => ({
  default: ({ label, value, onChange }: { label: string; value: string | null; onChange: (d: string | null) => void }) => (
    <div>
      <input aria-label={label} data-value={value ?? ''} readOnly />
      <button type="button" onClick={() => onChange('Serviços Gerais')}>set-plano</button>
    </div>
  ),
}));
vi.mock('../molecules/CostCenterSelect', () => ({
  default: ({ label, value, defaultLabel, planoDescription, error, onChange }: {
    label: string;
    value: number | null;
    defaultLabel?: string;
    planoDescription: string | null;
    error?: string;
    onChange: (ca: number | null, cc: number | null) => void;
  }) => (
    <div>
      <input aria-label={label} data-value={value ?? ''} data-default-label={defaultLabel ?? ''} data-plano={planoDescription ?? ''} readOnly />
      {error && <span>{error}</span>}
      <button type="button" onClick={() => onChange(10, 5)}>set-centro</button>
    </div>
  ),
}));

// Stub do serviço — evita rede; o pré-preenchimento lê a classificação do fornecedor.
const getSupplierMock = vi.fn();
vi.mock('../../services/suppliers', () => ({
  getSupplier: (sk: number) => getSupplierMock(sk),
}));

// Stub do lookup de empresas (o <select> "Empresa" carrega as 3 empresas).
const listCompaniesMock = vi.fn();
vi.mock('../../services/lookups', () => ({
  listCompanies: () => listCompaniesMock(),
}));

// useAuth: o default do select "Empresa" depende do usuário logado (ester → FARDOS).
// Mutável por teste.
const authState = { email: 'rose@otimotex.com.br' };
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { email: authState.email } }),
}));

import type { FinancialAccountControl } from '@sheild/shared';
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
  authState.email = 'rose@otimotex.com.br'; // usuário comum → default OTIMOTEX TECIDOS
  listCompaniesMock.mockReset();
  listCompaniesMock.mockResolvedValue([
    { sk_company: 1, trade_name: 'OTIMOTEX TECIDOS' },
    { sk_company: 2, trade_name: 'LEBIANCO' },
    { sk_company: 3, trade_name: 'OTIMOTEX FARDOS' },
  ]);
});

describe('ContaForm', () => {
  it('renderiza os campos principais', () => {
    setup();
    expect(screen.getByLabelText('Valor (R$)')).toBeInTheDocument();
    expect(screen.getByLabelText('Tipo de documento')).toBeInTheDocument();
    expect(screen.getByLabelText('Tipo de pagamento')).toBeInTheDocument();
    expect(screen.getByLabelText('Informações adicionais')).toBeInTheDocument();
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
    // Cascata invertida: o PLANO guarda a descrição; o CENTRO guarda o chart_account_id
    // resolvido + rotula pelo centro (Logística).
    const plano = screen.getByLabelText('Plano de contas');
    const centro = screen.getByLabelText('Centro de custo');
    await waitFor(() => expect(plano).toHaveAttribute('data-value', 'Frete sobre vendas'));
    await waitFor(() => expect(centro).toHaveAttribute('data-value', '10'));
    expect(centro).toHaveAttribute('data-default-label', 'Logística');
    expect(centro).toHaveAttribute('data-plano', 'Frete sobre vendas');
  });

  it('re-semeia a classificação ao TROCAR o fornecedor no modo edição (não re-semeia no mount)', async () => {
    getSupplierMock.mockReset();
    getSupplierMock.mockResolvedValue({
      sk_supplier: 1,
      cost_center_id: 19,
      chart_account_id: 152,
      cost_center: { cost_center_code: 'CC19', cost_center_description: 'Compras' },
      chart_account: { account_code: 'AC152', account_description: 'Mercadorias para Revenda' },
    });
    // Conta gravada sob um fornecedor SEM classificação (0/0) — caso do boleto securitizado.
    const conta = {
      sk_supplier: 99,
      cost_center_id: 0,
      chart_account_id: 0,
      supplier: { trade_name: 'SB CREDITO', legal_name: null, cnpj: null, cpf: null },
    } as unknown as FinancialAccountControl;
    render(<ContaForm mode="edit" defaultValues={conta} onSubmit={vi.fn().mockResolvedValue(undefined)} />);

    // No mount da edição: mantém a classificação da própria conta (0/0 → vazio), SEM buscar o fornecedor.
    const centro = screen.getByLabelText('Centro de custo');
    expect(centro).toHaveAttribute('data-value', '');
    expect(getSupplierMock).not.toHaveBeenCalled();

    // Troca o fornecedor (stub → sk=1) → re-semeia com o default do NOVO fornecedor. O CENTRO
    // passa a guardar o chart_account_id (152) e o PLANO, a descrição.
    await userEvent.click(screen.getByRole('button', { name: 'Fornecedor' }));
    await waitFor(() => expect(getSupplierMock).toHaveBeenCalledWith(1));
    await waitFor(() => expect(centro).toHaveAttribute('data-value', '152'));
    expect(centro).toHaveAttribute('data-default-label', 'Compras');
    const plano = screen.getByLabelText('Plano de contas');
    await waitFor(() => expect(plano).toHaveAttribute('data-value', 'Mercadorias para Revenda'));
  });

  it('bloqueia o submit quando o plano é informado sem o centro (par incompleto)', async () => {
    const { onSubmit } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Fornecedor' }));
    await waitFor(() => expect(getSupplierMock).toHaveBeenCalledWith(1)); // prefill 0/0 aplicado
    await userEvent.type(screen.getByLabelText('Valor (R$)'), '100');
    await userEvent.selectOptions(screen.getByLabelText('Tipo de documento'), 'boleto');
    await userEvent.selectOptions(screen.getByLabelText('Tipo de pagamento'), 'pix');
    // Escolhe SÓ o plano (sem o centro) → par incompleto.
    await userEvent.click(screen.getByRole('button', { name: 'set-plano' }));
    await userEvent.click(screen.getByRole('button', { name: 'Lançar conta' }));

    expect(await screen.findByText('Selecione o centro de custo do plano informado')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submete o par completo (plano + centro) — chart_account_id e cost_center_id juntos', async () => {
    const { onSubmit } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Fornecedor' }));
    await waitFor(() => expect(getSupplierMock).toHaveBeenCalledWith(1));
    await userEvent.type(screen.getByLabelText('Valor (R$)'), '100');
    await userEvent.selectOptions(screen.getByLabelText('Tipo de documento'), 'boleto');
    await userEvent.selectOptions(screen.getByLabelText('Tipo de pagamento'), 'pix');
    await userEvent.click(screen.getByRole('button', { name: 'set-plano' }));
    await userEvent.click(screen.getByRole('button', { name: 'set-centro' }));
    await userEvent.click(screen.getByRole('button', { name: 'Lançar conta' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ chart_account_id: 10, cost_center_id: 5 });
  });

  it('submete com fornecedor, valor e enums preenchidos', async () => {
    const { onSubmit } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Fornecedor' }));
    await userEvent.type(screen.getByLabelText('Valor (R$)'), '100');
    await userEvent.selectOptions(screen.getByLabelText('Tipo de documento'), 'boleto');
    await userEvent.selectOptions(screen.getByLabelText('Tipo de pagamento'), 'pix');
    await userEvent.type(screen.getByLabelText('Informações adicionais'), 'pagar via portal');
    await userEvent.click(screen.getByRole('button', { name: 'Lançar conta' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      sk_supplier: 1,
      amount: 100,
      document_type: 'boleto',
      payment_method: 'pix',
      additional_info: 'pagar via portal',
    });
  });

  // ── Anexos ────────────────────────────────────────────────────────────────
  // O form NÃO sobe arquivo: entrega a fila ao pai, que grava a conta primeiro (o
  // upload precisa do id) e só então envia os bytes.
  async function preencheMinimo() {
    await userEvent.click(screen.getByRole('button', { name: 'Fornecedor' }));
    await userEvent.type(screen.getByLabelText('Valor (R$)'), '100');
    await userEvent.selectOptions(screen.getByLabelText('Tipo de documento'), 'boleto');
    await userEvent.selectOptions(screen.getByLabelText('Tipo de pagamento'), 'pix');
  }

  it('oferece o seletor de anexos na INCLUSÃO', () => {
    setup();
    expect(screen.getByLabelText('Anexar arquivos')).toBeInTheDocument();
  });

  it('entrega a fila de anexos ao onSubmit (2º parâmetro)', async () => {
    const { onSubmit } = setup();
    await preencheMinimo();
    await userEvent.upload(
      screen.getByLabelText('Anexar arquivos'),
      new File(['x'], 'boleto.pdf', { type: 'application/pdf' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Lançar conta' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const files = onSubmit.mock.calls[0][1] as File[];
    expect(files.map((f) => f.name)).toEqual(['boleto.pdf']);
  });

  it('sem anexo escolhido, entrega uma fila vazia', async () => {
    const { onSubmit } = setup();
    await preencheMinimo();
    await userEvent.click(screen.getByRole('button', { name: 'Lançar conta' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][1]).toEqual([]);
  });

  // ── Fila entre submits (o form NÃO remonta no modal de edição) ─────────────
  // Regressão coberta: o 2º submit reenviava a fila INTEIRA e duplicava o que já subiu —
  // cada upload gera storage_key nova, então o UNIQUE do banco não deduplica.
  it('não reenvia no 2º submit os anexos que o pai deu por enviados', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined); // undefined = fila esvaziada
    render(<ContaForm mode="create" onSubmit={onSubmit} />);
    await preencheMinimo();
    await userEvent.upload(
      screen.getByLabelText('Anexar arquivos'),
      new File(['x'], 'ja_subiu.pdf', { type: 'application/pdf' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Lançar conta' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: 'Lançar conta' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1][1]).toEqual([]); // 2º submit: fila vazia
  });

  it('falha PARCIAL: mantém na fila só o que o pai devolveu', async () => {
    const falhou = new File(['x'], 'falhou.pdf', { type: 'application/pdf' });
    // O pai devolve os que NÃO subiram; o que subiu sai da fila.
    const onSubmit = vi.fn().mockResolvedValue([falhou]);
    render(<ContaForm mode="create" onSubmit={onSubmit} />);
    await preencheMinimo();
    await userEvent.upload(screen.getByLabelText('Anexar arquivos'), [
      new File(['x'], 'subiu.pdf', { type: 'application/pdf' }),
      falhou,
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Lançar conta' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect((onSubmit.mock.calls[0][1] as File[]).map((f) => f.name)).toEqual(['subiu.pdf', 'falhou.pdf']);

    // A lista mostra só o que sobrou…
    await waitFor(() => expect(screen.queryByText('subiu.pdf')).not.toBeInTheDocument());
    expect(screen.getByText('falhou.pdf')).toBeInTheDocument();

    // …e o 2º submit reenvia SÓ ele (não duplica o que já subiu).
    await userEvent.click(screen.getByRole('button', { name: 'Lançar conta' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect((onSubmit.mock.calls[1][1] as File[]).map((f) => f.name)).toEqual(['falhou.pdf']);
  });

  // O caso "onSubmit LANÇA" não é testado de propósito: os dois pais capturam os próprios
  // erros e reportam por `submitError` (padrão do projeto — ver SuppliersPage/SupplierForm),
  // então nenhum produz esse cenário. Forçá-lo aqui só criaria uma promise rejeitada
  // escapando do handler do <form> (unhandled rejection), que polui o runner e derruba
  // outros arquivos em cascata. A garantia continua valendo por construção: o `setFiles`
  // vem DEPOIS do `await`, então uma exceção deixa a fila intacta.
  it('devolver a fila preserva os anexos quando o PAI reporta erro sem lançar', async () => {
    // É assim que ContasNovaPage sinaliza "a conta não foi criada": engole o erro, mostra
    // a mensagem e devolve a fila — os arquivos escolhidos não podem se perder.
    const onSubmit = vi.fn((_d: unknown, files: File[]) => Promise.resolve(files));
    render(<ContaForm mode="create" onSubmit={onSubmit} />);
    await preencheMinimo();
    await userEvent.upload(
      screen.getByLabelText('Anexar arquivos'),
      new File(['x'], 'boleto.pdf', { type: 'application/pdf' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Lançar conta' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(screen.getByText('boleto.pdf')).toBeInTheDocument(); // segue anexado
  });

  it('na INCLUSÃO não mostra anexos salvos (a conta ainda não existe)', () => {
    setup();
    expect(screen.queryByText('Anexos da conta')).not.toBeInTheDocument();
  });

  it('na EDIÇÃO mostra os anexos salvos da conta + o seletor de novos', () => {
    const conta = {
      id: 7,
      sk_supplier: 1,
      cost_center_id: 0,
      chart_account_id: 0,
      source_file: null,
      attachments: [
        {
          id: 1,
          account_id: 7,
          storage_key: 'manual/7/x.pdf',
          file_name: 'ja_salvo.pdf',
          mime_type: 'application/pdf',
          size_bytes: 10,
          origin: 'manual',
          uploaded_by: 'u1',
          created_at: '2026-07-15T12:00:00Z',
        },
      ],
    } as unknown as FinancialAccountControl;
    render(<ContaForm mode="edit" defaultValues={conta} onSubmit={vi.fn().mockResolvedValue(undefined)} />);

    expect(screen.getByText('Anexos da conta')).toBeInTheDocument();
    expect(screen.getByText('ja_salvo.pdf')).toBeInTheDocument();
    expect(screen.getByLabelText('Anexar arquivos')).toBeInTheDocument();
  });
});

// Empresa PAGADORA (sk_company). É INDEPENDENTE do fornecedor: pode haver conta da
// LEBIANCO cujo fornecedor é a OTIMOTEX.
describe('ContaForm — Empresa', () => {
  it('cadastro: nasce no default OTIMOTEX TECIDOS e vai no payload mesmo sem o usuário tocar', async () => {
    const { onSubmit } = setup();
    await screen.findByRole('option', { name: 'LEBIANCO' });   // lookup carregado

    expect(screen.getByLabelText('Empresa')).toHaveValue('1');

    await userEvent.click(screen.getByRole('button', { name: 'Fornecedor' }));
    await userEvent.type(screen.getByLabelText('Valor (R$)'), '100');
    await userEvent.selectOptions(screen.getByLabelText('Tipo de documento'), 'boleto');
    await userEvent.selectOptions(screen.getByLabelText('Tipo de pagamento'), 'pix');
    await userEvent.click(screen.getByRole('button', { name: 'Lançar conta' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ sk_company: 1 });
  });

  it('cadastro: escolher LEBIANCO grava sk_company = 2', async () => {
    const { onSubmit } = setup();
    await screen.findByRole('option', { name: 'LEBIANCO' });

    await userEvent.selectOptions(screen.getByLabelText('Empresa'), '2');
    await userEvent.click(screen.getByRole('button', { name: 'Fornecedor' }));
    await userEvent.type(screen.getByLabelText('Valor (R$)'), '100');
    await userEvent.selectOptions(screen.getByLabelText('Tipo de documento'), 'boleto');
    await userEvent.selectOptions(screen.getByLabelText('Tipo de pagamento'), 'pix');
    await userEvent.click(screen.getByRole('button', { name: 'Lançar conta' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ sk_company: 2 });
  });

  it('edição: mostra a empresa da própria conta (não o default)', async () => {
    const conta = { id: 9, sk_supplier: 1, sk_company: 2, amount: 50 } as unknown as FinancialAccountControl;
    render(<ContaForm mode="edit" defaultValues={conta} onSubmit={vi.fn().mockResolvedValue(undefined)} />);
    await screen.findByRole('option', { name: 'LEBIANCO' });

    expect(screen.getByLabelText('Empresa')).toHaveValue('2');
  });

  // Default POR USUÁRIO logado (espelha, no CRUD manual, a regra da ester do pipeline).
  it('cadastro pela ester: nasce em OTIMOTEX FARDOS (sk_company 3)', async () => {
    authState.email = 'ester@otimotex.com.br';
    const { onSubmit } = setup();
    await screen.findByRole('option', { name: 'OTIMOTEX FARDOS' });

    expect(screen.getByLabelText('Empresa')).toHaveValue('3');

    await userEvent.click(screen.getByRole('button', { name: 'Fornecedor' }));
    await userEvent.type(screen.getByLabelText('Valor (R$)'), '100');
    await userEvent.selectOptions(screen.getByLabelText('Tipo de documento'), 'boleto');
    await userEvent.selectOptions(screen.getByLabelText('Tipo de pagamento'), 'pix');
    await userEvent.click(screen.getByRole('button', { name: 'Lançar conta' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ sk_company: 3 });
  });

  it('outro usuário @otimotex.com.br NÃO herda o FARDOS (o endereço é exato)', async () => {
    authState.email = 'rose@otimotex.com.br';
    setup();
    await screen.findByRole('option', { name: 'OTIMOTEX FARDOS' });
    expect(screen.getByLabelText('Empresa')).toHaveValue('1');
  });

  it('edição pela ester: mostra a empresa da CONTA, não o default do usuário', async () => {
    authState.email = 'ester@otimotex.com.br';
    const conta = { id: 9, sk_supplier: 1, sk_company: 2, amount: 50 } as unknown as FinancialAccountControl;
    render(<ContaForm mode="edit" defaultValues={conta} onSubmit={vi.fn().mockResolvedValue(undefined)} />);
    await screen.findByRole('option', { name: 'LEBIANCO' });

    expect(screen.getByLabelText('Empresa')).toHaveValue('2');
  });

  it('falha no lookup não trava o lançamento — mantém a OTIMOTEX TECIDOS', async () => {
    listCompaniesMock.mockRejectedValue(new Error('rede'));
    const { onSubmit } = setup();

    expect(screen.getByLabelText('Empresa')).toHaveValue('1');
    await userEvent.click(screen.getByRole('button', { name: 'Fornecedor' }));
    await userEvent.type(screen.getByLabelText('Valor (R$)'), '100');
    await userEvent.selectOptions(screen.getByLabelText('Tipo de documento'), 'boleto');
    await userEvent.selectOptions(screen.getByLabelText('Tipo de pagamento'), 'pix');
    await userEvent.click(screen.getByRole('button', { name: 'Lançar conta' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ sk_company: 1 });
  });
});
