import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Mock do useAuth — controla user/loading por teste.
let mockAuth: { user: unknown; loading: boolean };
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

import ProtectedRoute from './ProtectedRoute';

function renderAt() {
  return render(
    <MemoryRouter initialEntries={['/protegida']}>
      <Routes>
        <Route
          path="/protegida"
          element={
            <ProtectedRoute>
              <div>CONTEUDO PROTEGIDO</div>
            </ProtectedRoute>
          }
        />
        <Route path="/auth/login" element={<div>TELA LOGIN</div>} />
        <Route path="/auth/change-password" element={<div>TELA TROCA</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProtectedRoute', () => {
  beforeEach(() => {
    mockAuth = { user: null, loading: false };
  });

  it('mostra "Carregando…" enquanto a sessão é resolvida', () => {
    mockAuth = { user: null, loading: true };
    renderAt();
    expect(screen.getByText('Carregando…')).toBeInTheDocument();
  });

  it('redireciona ao login quando não há sessão', () => {
    mockAuth = { user: null, loading: false };
    renderAt();
    expect(screen.getByText('TELA LOGIN')).toBeInTheDocument();
  });

  it('força a troca de senha quando falta a marca password_changed (1º acesso)', () => {
    mockAuth = { user: { user_metadata: { name: 'Novo' } }, loading: false };
    renderAt();
    expect(screen.getByText('TELA TROCA')).toBeInTheDocument();
    expect(screen.queryByText('CONTEUDO PROTEGIDO')).not.toBeInTheDocument();
  });

  it('libera o conteúdo quando password_changed = true', () => {
    mockAuth = { user: { user_metadata: { password_changed: true } }, loading: false };
    renderAt();
    expect(screen.getByText('CONTEUDO PROTEGIDO')).toBeInTheDocument();
  });
});
