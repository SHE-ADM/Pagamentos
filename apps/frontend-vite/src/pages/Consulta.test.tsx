import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FinancialAccountControl } from '@sheild/shared';
import { SENTINEL_AUTHOR_ID } from '../lib/sentinelAuthor';
import { STATUS_ID_PAGO, STATUS_ID_A_VENCER, STATUS_ID_CANCELADO, STATUS_ID_VENCIDO } from '@sheild/shared';

// Flush de microtasks — garante que o .then da persistência da flag (e a checagem de
// baixa automática) já rodou antes de asserções do tipo "não foi chamado".
const flush = () => new Promise((r) => setTimeout(r, 0));

// Mocka o serviço de dados — o teste cobre o layout/interação, não a rede.
const getFinancialAccountControl = vi.fn();
const getFinancialStats = vi.fn();
const getFinancialAccountTotalValue = vi.fn();
const getFinancialAccountCount = vi.fn();
const setFinancialAccountFlag = vi.fn();
const setFinancialAccountStatus = vi.fn();
const setFinancialAccountStatusBulk = vi.fn();
const getAppUsers = vi.fn();

vi.mock('../services/supabase', () => ({
  getFinancialAccountControl: (...args: unknown[]) => getFinancialAccountControl(...args),
  getFinancialStats: (...args: unknown[]) => getFinancialStats(...args),
  getFinancialAccountTotalValue: (...args: unknown[]) => getFinancialAccountTotalValue(...args),
  getFinancialAccountCount: (...args: unknown[]) => getFinancialAccountCount(...args),
  setFinancialAccountFlag: (...args: unknown[]) => setFinancialAccountFlag(...args),
  setFinancialAccountStatus: (...args: unknown[]) => setFinancialAccountStatus(...args),
  setFinancialAccountStatusBulk: (...args: unknown[]) => setFinancialAccountStatusBulk(...args),
  getAppUsers: (...args: unknown[]) => getAppUsers(...args),
  // Opções do filtro de plano de contas: só as descrições EM USO em
  // financial_account_control (busca geral, com a RLS do usuário). Vive aqui, e não em
  // services/lookups, porque a Next API lê com service_role e ignoraria a RLS.
  listUsedChartAccountDescriptions: () => Promise.resolve(['Serviços Gerais']),
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

// Lookups dos filtros — evitam rede no teste. A factory SUBSTITUI o módulo inteiro, então
// todo lookup que /consulta (ou os componentes que ela monta) importar precisa constar
// aqui, senão o import da página quebra.
//  · listCompanies                     → filtro "Empresa" (useCompanyOptions)
//  · listCostCenters/Groups/Subgroups  → 2ª linha (useClassificationFilterOptions)
//  · listPlanoDescriptions             → 2ª linha (ChartAccountSelect variant="filter")
const listCompaniesMock = vi.fn();
const listCostCentersMock = vi.fn();
const listChartAccountGroupsMock = vi.fn();
const listChartAccountSubgroupsMock = vi.fn();
const listPlanoDescriptionsMock = vi.fn();
vi.mock('../services/lookups', () => ({
  listCompanies: () => listCompaniesMock(),
  listCostCenters: () => listCostCentersMock(),
  listChartAccountGroups: () => listChartAccountGroupsMock(),
  listChartAccountSubgroups: () => listChartAccountSubgroupsMock(),
  listPlanoDescriptions: () => listPlanoDescriptionsMock(),
}));

// useAuth: o hard delete de conta só aparece para o grupo Administrador (mutável por teste).
const authState = { isAdminGroup: false };
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ isAdminGroup: authState.isAdminGroup }),
}));

// Cliente do CRUD de contas — mockado para o hard delete (e a edição, importada junto).
const deleteContaMock = vi.fn();
const updateContaMock = vi.fn();
vi.mock('../services/contas', () => ({
  deleteConta: (...a: unknown[]) => deleteContaMock(...a),
  updateConta: (...a: unknown[]) => updateContaMock(...a),
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
    status_id: STATUS_ID_A_VENCER,
    status_dim: { status_name: 'a vencer', status_short_name: 'a vencer' },
    extraction_source: 'pdf_text',
    has_invoice: false,
    has_bank_slip: false,
    ...over,
  }) as FinancialAccountControl;

describe('Consulta', () => {
  beforeEach(() => {
    authState.isAdminGroup = false;
    deleteContaMock.mockReset();
    updateContaMock.mockReset();
    listCompaniesMock.mockReset();
    listCompaniesMock.mockResolvedValue([
      { sk_company: 1, trade_name: 'OTIMOTEX TECIDOS' },
      { sk_company: 2, trade_name: 'LEBIANCO' },
    ]);
    listCostCentersMock.mockReset();
    listCostCentersMock.mockResolvedValue([
      { cost_center_id: 4, cost_center_code: '004', cost_center_description: 'Logística' },
    ]);
    listChartAccountGroupsMock.mockReset();
    listChartAccountGroupsMock.mockResolvedValue([
      { chart_account_group_id: 24, group_code: '24', group_description: 'Despesas Fixas' },
    ]);
    listChartAccountSubgroupsMock.mockReset();
    listChartAccountSubgroupsMock.mockResolvedValue([
      { chart_account_subgroup_id: 93, subgroup_code: '93', subgroup_description: 'Copa e Cozinha' },
    ]);
    listPlanoDescriptionsMock.mockReset();
    listPlanoDescriptionsMock.mockResolvedValue([{ account_description: 'Serviços Gerais' }]);
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
    getAppUsers.mockReset().mockResolvedValue({});
    setFinancialAccountFlag.mockReset().mockResolvedValue(undefined);
    setFinancialAccountStatus.mockReset().mockResolvedValue(undefined);
    setFinancialAccountStatusBulk.mockReset().mockResolvedValue(undefined);
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

  it('mostra a informação adicional como rodapé do registro, sem clicar (só nas linhas que a têm)', async () => {
    getFinancialAccountControl.mockResolvedValue({
      data: [
        makeRow({ id: 1, additional_info: 'Pagamento via PIX ag. Bruno — ref. julho' }),
        makeRow({ id: 2, invoice_number: '67890' }),
      ],
      total: 2,
    });
    render(<Consulta />);

    // Rodapé sempre-visível: o texto aparece sem nenhuma interação.
    expect(await screen.findByText(/Pagamento via PIX ag\. Bruno/)).toBeInTheDocument();
    // Só a linha com additional_info ganha o rótulo do rodapé.
    expect(screen.getAllByText('Informação adicional:')).toHaveLength(1);
  });

  it('coluna Extração mostra "Criado pelo usuário" na conta manual e o badge de origem na do pipeline', async () => {
    getFinancialAccountControl.mockResolvedValue({
      data: [
        makeRow({ id: 1, extraction_source: null }), // conta manual (sem pipeline)
        makeRow({ id: 2, invoice_number: '67890', extraction_source: 'pdf_text' }), // do pipeline
      ],
      total: 2,
    });
    render(<Consulta />);

    // Conta manual → rótulo "Criado pelo usuário"; conta do pipeline → "pdf anexado".
    expect(await screen.findByText('Criado pelo usuário')).toBeInTheDocument();
    expect(screen.getByText('pdf anexado')).toBeInTheDocument();
  });

  it('detalhe da conta mostra os autores (criado/editado/situação) resolvidos por e-mail', async () => {
    getAppUsers.mockResolvedValue({
      'uuid-a': 'ester@otimotex.com.br',
      'uuid-b': 'barbara@otimotex.com.br',
    });
    getFinancialAccountControl.mockResolvedValue({
      data: [makeRow({
        created_by: 'uuid-a', updated_by: 'uuid-b',
        status_changed_by: 'uuid-b', status_changed_at: '2026-07-10T20:00:00Z',
      })],
      total: 1,
    });
    render(<Consulta />);

    // Abre o detalhe clicando na linha (célula não-interativa: Nº do documento).
    fireEvent.click(await screen.findByText('12345'));
    expect(await screen.findByText('Criado por')).toBeInTheDocument();
    expect(screen.getByText('Última edição por')).toBeInTheDocument();
    expect(screen.getByText('Situação alterada por')).toBeInTheDocument();
    // Autor resolvido por e-mail via getAppUsers (criado por = ester).
    expect(screen.getByText('ester@otimotex.com.br')).toBeInTheDocument();
  });

  it('detalhe OMITE "Última edição por"/"Situação alterada por" quando o autor é o sentinela', async () => {
    // Importa a MESMA constante que a página usa, em vez de repetir o UUID: quando a
    // identidade do sentinela mudou (migration 110, teste@ → financeiro@), a cópia local
    // ficou obsoleta e o caso quebrou por um motivo que não era o comportamento sob teste.
    const SENTINEL = SENTINEL_AUTHOR_ID;
    // Sentinela NÃO está no diretório → testa o fallback por UUID (isSentinelAuthor).
    getAppUsers.mockResolvedValue({ 'uuid-a': 'ester@otimotex.com.br' });
    getFinancialAccountControl.mockResolvedValue({
      data: [makeRow({ created_by: 'uuid-a', updated_by: SENTINEL, status_changed_by: SENTINEL })],
      total: 1,
    });
    render(<Consulta />);
    fireEvent.click(await screen.findByText('12345')); // abre o detalhe
    // "Criado por" (usuário real) permanece; as duas do sentinela somem.
    expect(await screen.findByText('Criado por')).toBeInTheDocument();
    expect(screen.queryByText('Última edição por')).not.toBeInTheDocument();
    expect(screen.queryByText('Situação alterada por')).not.toBeInTheDocument();
  });

  it('hard delete NÃO aparece no detalhe para quem não é do grupo Administrador', async () => {
    getFinancialAccountControl.mockResolvedValue({ data: [makeRow()], total: 1 });
    render(<Consulta />);
    fireEvent.click(await screen.findByText('12345')); // abre o detalhe
    expect(await screen.findByRole('button', { name: /Editar conta/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Excluir conta/ })).not.toBeInTheDocument();
  });

  it('grupo Administrador: confirma e exclui (deleteConta) — a linha some do grid', async () => {
    const user = userEvent.setup();
    authState.isAdminGroup = true;
    deleteContaMock.mockResolvedValue(1);
    getFinancialAccountControl.mockResolvedValue({ data: [makeRow()], total: 1 });
    render(<Consulta />);

    fireEvent.click(await screen.findByText('12345')); // abre o detalhe
    await user.click(await screen.findByRole('button', { name: /Excluir conta/ }));
    // Confirmação inline antes de excluir (irreversível).
    expect(screen.getByText('Excluir permanentemente?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Excluir$/ }));

    expect(deleteContaMock).toHaveBeenCalledWith(1);
    // A conta some do grid (o Nº do documento deixa de ser exibido).
    await waitFor(() => expect(screen.queryByText('12345')).not.toBeInTheDocument());
  });

  it('baixa automática: marcar a 2ª flag em conta vencida e em aberto muda a situação para "pago"', async () => {
    const user = userEvent.setup();
    // NF já marcada, Boleto não; vencimento no passado e situação em aberto (a vencer).
    getFinancialAccountControl.mockResolvedValue({
      data: [makeRow({ has_invoice: true, has_bank_slip: false, due_date: '2020-01-01', status_id: STATUS_ID_A_VENCER })],
      total: 1,
    });
    render(<Consulta />);

    const bol = await screen.findByRole('checkbox', { name: /Tem Boleto/ });
    await user.click(bol);

    expect(setFinancialAccountFlag).toHaveBeenCalledWith(1, 'has_bank_slip', true);
    // Ambas as flags marcadas + vencido + em aberto → grava status_id = pago.
    await waitFor(() => expect(setFinancialAccountStatus).toHaveBeenCalledWith(1, STATUS_ID_PAGO));
  });

  it('baixa automática: NÃO baixa quando o vencimento é futuro', async () => {
    const user = userEvent.setup();
    getFinancialAccountControl.mockResolvedValue({
      data: [makeRow({ has_invoice: true, has_bank_slip: false, due_date: '2999-12-31', status_id: STATUS_ID_A_VENCER })],
      total: 1,
    });
    render(<Consulta />);

    await user.click(await screen.findByRole('checkbox', { name: /Tem Boleto/ }));

    await waitFor(() => expect(setFinancialAccountFlag).toHaveBeenCalledWith(1, 'has_bank_slip', true));
    await flush();
    expect(setFinancialAccountStatus).not.toHaveBeenCalled();
  });

  it('baixa automática: NÃO baixa conta em situação fechada (cancelado)', async () => {
    const user = userEvent.setup();
    getFinancialAccountControl.mockResolvedValue({
      data: [makeRow({ has_invoice: true, has_bank_slip: false, due_date: '2020-01-01', status_id: STATUS_ID_CANCELADO })],
      total: 1,
    });
    render(<Consulta />);

    await user.click(await screen.findByRole('checkbox', { name: /Tem Boleto/ }));

    await waitFor(() => expect(setFinancialAccountFlag).toHaveBeenCalledWith(1, 'has_bank_slip', true));
    await flush();
    expect(setFinancialAccountStatus).not.toHaveBeenCalled();
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

    // A mensagem nomeia o período em vigor ("Nenhum registro em <Mês>/<ano>…") — o texto
    // genérico só aparece no escopo global. Ver o caso dedicado mais abaixo.
    await waitFor(() =>
      expect(
        screen.getByText(/Nenhum registro em /),
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

  // Filtro de EMPRESA (sk_company). Como os demais selects, aplica no "Buscar".
  it('filtrar por LEBIANCO consulta com skCompany=2', async () => {
    const user = userEvent.setup();
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());
    // As opções vêm do lookup (useCompanyOptions).
    await screen.findByRole('option', { name: 'LEBIANCO' });

    await user.selectOptions(screen.getByLabelText('Filtrar por empresa'), '2');
    await user.click(screen.getByRole('button', { name: /^Buscar/ }));

    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ skCompany: 2 }),
      ),
    );
  });

  it('sem escolher empresa, consulta SEM o filtro (as duas empresas)', async () => {
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());

    expect(screen.getByLabelText('Filtrar por empresa')).toHaveValue('');
    expect(getFinancialAccountControl.mock.calls[0][0]).toMatchObject({ skCompany: undefined });
  });

  it('o filtro de empresa alcança os cards "Valor total"/"Total de registros"', async () => {
    const user = userEvent.setup();
    render(<Consulta />);
    await screen.findByRole('option', { name: 'LEBIANCO' });
    getFinancialAccountTotalValue.mockClear();
    getFinancialAccountCount.mockClear();

    await user.selectOptions(screen.getByLabelText('Filtrar por empresa'), '2');
    await user.click(screen.getByRole('button', { name: /^Buscar/ }));

    await waitFor(() =>
      expect(getFinancialAccountTotalValue).toHaveBeenLastCalledWith(
        expect.objectContaining({ skCompany: 2 }),
      ),
    );
    expect(getFinancialAccountCount).toHaveBeenLastCalledWith(expect.objectContaining({ skCompany: 2 }));
  });

  // SEM clicar em "Buscar": preencher o intervalo aplica sozinho e zera o período, porque
  // a precedência do serviço ignora month/year quando há range — deixar o mês aceso seria
  // o botão mentindo sobre o que está filtrado.
  it('o intervalo De/Até aplica sozinho e zera mês/ano', async () => {
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/data inicial/i), { target: { value: '2026-03-01' } });
    fireEvent.change(screen.getByLabelText(/data final/i), { target: { value: '2026-03-31' } });

    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ dateFrom: '2026-03-01', dateTo: '2026-03-31', month: null, year: null }),
      ),
    );
  });

  // Caminho de VOLTA. Sem ele, apagar as datas deixaria o usuário preso em escopo global
  // (toda a base, nenhum mês em destaque) sem nenhuma ação que explicasse o que houve.
  it('apagar as duas datas devolve o período ao mês/ano corrente', async () => {
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());
    const now = new Date();

    fireEvent.change(screen.getByLabelText(/data inicial/i), { target: { value: '2026-03-01' } });
    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ month: null, year: null }),
      ),
    );

    fireEvent.change(screen.getByLabelText(/data inicial/i), { target: { value: '' } });

    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ dateFrom: '', month: now.getMonth(), year: now.getFullYear() }),
      ),
    );
  });

  // O caminho de volta é o DESFAZER da operação, não um pulo para um default: quem
  // navegava em outro mês tem de voltar para ele. O mês é escolhido por deslocamento a
  // partir do corrente (nunca igual a ele), senão em Março o teste passaria por
  // coincidência — o defeito que ele trava é justamente "restaurou o mês corrente".
  it('o caminho de volta devolve o mês que estava selecionado, não o corrente', async () => {
    const user = userEvent.setup();
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());
    const outroMes = (new Date().getMonth() + 6) % 12;

    const botoesDeMes = within(screen.getByRole('group', { name: 'Filtrar por mês' })).getAllByRole('button');
    await user.click(botoesDeMes[outroMes]);
    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ month: outroMes }),
      ),
    );

    fireEvent.change(screen.getByLabelText(/data inicial/i), { target: { value: '2026-03-01' } });
    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ dateFrom: '2026-03-01', month: null }),
      ),
    );

    fireEvent.change(screen.getByLabelText(/data inicial/i), { target: { value: '' } });
    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ dateFrom: '', month: outroMes }),
      ),
    );
  });

  // CONTRAPARTE do teste acima, e o par é que faz o guarda: o caminho de volta só vale
  // para quem foi levado ao escopo global PELO intervalo. Com um card de KPI ativo (global
  // de propósito), restaurar o mês corrente estreitaria a consulta em silêncio — e o card
  // seguiria aceso dizendo o contrário. A condição ingênua "o período está vazio" faz
  // exatamente isso; é `periodBeforeRange` NULO que distingue os dois casos.
  it('com um card de KPI ativo, apagar as datas NÃO restaura o mês corrente', async () => {
    const user = userEvent.setup();
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());

    await user.click(screen.getByText('Vencidas'));
    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ statusId: STATUS_ID_VENCIDO, month: null, year: null }),
      ),
    );

    fireEvent.change(screen.getByLabelText(/data inicial/i), { target: { value: '2026-03-01' } });
    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ dateFrom: '2026-03-01' }),
      ),
    );

    // Asserção POSITIVA sobre a mesma chamada que carrega `dateFrom: ''` — evita o
    // formato "ausência depois de um flush", que não alcançaria a janela de 300 ms.
    fireEvent.change(screen.getByLabelText(/data inicial/i), { target: { value: '' } });
    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ dateFrom: '', month: null, year: null }),
      ),
    );
  });

  // GUARDA do resetFilterGate. Sem ele, escolher um filtro e clicar "Limpar" dentro da
  // janela faz o patch pendente cair por cima do estado já limpo 300 ms depois — o filtro
  // "volta sozinho" na tela, sem erro. Duas escolhas deliberadas de formato:
  //  · `fireEvent` nos dois passos (não `userEvent`), para o intervalo entre eles ser 0 ms:
  //    o teste não pode depender de vencer uma corrida contra tempo real;
  //  · a passagem da janela é provada por um filtro POSTERIOR que aplica de fato, não por
  //    um sleep fixo — que viraria falso verde se FILTER_APPLY_DELAY_MS crescesse.
  it('"Limpar" dentro da janela descarta o filtro pendente (não volta sozinho)', async () => {
    render(<Consulta />);
    await screen.findByRole('option', { name: '24 — Despesas Fixas' });
    getFinancialAccountControl.mockClear();
    const now = new Date();

    fireEvent.change(screen.getByLabelText('Filtrar por grupo de plano de contas'), { target: { value: '24' } });
    fireEvent.click(screen.getByRole('button', { name: 'Limpar' }));

    // Sanidade: o "Limpar" precisa MESMO ter aplicado — senão a asserção de ausência
    // adiante passaria por não ter acontecido nada.
    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({
          chartAccountGroupId: undefined,
          month: now.getMonth(),
          year: now.getFullYear(),
        }),
      ),
    );

    // Um apply COMPLETO depois do "Limpar" prova que a janela inteira transcorreu.
    fireEvent.change(screen.getByLabelText('Filtrar por tipo de documento'), { target: { value: 'boleto' } });
    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ docType: 'boleto' }),
      ),
    );
    expect(getFinancialAccountControl).not.toHaveBeenCalledWith(
      expect.objectContaining({ chartAccountGroupId: 24 }),
    );
  });

  // CONTRAPARTE do teste acima, e a diferença entre os dois é a regra: "Limpar"/card/"Buscar"
  // redefinem o filtro INTEIRO, então descartar o pendente é o certo; navegar por MÊS só
  // acrescenta um recorte de período, e ali o pendente tem de sobreviver.
  //
  // O defeito que este caso trava (medido antes da correção): `applyPeriod` fazia
  // `setApplied((a) => ({ ...a, ...patch }))` — patch parcial — depois de `resetFilterGate()`
  // jogar fora o pendente. O tipo escolhido continuava VISÍVEL no <select> (`f` o guardava) e
  // sumia da consulta, de forma permanente: `pendingApply` carrega só o patch, nunca `f`
  // inteiro, então nenhum filtro seguinte o traria de volta.
  //
  // `fireEvent` nos dois passos (não `userEvent`): o intervalo entre eles fica em 0 ms, dentro
  // da janela de 300 ms. Com `userEvent` o apply do tipo já teria acontecido e o caso não
  // exercitaria o descarte — passaria com o defeito presente.
  it('navegar por mês PRESERVA o filtro escolhido dentro da janela', async () => {
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());
    getFinancialAccountControl.mockClear();

    fireEvent.change(screen.getByLabelText('Filtrar por tipo de documento'), { target: { value: 'boleto' } });
    const botoesDeMes = within(screen.getByRole('group', { name: 'Filtrar por mês' })).getAllByRole('button');
    fireEvent.click(botoesDeMes[2]); // Mar

    // Sanidade: o clique no mês precisa MESMO ter aplicado — sem isto a asserção seguinte
    // poderia passar por não ter havido consulta alguma.
    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(expect.objectContaining({ month: 2 })),
    );
    // O select segue exibindo "boleto"…
    expect(screen.getByLabelText<HTMLSelectElement>('Filtrar por tipo de documento').value).toBe('boleto');
    // …e a consulta tem de carregar o mesmo: é a divergência tela × consulta que se impede.
    expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
      expect.objectContaining({ docType: 'boleto', month: 2 }),
    );
  });

  // Os DOIS seletores de data são independentes — este par é o guarda da regra, nos dois
  // sentidos. Um teste de mão única continuaria verde se um deles escrevesse nos dois
  // campos, que é exatamente o acoplamento que esta feature removeu.
  it('o seletor do INTERVALO muda rangeDateField sem tocar em dateField', async () => {
    const user = userEvent.setup();
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());

    await user.selectOptions(screen.getByLabelText('Data do intervalo (De/Até)'), 'payment_date');

    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ rangeDateField: 'payment_date', dateField: 'due_date' }),
      ),
    );
  });

  it('o seletor do PERÍODO muda dateField sem tocar em rangeDateField', async () => {
    const user = userEvent.setup();
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());

    await user.selectOptions(screen.getByLabelText(/Tipo de data/i), 'issue_date');

    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ dateField: 'issue_date', rangeDateField: 'due_date' }),
      ),
    );
  });

  // O nome acessível dos campos De/Até tem de seguir o seletor que REALMENTE os governa.
  // Derivá-lo de `dateField` faria o leitor de tela anunciar "Vencimento — data inicial"
  // enquanto a consulta usa payment_date: erro mudo, que nenhuma asserção de dado pega.
  it('o rótulo dos campos De/Até acompanha o seletor do intervalo', async () => {
    const user = userEvent.setup();
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());

    await user.selectOptions(screen.getByLabelText('Data do intervalo (De/Até)'), 'payment_date');

    expect(screen.getByLabelText('Pagamento — data inicial')).toBeInTheDocument();
    expect(screen.getByLabelText('Pagamento — data final')).toBeInTheDocument();
  });

  // rangeDateField mora em BASE_FILTERS — é isso que faz o card "A vencer em 7 dias"
  // continuar sendo 7 dias de VENCIMENTO mesmo com "Pagamento" escolhido antes do clique.
  // Declará-lo só em initialFilters() passaria em todo o resto da suíte.
  it('o card "A vencer em 7 dias" reseta o intervalo para vencimento', async () => {
    const user = userEvent.setup();
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());

    await user.selectOptions(screen.getByLabelText('Data do intervalo (De/Até)'), 'payment_date');
    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ rangeDateField: 'payment_date' }),
      ),
    );

    await user.click(screen.getByText('A vencer em 7 dias'));

    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ rangeDateField: 'due_date' }),
      ),
    );
  });

  it('alteração de situação em lote: aplica "pago" nas selecionadas e atualiza as linhas otimisticamente', async () => {
    const user = userEvent.setup();
    getFinancialAccountControl.mockResolvedValue({
      data: [makeRow(), makeRow({ id: 2, invoice_number: '67890' })],
      total: 2,
    });
    render(<Consulta />);
    await screen.findByText('12345');

    // Seleciona as duas linhas e escolhe a nova situação na barra de seleção.
    await user.click(screen.getByRole('checkbox', { name: 'Selecionar todas as linhas' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Selecionar nova situação' }),
      String(STATUS_ID_PAGO),
    );
    await user.click(screen.getByRole('button', { name: 'Aplicar' }));

    // Uma única requisição em lote com os ids selecionados + o status_id.
    await waitFor(() =>
      expect(setFinancialAccountStatusBulk).toHaveBeenCalledWith([1, 2], STATUS_ID_PAGO),
    );
    expect(setFinancialAccountStatusBulk).toHaveBeenCalledTimes(1);

    // Update otimista: as duas linhas exibem "pago" sem refetch do grid.
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /Situação: pago/ })).toHaveLength(2),
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
  // ── 2ª linha de filtros: classificação contábil ─────────────────────────────
  // Independentes (AND) e aplicados no "Buscar", como os selects da 1ª linha.

  // O PLANO é o único dos 4 que não é <select> nativo (é o ChartAccountSelect, react-select
  // com carga tardia), e por isso é o único cujo call site poderia quebrar em silêncio: a
  // chave viaja por SPREAD para getFinancialAccountControl e é opcional do outro lado, então
  // renomeá-la só aqui sai com `tsc --noEmit` exit 0. Este caso dirige o componente REAL —
  // abre o menu, escolhe a descrição e verifica que ela chega ao serviço.
  // SEM clicar em "Buscar" — este caso cobria o plano pelo caminho do botão, que lê `f`
  // inteiro e por isso passaria mesmo se `queueApply` perdesse o patch. O plano é o único
  // dos 4 filtros que não é <select> nativo, então é justamente o que mais precisa do
  // caminho auto-aplicado exercitado ponta a ponta.
  it('escolher o PLANO aplica sozinho, com chartAccountDescription', async () => {
    const user = userEvent.setup();
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());

    await user.click(screen.getByRole('combobox', { name: 'Filtrar por plano de contas' }));
    await user.click(await screen.findByText('Serviços Gerais'));

    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ chartAccountDescription: 'Serviços Gerais' }),
      ),
    );
  });

  // ALINHAMENTO das duas linhas de filtro. A promessa é "cada filtro contábil tem a
  // largura do controle logo acima" — e isso é ESTRUTURAL: uma única declaração de tracks
  // mais o `col-start-2` do primeiro item da 2ª linha. jsdom não faz layout, então o
  // guarda observa o que DECIDE a largura (a posição na grade), não a largura medida.
  //
  // O par de asserções é o que dá dente: sem a 2ª, trocar o template de colunas quebraria
  // o alinhamento com o teste verde; sem a 1ª, remover o `col-start-2` faria o mesmo.
  it('a 2ª linha de filtros começa na coluna da Empresa (larguras herdadas da 1ª)', async () => {
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());

    const grade = document.querySelector('.overflow-x-auto > .grid');
    expect(grade).not.toBeNull();
    // Tracks: 1=busca 2=Empresa 3=Tipo Documento 4=Tipo Pagamento 5=Situação 6/7=datas
    // 8=seletor da coluna de data (1ª linha) / Limpar (2ª). As colunas 6-8 são IGUAIS
    // (8,5rem) para que os campos de data, o seletor e os dois botões casem entre si —
    // é isso que mantém "Buscar" sob "data final" e "Limpar" sob "Vencimento" com a
    // mesma largura. As 3 e 4 voltaram a 11/10rem: em 9rem os placeholders "Tipo
    // Documento"/"Tipo Pagamento" ficavam CORTADOS no estado vazio, que é justamente
    // quando o rótulo é a única pista do que o campo faz. A 1 subiu de 22,5rem para 25rem
    // quando os controles da toolbar do grid passaram a ocupar a célula sob a busca: os
    // quatro botões somam ~24,5rem e invadiriam a coluna 2 na largura mínima da grade.
    expect(grade?.className).toContain(
      'grid-cols-[minmax(25rem,1fr)_16.5rem_11rem_10rem_10rem_8.5rem_8.5rem_8.5rem]',
    );
    // A folga da direita é absorvida pela BUSCA, não deixada em branco: `w-full` faz a
    // grade ocupar o contêiner e o `1fr` da coluna 1 come a sobra, encostando todo o
    // resto à direita. `min-w-max` é o par obrigatório — sem ele a grade encolheria
    // abaixo dos tracks em tela estreita, em vez de rolar no `overflow-x-auto`.
    expect(grade?.className).toContain('w-full');
    expect(grade?.className).toContain('min-w-max');

    // O plano ancora a 2ª linha na coluna 2 (sob "Empresa"); sub grupo, grupo e centro de
    // custo caem em 3, 4 e 5 pelo auto-placement.
    const plano = screen.getByRole('combobox', { name: 'Filtrar por plano de contas' });
    const celulaDoPlano = plano.closest('.col-start-2');
    expect(celulaDoPlano).not.toBeNull();
    expect(celulaDoPlano?.parentElement).toBe(grade);

    // As outras TRÊS âncoras. Não são estilo: o cursor do auto-placement nunca anda para
    // trás, então sem `col-start-7` os dois botões escorregariam para a coluna 6 (livre
    // desde que o seletor de data subiu para a 1ª linha), e sem `col-start-8` o "Limpar"
    // deixaria de fechar a linha sob o seletor.
    const seletorDeData = screen.getByLabelText('Data do intervalo (De/Até)');
    expect(seletorDeData.closest('.col-start-8')).not.toBeNull();
    expect(screen.getByRole('button', { name: /^Buscar/ }).className).toContain('col-start-7');
    expect(screen.getByRole('button', { name: 'Limpar' }).className).toContain('col-start-8');
  });

  // Os controles da toolbar do grid (densidade · colunas · restaurar) moram na 1ª coluna da
  // 2ª linha de filtros, sob a busca — não mais soltos acima do grid. Como eles chegam lá por
  // PORTAL, um `getByRole` comum continuaria achando os botões em qualquer lugar da página:
  // é a POSIÇÃO no DOM que precisa ser observada, senão remover `toolbarControlsTarget` (ou
  // trocar o portal por render inline) devolveria os botões para cima do grid com a suíte
  // inteira verde.
  it('os controles do grid ficam na 1ª coluna da 2ª linha de filtros', async () => {
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());

    const grade = document.querySelector('.overflow-x-auto > .grid');
    expect(grade).not.toBeNull();

    // Os três controles estão DENTRO da grade de filtros…
    const restaurar = screen.getByRole('button', { name: /Restaurar/ });
    const colunas = screen.getByRole('button', { name: /Colunas/ });
    const densidade = screen.getByRole('group', { name: 'Densidade das linhas' });
    for (const el of [restaurar, colunas, densidade]) {
      expect(grade?.contains(el)).toBe(true);
    }

    // …e o slot que os recebe é o PRIMEIRO filho da grade depois dos 8 itens da 1ª linha,
    // isto é, a célula da coluna 1 da 2ª linha — a que fica sob o campo de busca.
    const slot = restaurar.parentElement?.parentElement;
    expect(slot?.parentElement).toBe(grade);
    const itens = Array.from(grade?.children ?? []);
    expect(itens.indexOf(slot as Element)).toBe(8); // 0..7 = 1ª linha; 8 = 1ª célula da 2ª

    // Sanidade do guarda: o item seguinte é o plano de contas, ancorado na coluna 2. Sem
    // esta linha, o caso passaria mesmo se a 2ª linha tivesse perdido os filtros contábeis.
    expect(itens[9].className).toContain('col-start-2');
  });

  // A barra de seleção também sai por PORTAL — agora para o cabeçalho da página. Como no
  // caso acima, `getByText('2 selecionadas')` a acharia em qualquer lugar do DOM: o que
  // precisa ser observado é a POSIÇÃO. Se ela voltasse para cima do grid, os 48px da faixa
  // reservada voltariam com ela e a única evidência seria o espaço em branco na tela.
  it('a barra de seleção fica no cabeçalho da página, não acima do grid', async () => {
    const user = userEvent.setup();
    getFinancialAccountControl.mockResolvedValue({ data: [makeRow()], total: 1 });
    render(<Consulta />);
    await screen.findByText('12345');

    await user.click(screen.getByRole('checkbox', { name: 'Selecionar todas as linhas' }));

    // O cabeçalho é o irmão ANTERIOR à área rolável — é ele que fica fixo com o grid rolado.
    const rolavel = document.querySelector('.overflow-y-auto');
    const cabecalho = rolavel?.previousElementSibling;
    expect(cabecalho?.textContent).toContain('Consulta de movimentações');

    const barra = screen.getByText('1 selecionada').closest('div');
    expect(cabecalho?.contains(barra as Node)).toBe(true);
    // …e nada dela sobrou dentro da área que rola, onde o grid vive.
    expect(rolavel?.contains(barra as Node)).toBe(false);
    // Sanidade: a faixa reservada de 48px não existe mais em lugar nenhum da página.
    expect(document.querySelector('.min-h-12')).toBeNull();
  });

  // O cabeçalho passou a dividir a linha com a barra de seleção, e em ~1366px de largura a
  // soma (título + barra + botões) fica no limite. Sem `truncate` o texto QUEBRA em duas
  // linhas, o cabeçalho vai de 38px para ~58px e o grid desce ao marcar a primeira conta —
  // o salto que trazer a barra para cá existe para eliminar. jsdom não faz layout, então o
  // guarda observa o que DECIDE o comportamento: as classes que impedem a quebra.
  it('o título do cabeçalho encolhe sem quebrar linha (não cresce a altura)', async () => {
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());

    const titulo = screen.getByRole('heading', { name: 'Consulta de movimentações' });
    expect(titulo.className).toContain('truncate');
    // O bloco precisa PODER encolher (min-w-0) — com `truncate` sozinho, e o piso
    // min-content de volta, o título empurraria a barra em vez de reticenciar.
    expect(titulo.parentElement?.className).toContain('min-w-0');
    // O subtítulo divide a mesma coluna: sem truncate, é ele que quebra.
    expect(screen.getByText('Contas a pagar').className).toContain('truncate');
  });

  // MESMA armadilha do menu do filtro de plano, agora no botão "Colunas": ao trazer a toolbar
  // para a barra de filtros, o popover (que era `absolute`) passou a viver dentro do
  // `overflow-x-auto`, cujo `overflow-y` computa para `auto` e corta na vertical. Ele abria
  // clipado — a gestão de colunas ficava inutilizável, sem erro nenhum. Medido por sonda antes
  // da correção. jsdom não faz layout, então o guarda é ESTRUTURAL: o painel não pode ter
  // ancestral que corte o overflow.
  it('o painel de Colunas abre FORA do contêiner que corta o overflow', async () => {
    const user = userEvent.setup();
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /Colunas/ }));
    const painel = await screen.findByRole('dialog', { name: 'Gerenciar colunas' });

    // Sanidade: o contêiner que corta EXISTE nesta tela. Sem isto, renomear a classe faria o
    // `closest` abaixo devolver null por engano e o caso passaria com o painel clipado.
    expect(document.querySelector('.overflow-x-auto')).not.toBeNull();
    expect(painel.closest('.overflow-x-auto')).toBeNull();
  });

  // REGRESSÃO VISUAL que nenhum teste de dado pegava: a grade única de filtros vive num
  // `overflow-x-auto`, e `overflow-x: auto` com `overflow-y: visible` faz o Y computar
  // para `auto` — o contêiner corta na vertical. O react-select renderiza o menu inline,
  // logo abaixo do controle, então ele nascia CLIPADO: nenhuma opção aparecia na tela.
  // Digitar o texto exato "funcionava" só porque a opção invisível ficava focada e o
  // Enter a escolhia — daí o relato "só acha com o texto inteiro; o grid não filtra".
  //
  // O guarda é ESTRUTURAL (jsdom não faz layout, então não há como medir o clipe): a
  // opção renderizada não pode ter nenhum ancestral que corte o overflow.
  it('o menu do filtro de plano abre FORA do contêiner que corta o overflow', async () => {
    const user = userEvent.setup();
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());

    await user.click(screen.getByRole('combobox', { name: 'Filtrar por plano de contas' }));
    const opcao = await screen.findByText('Serviços Gerais');

    // Sanidade do guarda: o contêiner que corta EXISTE nesta tela. Sem esta asserção, o
    // caso passaria trivialmente se a classe fosse renomeada e o menu voltasse a ser
    // clipado por um contêiner que o `closest` abaixo não conhece mais.
    expect(document.querySelector('.overflow-x-auto')).not.toBeNull();
    expect(opcao.closest('.overflow-x-auto')).toBeNull();
  });

  // O grid vazio precisa dizer em QUE ESCOPO não achou. Um plano que existe no cadastro
  // mas não tem conta NAQUELE MÊS devolve zero linhas — e a mensagem antiga ("ajuste os
  // filtros e clique em Buscar") fazia isso parecer filtro quebrado, além de mandar
  // clicar num botão que hoje ALARGA o período em vez de aplicar.
  // 🔴 As DUAS metades do nome precisam ser observadas. Até 2026-08-07 só a primeira era: o
  // caso afirmava "e aponta o caminho de alargar" e não asseverava nada sobre isso — reescrever
  // a segunda frase da mensagem passava com a suíte verde (foi o que aconteceu ao alinhar o
  // texto com o novo nome do botão). A 2ª asserção compara a mensagem com o NOME ACESSÍVEL do
  // próprio botão, em vez de repetir a frase: assim a instrução ("use Buscar para…") e o que o
  // leitor de tela anuncia ao chegar nele não podem divergir sem alguém ficar vermelho.
  it('o grid vazio nomeia o mês em vigor e aponta o caminho de alargar', async () => {
    render(<Consulta />);
    const now = new Date();
    const mes = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho',
      'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'][now.getMonth()];

    const mensagem = await screen.findByText(
      new RegExp(`Nenhum registro em ${mes}/${now.getFullYear()}`),
    );
    expect(mensagem).toBeInTheDocument();

    // A ação que a mensagem manda executar é a do botão de busca — sem intervalo em tela,
    // "Buscar em todos os meses e anos".
    const acao = screen
      .getByRole('button', { name: /^Buscar/ })
      .getAttribute('aria-label')
      ?.replace(/^Buscar\s+/, '');
    expect(acao).toBeTruthy(); // sanidade: sem o aria-label o `toContain` abaixo é trivial
    expect(mensagem.textContent ?? '').toContain(acao ?? '');
  });

  it('filtrar por GRUPO consulta com chartAccountGroupId', async () => {
    const user = userEvent.setup();
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());
    await screen.findByRole('option', { name: '24 — Despesas Fixas' });

    await user.selectOptions(screen.getByLabelText('Filtrar por grupo de plano de contas'), '24');
    await user.click(screen.getByRole('button', { name: /^Buscar/ }));

    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ chartAccountGroupId: 24 }),
      ),
    );
  });

  // COALESCÊNCIA: três mudanças em sequência viram UMA consulta, não três. É o guarda da
  // promessa de volume do portão único — sem ele, aplicar no onChange de cada controle
  // dispararia 3 consultas de grid (mais 3 de "Valor total" e 3 de contagem).
  // `fireEvent` (e não `userEvent`) nos três: o intervalo entre eles passa a ser 0 ms, e
  // o guarda deixa de depender de vencer uma corrida contra tempo real. Com `userEvent`
  // eram ~90 ms por `selectOptions` contra a janela de 300 ms — passa, mas uma máquina
  // carregada faria a 1ª consulta sair antes da 3ª mudança e o teste ficaria vermelho
  // sem defeito nenhum. O que se quer travar aqui é a coalescência, não a velocidade.
  it('combina grupo + centro de custo + sub grupo numa consulta só (AND, sem cascata)', async () => {
    render(<Consulta />);
    await screen.findByRole('option', { name: '24 — Despesas Fixas' });
    getFinancialAccountControl.mockClear();

    fireEvent.change(screen.getByLabelText('Filtrar por grupo de plano de contas'), { target: { value: '24' } });
    fireEvent.change(screen.getByLabelText('Filtrar por centro de custo'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Filtrar por sub grupo de plano de contas'), { target: { value: '93' } });

    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ chartAccountGroupId: 24, costCenterId: 4, chartAccountSubgroupId: 93 }),
      ),
    );
    expect(getFinancialAccountControl).toHaveBeenCalledTimes(1);
  });

  // Item 9 do pedido. ATENÇÃO ao que este teste substituiu: havia aqui um caso afirmando
  // "escolher o filtro NÃO consulta antes do Buscar" que continuou VERDE depois da
  // mudança — ele usava `flush()` (0 ms), que não alcança a janela de coalescência, então
  // media apenas "ainda não consultou NESTE instante". Daí o `waitFor` abaixo: ele espera
  // a consulta acontecer de fato, e é o único formato que falha se o auto-aplicar sumir.
  it('escolher o filtro consulta sozinho, sem clicar em "Buscar"', async () => {
    const user = userEvent.setup();
    render(<Consulta />);
    await screen.findByRole('option', { name: '24 — Despesas Fixas' });
    getFinancialAccountControl.mockClear();

    await user.selectOptions(screen.getByLabelText('Filtrar por grupo de plano de contas'), '24');

    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ chartAccountGroupId: 24 }),
      ),
    );
  });

  // Auto-aplicar RESTRINGE dentro do período em tela; só o "Buscar" alarga para toda a
  // base. Sem esta asserção, ligar o select ao handleSearch passaria em tudo.
  it('o filtro auto-aplicado PRESERVA o mês/ano corrente', async () => {
    const user = userEvent.setup();
    render(<Consulta />);
    await screen.findByRole('option', { name: '24 — Despesas Fixas' });
    const now = new Date();

    await user.selectOptions(screen.getByLabelText('Filtrar por grupo de plano de contas'), '24');

    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({
          chartAccountGroupId: 24,
          month: now.getMonth(),
          year: now.getFullYear(),
        }),
      ),
    );
  });

  it('os filtros contábeis alcançam os cards "Valor total"/"Total de registros"', async () => {
    const user = userEvent.setup();
    render(<Consulta />);
    await screen.findByRole('option', { name: '004 — Logística' });
    getFinancialAccountTotalValue.mockClear();
    getFinancialAccountCount.mockClear();

    await user.selectOptions(screen.getByLabelText('Filtrar por centro de custo'), '4');
    await user.click(screen.getByRole('button', { name: /^Buscar/ }));

    await waitFor(() =>
      expect(getFinancialAccountTotalValue).toHaveBeenLastCalledWith(
        expect.objectContaining({ costCenterId: 4 }),
      ),
    );
    expect(getFinancialAccountCount).toHaveBeenLastCalledWith(expect.objectContaining({ costCenterId: 4 }));
  });

  // "Limpar" e os cards derivam de BASE_FILTERS — é isso que zera os 4 campos novos
  // sem nenhuma linha dedicada. O teste trava esse acoplamento.
  it('o botão Limpar zera os filtros contábeis', async () => {
    const user = userEvent.setup();
    render(<Consulta />);
    await screen.findByRole('option', { name: '24 — Despesas Fixas' });

    await user.selectOptions(screen.getByLabelText('Filtrar por grupo de plano de contas'), '24');
    await user.selectOptions(screen.getByLabelText('Filtrar por centro de custo'), '4');
    await user.click(screen.getByRole('button', { name: /^Buscar/ }));
    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ chartAccountGroupId: 24 }),
      ),
    );

    await user.click(screen.getByRole('button', { name: 'Limpar' }));

    await waitFor(() =>
      expect(getFinancialAccountControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ chartAccountGroupId: undefined, costCenterId: undefined }),
      ),
    );
    expect(screen.getByLabelText('Filtrar por grupo de plano de contas')).toHaveValue('');
    expect(screen.getByLabelText('Filtrar por centro de custo')).toHaveValue('');
  });
});
