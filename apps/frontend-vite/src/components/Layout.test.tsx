import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// Mock do contexto de auth — sem sessão real nos testes.
const signOut = vi.fn();
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { email: 'suporte@sheild.app.br' }, signOut }),
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

  it('mostra "Contas bancárias" no grupo Tabelas, logo abaixo de Bancos', () => {
    renderLayout();
    const bancos = screen.getByText('Bancos');
    const contas = screen.getByText('Contas bancárias');
    const centro = screen.getByText('Centro de custos');
    // Ordem no DOM: Bancos → Contas bancárias → Centro de custos.
    expect(bancos.compareDocumentPosition(contas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(contas.compareDocumentPosition(centro) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('exibe as iniciais do e-mail e não há mais itens "breve" (Dashboard ativo)', () => {
    renderLayout();
    expect(screen.getByText('SU')).toBeInTheDocument(); // iniciais de "suporte@..."
    // Dashboard foi promovido a link ativo — nenhum item fica mais "breve".
    expect(screen.queryByText('breve')).not.toBeInTheDocument();
    expect(screen.getByText('Dashboard de Vencimentos')).toBeInTheDocument();
  });

  it('aciona signOut ao clicar em sair', async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByTitle('Sair'));
    expect(signOut).toHaveBeenCalled();
  });
});
