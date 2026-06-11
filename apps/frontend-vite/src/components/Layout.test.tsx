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
    expect(screen.getByText('E-mails')).toBeInTheDocument();
    expect(screen.getByText('Consulta')).toBeInTheDocument();
    expect(screen.getByText('conteúdo')).toBeInTheDocument();
  });

  it('exibe iniciais do e-mail e badge "soon" nos itens em breve', () => {
    renderLayout();
    expect(screen.getByText('SU')).toBeInTheDocument(); // iniciais de "suporte@..."
    expect(screen.getAllByText('soon').length).toBeGreaterThan(0);
  });

  it('aciona signOut ao clicar em sair', async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByTitle('Sair'));
    expect(signOut).toHaveBeenCalled();
  });
});
