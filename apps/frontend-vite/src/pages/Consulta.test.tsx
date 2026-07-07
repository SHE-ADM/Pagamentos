import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FinancialAccountControl } from '@sheild/shared';
import { STATUS_ID_PAGO, STATUS_ID_A_VENCER } from '@sheild/shared';

// Mocka o serviço de dados — o teste cobre o layout/interação, não a rede.
const getFinancialAccountControl = vi.fn();
const getFinancialStats = vi.fn();
const getFinancialAccountTotalValue = vi.fn();
const getFinancialAccountCount = vi.fn();
const setFinancialAccountFlag = vi.fn();
const setFinancialAccountStatus = vi.fn();

vi.mock('../services/supabase', () => ({
  getFinancialAccountControl: (...args: unknown[]) => getFinancialAccountControl(...args),
  getFinancialStats: (...args: unknown[]) => getFinancialStats(...args),
  getFinancialAccountTotalValue: (...args: unknown[]) => getFinancialAccountTotalValue(...args),
  getFinancialAccountCount: (...args: unknown[]) => getFinancialAccountCount(...args),
  setFinancialAccountFlag: (...args: unknown[]) => setFinancialAccountFlag(...args),
  setFinancialAccountStatus: (...args: unknown[]) => setFinancialAccountStatus(...args),
}));

// Mocka o leitor IMAP — o teste cobre o disparo pelo botão "Atualizar", não a rede.
const startEmailRead = vi.fn();
const getEmailReadProgress = vi.fn();
vi.mock('../services/emailReader', () => ({
  startEmailRead: (...args: unknown[]) => startEmailRead(...args),
  getEmailReadProgress: (...args: unknown[]) => getEmailReadProgress(...args),
}));
vi.mock('../hooks/useIdleLogout', () => ({
  suspendIdleLogout: vi.fn(),
  resumeIdleLogout: vi.fn(),
}));

import Consulta from './Consulta';

// Linha mínima para os testes de grid — só os campos lidos pelas colunas.
const makeRow = (over: Partial<FinancialAccountControl> = {}): FinancialAccountControl =>
  ({
    id: 1,
    sk_supplier: 1,
    supplier: { trade_name: 'ACME LTDA', legal_name: 'ACME LTDA', cnpj: null, cpf: null },
    invoice_number: '12345',
    issue_date: '2026-06-01',
    due_date: '2026-06-10',
    amount: 100,
    document_type: 'boleto',
    payment_method: 'boleto',
    status: 'a vencer',
    extraction_source: 'pdf_text',
    has_invoice: false,
    has_bank_slip: false,
    ...over,
  }) as FinancialAccountControl;

describe('Consulta', () => {
  beforeEach(() => {
    getFinancialAccountControl.mockResolvedValue({ data: [], total: 0 });
    getFinancialStats.mockResolvedValue({
      totalRecords: 0,
      totalValue: 0,
      pago: 0,
      pagoValue: 0,
      aVencer: 0,
      aVencerValue: 0,
      vencendo: 0,
      vencendoValue: 0,
      vencidas: 0,
      vencidasValue: 0,
    });
    getFinancialAccountTotalValue.mockResolvedValue(0);
    getFinancialAccountCount.mockResolvedValue(0);
    setFinancialAccountFlag.mockReset().mockResolvedValue(undefined);
    setFinancialAccountStatus.mockReset().mockResolvedValue(undefined);
    startEmailRead.mockReset().mockResolvedValue({ started: true, alreadyRunning: false });
    getEmailReadProgress.mockReset().mockResolvedValue({
      running: false,
      phase: 'concluído',
      total: 0,
      done: 0,
      processed: 0,
      skipped_keyword: 0,
      skipped_dup: 0,
      elapsed: 0,
      summary: null,
      error: null,
    });
  });

  it('marca a flag "Tem NF" e persiste via setFinancialAccountFlag', async () => {
    const user = userEvent.setup();
    getFinancialAccountControl.mockResolvedValue({ data: [makeRow()], total: 1 });
    render(<Consulta />);

    const box = await screen.findByRole('checkbox', { name: /Tem NF/ });
    expect(box).not.toBeChecked();

    await user.click(box);

    expect(setFinancialAccountFlag).toHaveBeenCalledWith(1, 'has_invoice', true);
    await waitFor(() => expect(box).toBeChecked());
  });

  it('o botão "Atualizar" dispara a leitura IMAP dos últimos 7 dias', async () => {
    const user = userEvent.setup();
    render(<Consulta />);

    await user.click(screen.getByRole('button', { name: 'Atualizar' }));
    await waitFor(() => expect(startEmailRead).toHaveBeenCalledWith({ days: 7 }));

    // ao concluir (progress.running=false), o banner de progresso some
    await waitFor(() => expect(screen.queryByText(/Buscando e-mails/)).not.toBeInTheDocument(), {
      timeout: 4000,
    });
  });

  it('renderiza cabeçalho, cards de métricas e estado vazio', async () => {
    render(<Consulta />);

    expect(screen.getByText('Consulta de movimentações')).toBeInTheDocument();
    expect(screen.getByText('Total de registros')).toBeInTheDocument();
    expect(screen.getByText('Vencidas')).toBeInTheDocument();

    await waitFor(() =>
      expect(
        screen.getByText(/Nenhum registro encontrado/),
      ).toBeInTheDocument(),
    );
  });

  it('o botão Limpar reseta o campo de fornecedor', async () => {
    const user = userEvent.setup();
    render(<Consulta />);

    const supplier = screen.getByPlaceholderText(/^Fornecedor/);
    await user.type(supplier, 'ACME');
    expect(supplier).toHaveValue('ACME');

    await user.click(screen.getByRole('button', { name: 'Limpar' }));
    expect(supplier).toHaveValue('');
  });

  it('o ícone de limpar aparece com texto e zera a busca', async () => {
    const user = userEvent.setup();
    render(<Consulta />);

    const supplier = screen.getByPlaceholderText(/^Fornecedor/);
    // sem texto, o ícone de limpar não é renderizado
    expect(screen.queryByRole('button', { name: 'Limpar busca' })).not.toBeInTheDocument();

    await user.type(supplier, 'ACME');
    await user.click(screen.getByRole('button', { name: 'Limpar busca' }));

    expect(supplier).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Limpar busca' })).not.toBeInTheDocument();
  });

  it('atualiza o card "Valor total" conforme o filtro do card "A vencer"', async () => {
    const user = userEvent.setup();
    // 1ª soma (sem filtro) = global; após clicar "A vencer" = subconjunto filtrado.
    getFinancialAccountTotalValue.mockResolvedValueOnce(5000).mockResolvedValueOnce(1234);
    render(<Consulta />);

    // valor global é exibido no card (match exato — o valor também aparece no rodapé)
    await waitFor(() => expect(screen.getByText('R$ 5.000,00')).toBeInTheDocument());

    await user.click(screen.getByText('A vencer'));

    // a soma é refeita com o filtro do card...
    await waitFor(() =>
      expect(getFinancialAccountTotalValue).toHaveBeenLastCalledWith(
        expect.objectContaining({ statusId: STATUS_ID_A_VENCER }),
      ),
    );
    // ...e o card passa a refletir o valor filtrado (match exato — também no rodapé)
    await waitFor(() => expect(screen.getByText('R$ 1.234,00')).toBeInTheDocument());
  });

  it('abre filtrado no mês/ano corrente por vencimento', async () => {
    render(<Consulta />);
    const now = new Date();
    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenCalledWith(
        expect.objectContaining({
          dateField: 'due_date',
          month: now.getMonth(),
          year: now.getFullYear(),
        }),
      ),
    );
  });

  it('o seletor "Tipo de data" alterna para Emissão (issue_date)', async () => {
    const user = userEvent.setup();
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());

    await user.selectOptions(screen.getByLabelText(/Tipo de data/i), 'issue_date');

    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ dateField: 'issue_date' }),
      ),
    );
  });

  it('o botão "Todas" remove o filtro de mês/ano', async () => {
    const user = userEvent.setup();
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /Todas/ }));

    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ month: null, year: null }),
      ),
    );
  });

  it('a busca por intervalo De/Até é global (zera mês/ano) e usa dateFrom/dateTo', async () => {
    const user = userEvent.setup();
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/data inicial/i), { target: { value: '2026-03-01' } });
    fireEvent.change(screen.getByLabelText(/data final/i), { target: { value: '2026-03-31' } });
    await user.click(screen.getByRole('button', { name: 'Buscar' }));

    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ dateFrom: '2026-03-01', dateTo: '2026-03-31', month: null, year: null }),
      ),
    );
  });

  it('card de KPI continua ativo ao navegar por mês; clicar de novo volta ao mês atual', async () => {
    const user = userEvent.setup();
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());

    // ativa "Pagos" → global (mês/ano null) + status pago
    await user.click(screen.getByText('Pagos'));
    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ statusId: STATUS_ID_PAGO, month: null, year: null }),
      ),
    );

    // navega para Janeiro → card permanece, status preservado, narrows para o mês
    const months = screen.getByRole('group', { name: 'Filtrar por mês' });
    await user.click(within(months).getByRole('button', { name: 'Mês Janeiro' }));
    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ statusId: STATUS_ID_PAGO, month: 0 }),
      ),
    );

    // clicar "Pagos" de novo → volta ao mês atual, sem status
    const now = new Date();
    await user.click(screen.getByText('Pagos'));
    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ statusId: undefined, month: now.getMonth(), year: now.getFullYear() }),
      ),
    );
  });
});
