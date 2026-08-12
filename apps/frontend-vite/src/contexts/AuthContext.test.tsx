import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

const IDLE_KEY = 'pag:last-activity';

// Mock do cliente Supabase — nenhuma chamada de rede real.
const getSession = vi.fn();
const getUser = vi.fn();
const signOut = vi.fn();
const onAuthStateChange = vi.fn();
// Leitura de user_profile.group_id (gate isAdminGroup) — controlada por teste.
const maybeSingle = vi.fn();
const profileQuery = {
  select: () => profileQuery,
  eq: () => profileQuery,
  maybeSingle: () => maybeSingle(),
};

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
    from: () => profileQuery,
  },
}));

import { AuthProvider, useAuth } from './AuthContext';

// Consumidor mínimo que expõe o estado do contexto para asserção.
function Probe() {
  const { user, loading, isAdminGroup, aiChatEnabled } = useAuth();
  if (loading) return <span>loading</span>;
  return (
    <>
      <span>{user ? `user:${user.email}` : 'anon'}</span>
      <span>{`admingroup:${isAdminGroup}`}</span>
      {/* String, não booleano: `null` (ainda não sei) tem de ser distinguível de `false`. */}
      <span>{`aichat:${String(aiChatEnabled)}`}</span>
    </>
  );
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
    maybeSingle.mockReset().mockResolvedValue({ data: { group_id: 0 }, error: null });
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

  it('sessão persistida + inatividade expirada → signOut sem validar via getUser', async () => {
    const user = { id: '1', email: 'admin@sheild.app.br' };
    getSession.mockResolvedValue({ data: { session: { user } } });
    signOut.mockResolvedValue({ error: null });
    // Marcador de atividade antigo (35 min) → teto de 30 min já estourado.
    localStorage.setItem(IDLE_KEY, String(Date.now() - 35 * 60_000));

    renderProvider();

    expect(await screen.findByText('anon')).toBeInTheDocument();
    expect(signOut).toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();
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

  it('grupo Administrador (group_id=1) → isAdminGroup true', async () => {
    const user = { id: '1', email: 'ricardo@sheild.com.br' };
    getSession.mockResolvedValue({ data: { session: { user } } });
    getUser.mockResolvedValue({ data: { user }, error: null });
    maybeSingle.mockResolvedValue({ data: { group_id: 1 }, error: null });

    renderProvider();

    expect(await screen.findByText('admingroup:true')).toBeInTheDocument();
  });

  it('grupo não-Administrador (group_id=7) → isAdminGroup false', async () => {
    const user = { id: '2', email: 'barbara@otimotex.com.br' };
    getSession.mockResolvedValue({ data: { session: { user } } });
    getUser.mockResolvedValue({ data: { user }, error: null });
    maybeSingle.mockResolvedValue({ data: { group_id: 7 }, error: null });

    renderProvider();

    expect(await screen.findByText('user:barbara@otimotex.com.br')).toBeInTheDocument();
    expect(await screen.findByText('admingroup:false')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Gate de UI do assistente de IA (migration 120, Onda 8)
  // ---------------------------------------------------------------------------
  describe('aiChatEnabled', () => {
    const comSessao = (user: { id: string; email: string }) => {
      getSession.mockResolvedValue({ data: { session: { user } } });
      getUser.mockResolvedValue({ data: { user }, error: null });
    };

    it('grupo habilitado → true', async () => {
      comSessao({ id: '1', email: 'ricardo@sheild.com.br' });
      maybeSingle.mockResolvedValue({
        data: { group_id: 1, user_group: { ai_chat_enabled: true } },
        error: null,
      });

      renderProvider();

      expect(await screen.findByText('aichat:true')).toBeInTheDocument();
    });

    it('grupo sem acesso → false', async () => {
      comSessao({ id: '3', email: 'ester@otimotex.com.br' });
      maybeSingle.mockResolvedValue({
        data: { group_id: 6, user_group: { ai_chat_enabled: false } },
        error: null,
      });

      renderProvider();

      expect(await screen.findByText('aichat:false')).toBeInTheDocument();
    });

    it('perfil ausente → false (grupo 0 não é liberado)', async () => {
      comSessao({ id: '4', email: 'novo@otimotex.com.br' });
      maybeSingle.mockResolvedValue({ data: null, error: null });

      renderProvider();

      expect(await screen.findByText('aichat:false')).toBeInTheDocument();
    });

    it('sem sessão → null (ainda não sei), nunca false', async () => {
      getSession.mockResolvedValue({ data: { session: null } });

      renderProvider();

      // `false` aqui seria uma afirmação sobre um usuário que não existe.
      expect(await screen.findByText('aichat:null')).toBeInTheDocument();
    });

    /**
     * 🔴 ASSIMETRIA DELIBERADA com o servidor: o gate real (assertAiChatAllowed) falha FECHADO;
     * este, que é cosmético, falha ABERTO. Esconder o botão de quem tem direito por causa de um
     * soluço de rede é o pior desfecho de uma camada que não protege nada — e o clique acabaria
     * num 403 curado de qualquer forma.
     */
    it('falha na leitura do perfil → true (fail-open na camada cosmética)', async () => {
      comSessao({ id: '5', email: 'luiz@otimotex.com.br' });
      maybeSingle.mockResolvedValue({ data: null, error: { message: 'network' } });

      renderProvider();

      expect(await screen.findByText('aichat:true')).toBeInTheDocument();
    });
  });
});
