import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock do cliente Supabase — nenhuma chamada de rede real.
const getSession = vi.fn();
const getUser = vi.fn();
const signOut = vi.fn();
const onAuthStateChange = vi.fn();

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => getSession(...args),
      getUser: (...args: unknown[]) => getUser(...args),
      signOut: (...args: unknown[]) => signOut(...args),
      onAuthStateChange: (...args: unknown[]) => onAuthStateChange(...args),
    },
  },
}));

import { AuthProvider, useAuth } from './AuthContext';

// Consumidor mínimo que expõe o estado do contexto para asserção.
function Probe() {
  const { user, loading } = useAuth();
  if (loading) return <span>loading</span>;
  return <span>{user ? `user:${user.email}` : 'anon'}</span>;
}

function renderProvider() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

describe('AuthContext', () => {
  beforeEach(() => {
    getSession.mockReset();
    getUser.mockReset();
    signOut.mockReset();
    onAuthStateChange.mockReset();
    onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  });

  it('sem sessão persistida → estado anônimo, sem validar no servidor', async () => {
    getSession.mockResolvedValue({ data: { session: null } });

    renderProvider();

    expect(await screen.findByText('anon')).toBeInTheDocument();
    expect(getUser).not.toHaveBeenCalled();
  });

  it('sessão válida confirmada pelo servidor → usuário autenticado', async () => {
    const user = { id: '1', email: 'admin@sheild.app.br' };
    getSession.mockResolvedValue({ data: { session: { user } } });
    getUser.mockResolvedValue({ data: { user }, error: null });

    renderProvider();

    expect(await screen.findByText('user:admin@sheild.app.br')).toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('sessão órfã (getUser 401) → signOut e volta ao estado anônimo', async () => {
    const user = { id: '1', email: 'ghost@sheild.app.br' };
    getSession.mockResolvedValue({ data: { session: { user } } });
    getUser.mockResolvedValue({ data: { user: null }, error: { status: 401, message: 'invalid' } });
    signOut.mockResolvedValue({ error: null });

    renderProvider();

    expect(await screen.findByText('anon')).toBeInTheDocument();
    expect(signOut).toHaveBeenCalled();
  });

  it('falha de rede no getUser → mantém a sessão de forma otimista', async () => {
    const user = { id: '1', email: 'admin@sheild.app.br' };
    getSession.mockResolvedValue({ data: { session: { user } } });
    getUser.mockResolvedValue({ data: { user: null }, error: { status: 0, message: 'network' } });

    renderProvider();

    expect(await screen.findByText('user:admin@sheild.app.br')).toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();
  });
});
