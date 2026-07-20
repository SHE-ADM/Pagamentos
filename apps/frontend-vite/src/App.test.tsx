import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Dependências pesadas viram passthrough — o foco é a TABELA DE ROTAS do App
// (em especial o redirect de compatibilidade /dashboard → /dashboard_vencimentos).
vi.mock('./contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./components/ProtectedRoute', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./components/Layout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('./pages/Dashboard', () => ({
  default: () => <div>DASHBOARD_MARKER</div>,
}));

import App from './App';

describe('App — roteamento', () => {
  it('a rota nova /dashboard_vencimentos renderiza o Dashboard', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboard_vencimentos']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText('DASHBOARD_MARKER')).toBeInTheDocument();
  });

  it('a rota antiga /dashboard REDIRECIONA para /dashboard_vencimentos (compat de bookmarks)', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <App />
      </MemoryRouter>,
    );
    // Se o redirect não existisse, /dashboard cairia em branco (sem match no <Routes> interno).
    expect(await screen.findByText('DASHBOARD_MARKER')).toBeInTheDocument();
  });
});
