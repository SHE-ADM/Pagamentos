import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// Mock do contexto de auth — sem sessão real nos testes.
const signOut = vi.fn();
// `vi.hoisted` para o valor poder ser trocado por caso (padrão de CrudTablePage.test.tsx).
const auth = vi.hoisted((): { aiChatEnabled: boolean | null } => ({ aiChatEnabled: true }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { email: 'suporte@sheild.app.br' },
    signOut,
    aiChatEnabled: auth.aiChatEnabled,
  }),
}));

import Layout from './Layout';

function renderLayout() {
  return render(
    <MemoryRouter>
      <Layout>
        <div>conteúdo</div>
      </Layout>
    </MemoryRouter>,
  );
}

describe('Layout (sidebar)', () => {
  it('renderiza os links ativos e o conteúdo filho', () => {
    renderLayout();
    // "E-mails" e "Log de erros" aparecem tanto em Recebimentos quanto em Envios (ambos ativos)
    expect(screen.getAllByText('E-mails').length).toBeGreaterThan(0);
    expect(screen.getByText('Gestão de contas')).toBeInTheDocument();
    expect(screen.getAllByText('Log de erros').length).toBeGreaterThan(0);
    expect(screen.getByText('conteúdo')).toBeInTheDocument();
  });

  it('ordena o grupo Tabelas: Plano de contas → Grupos → Sub grupos → Centro de custos → Contas bancárias → Bancos', () => {
    renderLayout();
    const plano = screen.getByText('Plano de contas');
    const grupos = screen.getByText('Grupos de plano de contas');
    const subgrupos = screen.getByText('Sub grupos de plano de contas');
    const centro = screen.getByText('Centro de custos');
    const contas = screen.getByText('Contas bancárias');
    const bancos = screen.getByText('Bancos');
    expect(plano.compareDocumentPosition(grupos) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(grupos.compareDocumentPosition(subgrupos) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(subgrupos.compareDocumentPosition(centro) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(centro.compareDocumentPosition(contas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(contas.compareDocumentPosition(bancos) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('exibe as iniciais do e-mail e não há mais itens "breve" (Dashboard ativo)', () => {
    renderLayout();
    expect(screen.getByText('SU')).toBeInTheDocument(); // iniciais de "suporte@..."
    // Dashboard foi promovido a link ativo — nenhum item fica mais "breve".
    expect(screen.queryByText('breve')).not.toBeInTheDocument();
    expect(screen.getByText('Indicadores de Vencimentos')).toBeInTheDocument();
  });

  // 🔴 Restauração em `afterEach`, NÃO no fim do corpo do teste. Escrita lá dentro, ela só roda
  // quando as asserções passam: um caso vermelho deixaria `aiChatEnabled` alterado e os testes
  // SEGUINTES falhariam em cascata, apontando para o lugar errado. Estado de módulo compartilhado
  // por `vi.hoisted` volta ao default no teardown, sempre.
  afterEach(() => {
    auth.aiChatEnabled = true;
  });

  // O assistente de IA vive no Layout (não numa rota) para estar em TODAS as telas
  // protegidas; aqui entra só o botão flutuante — o painel é lazy.
  it('monta o botão flutuante do assistente de IA quando o grupo tem acesso', () => {
    auth.aiChatEnabled = true;
    renderLayout();
    expect(screen.getByRole('button', { name: /abrir assistente/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /assistente de contas a pagar/i })).not.toBeInTheDocument();
  });

  /**
   * 🔴 O caso `null` é o que CONGELA a decisão de produto (Onda 8, migration 120).
   *
   * `false` sozinho ficaria verde com `!== false` no lugar de `=== true` — e aí todo usuário
   * NEGADO veria o botão piscar em cada carga de página, já que sob o default opt-in "negado" é a
   * maioria. É por isso que os dois estados são testados, e não só o óbvio.
   */
  it.each<[string, boolean | null]>([
    ['negado (false)', false],
    ['ainda não sei (null)', null],
  ])('NÃO monta o botão do assistente quando o acesso é %s', (_rotulo, valor) => {
    auth.aiChatEnabled = valor;
    renderLayout();
    expect(screen.queryByRole('button', { name: /abrir assistente/i })).not.toBeInTheDocument();
  });

  it('aciona signOut ao clicar em sair', async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByTitle('Sair'));
    expect(signOut).toHaveBeenCalled();
  });
});
