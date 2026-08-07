import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/lookups', () => ({
  listPlanoDescriptions: vi.fn().mockResolvedValue([]),
}));
// FONTES DISTINTAS por variante (não unificar): o 'form' oferece o cadastro INTEIRO (Next
// API), o 'filter' só os planos com conta em financial_account_control (Supabase REST, com
// a RLS do usuário). Mockar as duas é o que permite provar que cada variante usa a sua.
vi.mock('../../services/supabase', () => ({
  listUsedChartAccountDescriptions: vi.fn().mockResolvedValue([]),
}));

import { listPlanoDescriptions } from '../../services/lookups';
import { listUsedChartAccountDescriptions } from '../../services/supabase';
import ChartAccountSelect from './ChartAccountSelect';

// Devolve as descrições no formato de cada fonte: a do cadastro é uma lista de objetos,
// a dos planos EM USO é uma lista de strings já deduplicada.
const comoCadastro = (ds: string[]) => ds.map((account_description) => ({ account_description }));

// Corpo em BLOCO de propósito: `() => mock.mockReset()` devolveria o próprio mock, e o
// Vitest trata retorno de função num hook como TEARDOWN — chamando o mock ao fim do teste.
beforeEach(() => {
  vi.mocked(listPlanoDescriptions).mockReset();
  vi.mocked(listPlanoDescriptions).mockResolvedValue([]);
  vi.mocked(listUsedChartAccountDescriptions).mockReset();
  vi.mocked(listUsedChartAccountDescriptions).mockResolvedValue([]);
});

// 1º select da cascata INVERTIDA: o plano de contas é escolhido pela DESCRIÇÃO (o value é
// a própria descrição, não um id). O centro (CostCenterSelect) resolve o chart_account_id.
describe('ChartAccountSelect (plano de contas por descrição)', () => {
  it('renderiza o rótulo', () => {
    render(<ChartAccountSelect label="Plano de contas" value={null} onChange={vi.fn()} />);
    expect(screen.getByText('Plano de contas')).toBeInTheDocument();
  });

  it('exibe a descrição já selecionada (modo edição)', () => {
    render(<ChartAccountSelect label="Plano de contas" value="Serviços Gerais" onChange={vi.fn()} />);
    expect(screen.getByText('Serviços Gerais')).toBeInTheDocument();
  });

  it('é controlado: reflete a mudança do value após montado (não some)', () => {
    const { rerender } = render(<ChartAccountSelect label="Plano de contas" value={null} onChange={vi.fn()} />);
    rerender(<ChartAccountSelect label="Plano de contas" value="Frete sobre vendas" onChange={vi.fn()} />);
    expect(screen.getByText('Frete sobre vendas')).toBeInTheDocument();
  });

  it('mostra erro claro quando o lookup falha (API indisponível), não "nenhum encontrado"', async () => {
    vi.mocked(listPlanoDescriptions).mockRejectedValueOnce(new Error('network'));
    render(<ChartAccountSelect label="Plano de contas" value={null} onChange={vi.fn()} />);
    expect(await screen.findByText(/API de dados indisponível/i)).toBeInTheDocument();
  });

  // variant='form' (o padrão) carrega a lista na montagem — é o que os 4 casos acima já
  // exercitam (o de erro depende disso). Explicitado aqui para o contraste com o filtro.
  it("variant='form' (padrão) carrega a lista na montagem", () => {
    render(<ChartAccountSelect label="Plano de contas" value={null} onChange={vi.fn()} />);
    expect(listPlanoDescriptions).toHaveBeenCalled();
  });
});

// Usado na BARRA DE FILTRO de /consulta, onde o campo é opcional e raramente aberto.
describe("ChartAccountSelect variant='filter'", () => {
  // O ponto da variante: com ~530 descrições, carregar na montagem custaria uma
  // requisição na ABERTURA de /consulta — exatamente o que o requisito proíbe.
  it('NÃO vai à rede na montagem', () => {
    render(<ChartAccountSelect variant="filter" label="Filtrar por plano de contas" value={null} onChange={vi.fn()} />);
    expect(listUsedChartAccountDescriptions).not.toHaveBeenCalled();
  });

  it('carrega a lista no primeiro clique que abre o menu', async () => {
    const user = userEvent.setup();
    vi.mocked(listUsedChartAccountDescriptions).mockResolvedValue(['Serviços Gerais']);
    render(<ChartAccountSelect variant="filter" label="Filtrar por plano de contas" value={null} onChange={vi.fn()} />);

    await user.click(screen.getByRole('combobox', { name: 'Filtrar por plano de contas' }));
    expect(await screen.findByText('Serviços Gerais')).toBeInTheDocument();
    expect(listUsedChartAccountDescriptions).toHaveBeenCalledTimes(1);
  });

  it('não repete a carga a cada abertura do menu', async () => {
    const user = userEvent.setup();
    vi.mocked(listUsedChartAccountDescriptions).mockResolvedValue(['Serviços Gerais']);
    render(<ChartAccountSelect variant="filter" label="Filtrar por plano de contas" value={null} onChange={vi.fn()} />);
    const combo = screen.getByRole('combobox', { name: 'Filtrar por plano de contas' });

    await user.click(combo);
    await screen.findByText('Serviços Gerais');
    await user.keyboard('{Escape}');
    await user.click(combo);

    expect(listUsedChartAccountDescriptions).toHaveBeenCalledTimes(1);
  });

  // Sem rótulo em bloco (a barra de filtro não tem rótulos visíveis — o placeholder
  // nomeia o campo), mas o nome ACESSÍVEL continua existindo: é requisito WCAG e é o
  // que o teste acima usa para achar o combobox.
  it('não renderiza o rótulo em bloco, mas mantém o nome acessível', () => {
    render(<ChartAccountSelect variant="filter" label="Filtrar por plano de contas" value={null} onChange={vi.fn()} />);
    expect(screen.queryByText('Filtrar por plano de contas')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Filtrar por plano de contas' })).toBeInTheDocument();
  });

  // Falha TRANSITÓRIA não pode fossilizar: `loadOptions` engole a exceção e devolve [],
  // então gravar esse [] marcaria "já carregado" e a guarda do handler bloquearia toda
  // abertura seguinte — a Next API piscando no instante da 1ª abertura deixava o menu
  // vazio pelo resto do mount.
  it('retenta na abertura seguinte quando a 1ª carga falhou', async () => {
    const user = userEvent.setup();
    vi.mocked(listUsedChartAccountDescriptions).mockRejectedValueOnce(new Error('502'));
    vi.mocked(listUsedChartAccountDescriptions).mockResolvedValue(['Serviços Gerais']);
    render(<ChartAccountSelect variant="filter" label="Filtrar por plano de contas" value={null} onChange={vi.fn()} />);
    const combo = screen.getByRole('combobox', { name: 'Filtrar por plano de contas' });

    await user.click(combo);
    expect(await screen.findAllByText(/API de dados indisponível/i)).not.toHaveLength(0);
    await user.keyboard('{Escape}');

    await user.click(combo);
    expect(await screen.findByText('Serviços Gerais')).toBeInTheDocument();
    expect(listUsedChartAccountDescriptions).toHaveBeenCalledTimes(2);
  });

  it('exibe a descrição já selecionada (filtro vindo do estado da página)', () => {
    render(<ChartAccountSelect variant="filter" label="Filtrar por plano de contas" value="Serviços Gerais" onChange={vi.fn()} />);
    expect(screen.getByText('Serviços Gerais')).toBeInTheDocument();
  });

  // O GUARDA da separação de fontes, nos dois sentidos. O filtro oferece só os planos com
  // conta em financial_account_control (escolher um plano sem conta devolvia grid vazio,
  // indistinguível de filtro quebrado); o formulário precisa do cadastro INTEIRO, senão a
  // PRIMEIRA conta de um plano novo seria impossível de classificar. Um teste de mão única
  // continuaria verde se as duas variantes voltassem a compartilhar a mesma fonte.
  it('o FILTRO usa só os planos em uso; o FORMULÁRIO, o cadastro inteiro', async () => {
    const user = userEvent.setup();
    vi.mocked(listUsedChartAccountDescriptions).mockResolvedValue(['Em uso']);
    vi.mocked(listPlanoDescriptions).mockResolvedValue(comoCadastro(['Em uso', 'Nunca usado']));

    const { unmount } = render(
      <ChartAccountSelect variant="filter" label="Filtrar por plano de contas" value={null} onChange={vi.fn()} />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Filtrar por plano de contas' }));
    expect(await screen.findByText('Em uso')).toBeInTheDocument();
    expect(screen.queryByText('Nunca usado')).not.toBeInTheDocument();
    expect(listPlanoDescriptions).not.toHaveBeenCalled();
    unmount();

    render(<ChartAccountSelect label="Plano de contas" value={null} onChange={vi.fn()} />);
    await user.click(screen.getByRole('combobox', { name: 'Plano de contas' }));
    expect(await screen.findByText('Nunca usado')).toBeInTheDocument();
    expect(listUsedChartAccountDescriptions).toHaveBeenCalledTimes(1); // só a do filtro acima
  });
});

// ── Busca digitada: filtro em MEMÓRIA, uma requisição só ──────────────────────────
// O defeito que originou estes casos: cada tecla disparava `?search=<termo>` no servidor.
// Medido no dev server com o cadastro real — 420 a 1160 ms por requisição, respostas fora
// de ordem, e o react-select descartando todas menos a da última emitida. Na prática a
// lista só assentava quando o usuário PARAVA de digitar.
describe('ChartAccountSelect — busca digitada', () => {
  const CATALOGO = ['Aluguel', 'Descarga de Mercadorias', 'Mercadorias para Revenda', 'Serviços Gerais'];

  // O guarda do defeito. Um `toHaveBeenCalled()` continuaria verde com a versão antiga —
  // é a CONTAGEM (1, não uma por caractere) e o ARGUMENTO (nenhum: o catálogo inteiro)
  // que provam que a digitação deixou de ir à rede.
  it('digitar NÃO gera uma requisição por caractere — o catálogo vem uma vez só', async () => {
    const user = userEvent.setup();
    vi.mocked(listUsedChartAccountDescriptions).mockResolvedValue(CATALOGO);
    render(<ChartAccountSelect variant="filter" label="Filtrar por plano de contas" value={null} onChange={vi.fn()} />);

    const combo = screen.getByRole('combobox', { name: 'Filtrar por plano de contas' });
    await user.click(combo);
    await screen.findByText('Aluguel');
    await user.type(combo, 'merca');

    expect(listUsedChartAccountDescriptions).toHaveBeenCalledTimes(1);
    expect(listUsedChartAccountDescriptions).toHaveBeenCalledWith();
  });

  it('digitar um trecho oferece as descrições que o contêm', async () => {
    const user = userEvent.setup();
    vi.mocked(listUsedChartAccountDescriptions).mockResolvedValue(CATALOGO);
    render(<ChartAccountSelect variant="filter" label="Filtrar por plano de contas" value={null} onChange={vi.fn()} />);

    const combo = screen.getByRole('combobox', { name: 'Filtrar por plano de contas' });
    await user.click(combo);
    await user.type(combo, 'merca');

    expect(await screen.findByText('Mercadorias para Revenda')).toBeInTheDocument();
    expect(screen.getByText('Descarga de Mercadorias')).toBeInTheDocument();
    // Sanidade: sem esta linha o caso passaria mesmo se o filtro não filtrasse nada.
    expect(screen.queryByText('Aluguel')).not.toBeInTheDocument();
  });

  // pt-BR: o `ilike` do PostgreSQL, que fazia a busca antes, é case-insensitive mas NÃO
  // ignora acento — então "servicos" não achava "Serviços". O filtro em memória acha.
  it('a busca ignora acento e caixa', async () => {
    const user = userEvent.setup();
    vi.mocked(listUsedChartAccountDescriptions).mockResolvedValue(CATALOGO);
    render(<ChartAccountSelect variant="filter" label="Filtrar por plano de contas" value={null} onChange={vi.fn()} />);

    const combo = screen.getByRole('combobox', { name: 'Filtrar por plano de contas' });
    await user.click(combo);
    await user.type(combo, 'SERVICOS');

    expect(await screen.findByText('Serviços Gerais')).toBeInTheDocument();
    expect(screen.queryByText('Aluguel')).not.toBeInTheDocument();
  });
});
