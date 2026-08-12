import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { axe } from '../../tests/axe';

// Mock do contexto de auth — sem sessão real no teste.
// `aiChatEnabled: true` para o shell escanear COM o botão flutuante montado — é o estado que a
// maioria dos usuários liberados vê, e o que acrescenta um controle à árvore acessível.
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { email: 'suporte@sheild.app.br' }, signOut: vi.fn(), aiChatEnabled: true }),
}));

import Layout from './Layout';

describe('Layout — acessibilidade (WCAG AA)', () => {
  it('shell de navegação não tem violações', async () => {
    const { container } = render(
      <MemoryRouter>
        <Layout>
          <main>conteúdo</main>
        </Layout>
      </MemoryRouter>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
