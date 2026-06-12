import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

const IDLE_KEY = 'pag:last-activity';

// Mock do cliente Supabase — nenhuma chamada de rede real.
const getSession = vi.fn();
const getUser = vi.fn();
const signOut = vi.fn();
const onAuthStateChange = vi.fn();

// Callback registrado pelo AuthContext em onAuthStateChange — capturado para
// simular eventos de auth (SIGNED_IN / SIGNED_OUT) nos testes.
let authCallback: ((event: string, session: unknown) => void) | null = null;

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
    localStorage.clear(); // evita que o relógio de inatividade herde estado entre testes
    getSession.mockReset();
    getUser.mockReset();
    signOut.mockReset();
    onAuthStateChange.mockReset();
    authCallback = null;
    onAuthStateChange.mockImplementation((cb: (event: string, session: unknown) => void) => {
      authCallback = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
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

  it('SIGNED_IN marca atividade de inatividade; SIGNED_OUT limpa o marcador', async () => {
    getSession.mockResolvedValue({ data: { session: null } });

    renderProvider();
    await screen.findByText('anon');

    act(() => {
      authCallback?.('SIGNED_IN', { user: { id: '1', email: 'admin@sheild.app.br' } });
    });
    expect(localStorage.getItem(IDLE_KEY)).not.toBeNull();

    act(() => {
      authCallback?.('SIGNED_OUT', null);
    });
    expect(localStorage.getItem(IDLE_KEY)).toBeNull();
  });
});
