import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/lookups', () => ({
  listPlanoDescriptions: vi.fn().mockResolvedValue([]),
}));

import { listPlanoDescriptions } from '../../services/lookups';
import ChartAccountSelect from './ChartAccountSelect';

// Corpo em BLOCO de propósito: `() => mock.mockReset()` devolveria o próprio mock, e o
// Vitest trata retorno de função num hook como TEARDOWN — chamando o mock ao fim do teste.
beforeEach(() => {
  vi.mocked(listPlanoDescriptions).mockReset();
  vi.mocked(listPlanoDescriptions).mockResolvedValue([]);
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
    expect(listPlanoDescriptions).not.toHaveBeenCalled();
  });

  it('carrega a lista no primeiro clique que abre o menu', async () => {
    const user = userEvent.setup();
    vi.mocked(listPlanoDescriptions).mockResolvedValue([{ account_description: 'Serviços Gerais' }]);
    render(<ChartAccountSelect variant="filter" label="Filtrar por plano de contas" value={null} onChange={vi.fn()} />);

    await user.click(screen.getByRole('combobox', { name: 'Filtrar por plano de contas' }));
    expect(await screen.findByText('Serviços Gerais')).toBeInTheDocument();
    expect(listPlanoDescriptions).toHaveBeenCalledTimes(1);
  });

  it('não repete a carga a cada abertura do menu', async () => {
    const user = userEvent.setup();
    vi.mocked(listPlanoDescriptions).mockResolvedValue([{ account_description: 'Serviços Gerais' }]);
    render(<ChartAccountSelect variant="filter" label="Filtrar por plano de contas" value={null} onChange={vi.fn()} />);
    const combo = screen.getByRole('combobox', { name: 'Filtrar por plano de contas' });

    await user.click(combo);
    await screen.findByText('Serviços Gerais');
    await user.keyboard('{Escape}');
    await user.click(combo);

    expect(listPlanoDescriptions).toHaveBeenCalledTimes(1);
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
    vi.mocked(listPlanoDescriptions).mockRejectedValueOnce(new Error('502'));
    vi.mocked(listPlanoDescriptions).mockResolvedValue([{ account_description: 'Serviços Gerais' }]);
    render(<ChartAccountSelect variant="filter" label="Filtrar por plano de contas" value={null} onChange={vi.fn()} />);
    const combo = screen.getByRole('combobox', { name: 'Filtrar por plano de contas' });

    await user.click(combo);
    expect(await screen.findAllByText(/API de dados indisponível/i)).not.toHaveLength(0);
    await user.keyboard('{Escape}');

    await user.click(combo);
    expect(await screen.findByText('Serviços Gerais')).toBeInTheDocument();
    expect(listPlanoDescriptions).toHaveBeenCalledTimes(2);
  });

  it('exibe a descrição já selecionada (filtro vindo do estado da página)', () => {
    render(<ChartAccountSelect variant="filter" label="Filtrar por plano de contas" value="Serviços Gerais" onChange={vi.fn()} />);
    expect(screen.getByText('Serviços Gerais')).toBeInTheDocument();
  });
});
