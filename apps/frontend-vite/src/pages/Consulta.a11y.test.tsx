import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from '../../tests/axe';

// Mocka o serviço de dados — o teste cobre a acessibilidade do layout, não a rede.
const getFinancialAccountControl = vi.fn();
const getFinancialStats = vi.fn();

vi.mock('../services/supabase', () => ({
  getFinancialAccountControl: (...args: unknown[]) => getFinancialAccountControl(...args),
  getFinancialStats: (...args: unknown[]) => getFinancialStats(...args),
  setFinancialAccountFlag: vi.fn(),
  setFinancialAccountStatus: vi.fn(),
  getAppUsers: vi.fn(() => Promise.resolve({})),
  // Opções do filtro de plano de contas (só as EM USO em financial_account_control).
  listUsedChartAccountDescriptions: vi.fn(() => Promise.resolve(['Serviços Gerais'])),
}));

// Consulta usa useAuth (gate do hard delete). Sem provider no teste → mock.
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ isAdminGroup: false }),
}));

// Lookups dos filtros — sem isto o teste iria à rede de verdade. As opções precisam
// existir para o axe avaliar os <select> POPULADOS da 2ª linha, não só o placeholder.
vi.mock('../services/lookups', () => ({
  listCompanies: () => Promise.resolve([{ sk_company: 1, trade_name: 'OTIMOTEX TECIDOS' }]),
  listCostCenters: () =>
    Promise.resolve([{ cost_center_id: 4, cost_center_code: '004', cost_center_description: 'Logística' }]),
  listChartAccountGroups: () =>
    Promise.resolve([{ chart_account_group_id: 24, group_code: '24', group_description: 'Despesas Fixas' }]),
  listChartAccountSubgroups: () =>
    Promise.resolve([
      { chart_account_subgroup_id: 93, subgroup_code: '93', subgroup_description: 'Copa e Cozinha' },
    ]),
  listPlanoDescriptions: () => Promise.resolve([{ account_description: 'Serviços Gerais' }]),
}));

import Consulta from './Consulta';

describe('Consulta — acessibilidade (WCAG AA)', () => {
  beforeEach(() => {
    getFinancialAccountControl.mockResolvedValue({ data: [], total: 0 });
    getFinancialStats.mockResolvedValue({ totalRecords: 0, pending: 0, totalValue: 0, vencendo: 0, vencidas: 0 });
  });

  it('página de consulta (filtros + tabela) não tem violações', async () => {
    const { container } = render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());
    // Espera que OBSERVA o que o mock acima promete: os <select> da 2ª linha POPULADOS.
    // Aguardar só a chamada do serviço de dados não garante isso — os lookups são outra
    // promessa, e se um dia ficarem mais lentos o axe passaria a escanear apenas o
    // placeholder, com o teste seguindo verde (CLAUDE.md §Regra 2: a asserção precisa
    // observar a garantia que o comentário afirma).
    await screen.findByRole('option', { name: '24 — Despesas Fixas' });
    expect(await axe(container)).toHaveNoViolations();
  });

  // O axe pega o `aria-describedby` APONTANDO PARA NADA (id inexistente), mas não pega a
  // ressalva sumindo do texto — e é ela que explica por que "Pagamento" + Situação "a
  // vencer" devolve 0 linhas. Enquanto viveu só no `title`, a informação não existia para
  // teclado, toque nem leitor de tela (com `aria-label` presente, o title não é anunciado
  // de forma confiável).
  //
  // ⚠️ `toHaveAccessibleDescription` NÃO serve aqui, e o mutante provou: sem
  // `aria-describedby`, o próprio `title` passa a ser a descrição acessível computada —
  // então a asserção ficava VERDE com a ligação removida. O guarda tem de olhar a ligação:
  // o atributo existe, aponta para um elemento REAL e é ele que carrega a ressalva.
  it('a ressalva do intervalo por pagamento chega à descrição acessível, não só ao title', async () => {
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());

    const seletor = screen.getByLabelText('Data do intervalo (De/Até)');
    const idDaDescricao = seletor.getAttribute('aria-describedby');
    expect(idDaDescricao).toBeTruthy();

    const descricao = idDaDescricao ? document.getElementById(idDaDescricao) : null;
    expect(descricao).not.toBeNull();
    expect(descricao?.textContent ?? '').toMatch(/contas já pagas/i);
  });

  // WCAG 2.5.3 (Label in Name): quem dita por voz diz o que LÊ. O `aria-label` do botão
  // conta o que ele realmente faz, então precisa CONTER o rótulo visível. A relação é
  // verificada de fato — trocar o texto visível para algo fora do aria-label derruba o teste.
  //
  // O nome é DINÂMICO porque o efeito é: sem intervalo, o clique alarga o período para todos
  // os meses e anos; com intervalo preenchido, o período já está global e o intervalo é
  // preservado — anunciar "todos os períodos" ali seria falso. Os DOIS estados são cobertos:
  // um caso só deixaria a metade não exercitada livre para mentir.
  it('o botão de busca cumpre "Label in Name" nos dois estados', async () => {
    const user = userEvent.setup();
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());

    const botao = screen.getByRole('button', { name: /^Buscar/ });
    const rotuloVisivel = (botao.textContent ?? '').trim();
    expect(rotuloVisivel).not.toBe(''); // sanidade: sem isto o `toContain` abaixo é trivial

    // Estado 1 — sem intervalo: o clique alarga o período.
    const semIntervalo = botao.getAttribute('aria-label') ?? rotuloVisivel;
    expect(semIntervalo).toContain(rotuloVisivel);
    // Esta 2ª asserção é o que dá dente ao guarda: só o `toContain` acima ficava VERDE com o
    // aria-label removido (o fallback compara o rótulo consigo mesmo).
    expect(semIntervalo).toMatch(/todos os meses e anos/i);

    // Estado 2 — com intervalo: o nome precisa parar de prometer alargamento e dizer que o
    // intervalo permanece, que é o que a consulta faz.
    await user.type(screen.getByLabelText('Vencimento — data inicial'), '2026-07-01');
    await waitFor(() =>
      expect(botao.getAttribute('aria-label')).toMatch(/mantendo o intervalo/i),
    );
    const comIntervalo = botao.getAttribute('aria-label') ?? '';
    expect(comIntervalo).toContain(rotuloVisivel);
    expect(comIntervalo).not.toMatch(/todos os meses/i);
  });

  // Contraparte do seletor do intervalo: o do PERÍODO também carrega uma ressalva de
  // comportamento (com o intervalo preenchido ele fica suspenso), e ela precisa existir na
  // árvore acessível — não só no `title`, que com `aria-label` presente não é anunciado de
  // forma confiável. Mesmo formato do guarda do intervalo: ler a LIGAÇÃO, não a descrição
  // computada, senão o `title` a preenche sozinho e o caso fica verde sem o describedby.
  it('a ressalva do seletor de período chega à descrição acessível', async () => {
    render(<Consulta />);
    await waitFor(() => expect(getFinancialAccountControl).toHaveBeenCalled());

    const seletor = screen.getByLabelText('Tipo de data do período (vencimento ou emissão)');
    const idDaDescricao = seletor.getAttribute('aria-describedby');
    expect(idDaDescricao).toBeTruthy();

    const descricao = idDaDescricao ? document.getElementById(idDaDescricao) : null;
    expect(descricao).not.toBeNull();
    expect(descricao?.textContent ?? '').toMatch(/botões de mês e ano/i);
  });

  // A barra de seleção do grid passou a viver no CABEÇALHO da página, e ela só existe com
  // linha marcada — estado que nenhum dos casos acima alcança. Sem este, cinco controles
  // novos (texto, select de situação, "Aplicar", "Exportar selecionadas", ✕) entram numa
  // linha que antes só tinha título + 2 botões, e qualquer violação ali passa em 830/830.
  // Mesmo princípio de `DashboardHeader.a11y.test.tsx`, que varre os dois estados que
  // mudam a árvore acessível.
  it('com linhas selecionadas (barra de seleção no cabeçalho) não tem violações', async () => {
    const user = userEvent.setup();
    getFinancialAccountControl.mockResolvedValue({
      data: [
        {
          id: 1,
          invoice_number: '12345',
          amount: 100,
          status_id: 3,
          due_date: '2026-08-20',
          issue_date: '2026-08-01',
          has_invoice: false,
          has_bank_slip: false,
        },
      ],
      total: 1,
    });
    const { container } = render(<Consulta />);
    await screen.findByText('12345');

    await user.click(screen.getByRole('checkbox', { name: 'Selecionar todas as linhas' }));
    // Sanidade: sem esta espera o axe poderia varrer o cabeçalho AINDA sem a barra, e o
    // caso mediria de novo o estado em repouso — verde sem cobrir nada.
    await screen.findByText('1 selecionada');

    expect(await axe(container)).toHaveNoViolations();
  });
});
