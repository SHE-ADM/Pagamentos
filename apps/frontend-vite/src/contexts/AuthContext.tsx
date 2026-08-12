// src/contexts/AuthContext.tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient';
import {
  useIdleLogout,
  markIdleActivityNow,
  clearIdleActivity,
  isIdleExpired,
} from '../hooks/useIdleLogout';

// Grupo cuja associação libera o hard delete dos cadastros — espelha ADMIN_GROUP_ID do
// backend (lib/auth.ts). Vínculo em public.user_profile (migration 065).
const ADMIN_GROUP_ID = 1;

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  /** Papel de admin — lido de `app_metadata` (controlado pelo servidor, não pelo usuário). */
  isAdmin: boolean;
  /** Grupo do usuário (user_profile.group_id); null enquanto carrega ou sem sessão. */
  groupId: number | null;
  /** Pertence ao grupo Administrador — GATE DE UI do hard delete (a trava real é o backend). */
  isAdminGroup: boolean;
  /**
   * O grupo pode usar o assistente de IA (`user_group.ai_chat_enabled`, migration 120)?
   * `null` = AINDA NÃO SEI (carregando ou sem sessão) — estado distinto de `false`.
   *
   * GATE DE UI, como o `isAdminGroup`: a trava real é o `assertAiChatAllowed` da Next API. Serve
   * para não oferecer um botão que responderia 403 — não para proteger o recurso.
   */
  aiChatEnabled: boolean | null;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Papel de admin a partir de `app_metadata` — MESMA fonte confiável do backend
// (lib/auth.ts isAdmin): campo gravável só via Admin API/service_role, o usuário não
// consegue forjá-lo (ao contrário de `user_metadata`). É apenas um GATE DE UI: a
// autorização real é imposta no servidor (requireAdmin nas rotas DELETE).
function deriveIsAdmin(user: User | null): boolean {
  const meta = user?.app_metadata as { role?: string; roles?: string[] } | undefined;
  return meta?.role === 'admin' || (Array.isArray(meta?.roles) && meta.roles.includes('admin'));
}

// getSession() apenas lê o localStorage e não confirma se a sessão ainda é
// válida no servidor (usuário removido, token revogado). getUser() faz a
// verificação real. Distinguimos erro de autenticação (401/403 → sessão
// inválida, desloga) de falha de rede (mantém a sessão de forma otimista —
// o autoRefresh do supabase trata a expiração real).
const isInvalidSessionStatus = (status?: number): boolean =>
  status === 401 || status === 403;

// Minutos de inatividade até o logout automático (configurável via env).
// SEGURANÇA (S1-4): este teto é um controle de UX/conveniência, NÃO uma fronteira de
// autorização — é imposto só no cliente e o access_token segue válido no servidor até a
// expiração real do Supabase (apagar o marcador `pag:last-activity` "esquece" o teto). O
// reforço real seria encurtar a expiração do JWT / revogar o refresh token no logout.
const IDLE_MINUTES = Number(import.meta.env.VITE_SESSION_IDLE_MINUTES) || 30;
const IDLE_TIMEOUT_MS = IDLE_MINUTES * 60_000;

export function AuthProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // 🔴 Os dois vêm da MESMA leitura e são gravados na MESMA transição de estado (ver o efeito
  // abaixo). Separá-los em dois `useState` alimentados por efeitos distintos produziria um render
  // intermediário em que o grupo já chegou e a permissão ainda não — e o widget piscaria.
  const [perfil, setPerfil] = useState<{ groupId: number | null; aiChatEnabled: boolean | null }>({
    groupId: null,
    aiChatEnabled: null,
  });
  const { groupId, aiChatEnabled } = perfil;

  useEffect(() => {
    let active = true;

    const init = async () => {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const persisted = sessionData.session;

        // Sem sessão persistida → segue para o login.
        if (!persisted) {
          if (active) {
            setSession(null);
            setUser(null);
          }
          return;
        }

        // Inatividade herdada já expirou (ex.: "Lembrar-me" marcado, mas reaberto
        // após o teto de 10 min) → desloga sem restaurar, evitando flash de
        // conteúdo protegido e a validação getUser() desnecessária.
        if (isIdleExpired(IDLE_TIMEOUT_MS)) {
          await supabase.auth.signOut();
          if (active) {
            setSession(null);
            setUser(null);
          }
          return;
        }

        // Valida a sessão persistida contra o servidor.
        const { data: userData, error } = await supabase.auth.getUser();
        if (!active) return;

        if (userData.user) {
          // Sessão confirmada pelo servidor.
          setSession(persisted);
          setUser(userData.user);
        } else if (error && isInvalidSessionStatus(error.status)) {
          // Sessão inválida/órfã → limpa e força o login.
          await supabase.auth.signOut();
          setSession(null);
          setUser(null);
        } else {
          // Falha de rede/indeterminada: mantém a sessão otimisticamente.
          setSession(persisted);
          setUser(persisted.user);
        }
      } catch {
        // Falha inesperada (storage bloqueado, throw do SDK) → vai para o login
        // em vez de travar para sempre em "Carregando…".
        if (active) {
          setSession(null);
          setUser(null);
        }
      } finally {
        // Garante que o app saia do estado de "Carregando…" em qualquer caminho.
        if (active) setLoading(false);
      }
    };

    void init();

    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);
      setUser(nextSession?.user ?? null);
      // Reinicia a janela de inatividade no login; limpa o marcador no logout.
      if (event === 'SIGNED_IN') {
        markIdleActivityNow();
      } else if (event === 'SIGNED_OUT') {
        clearIdleActivity();
      }
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  // Logout automático por inatividade — ativo apenas quando autenticado.
  const handleIdleTimeout = useCallback(() => {
    void supabase.auth.signOut();
  }, []);

  useIdleLogout({ enabled: !!user, timeoutMs: IDLE_TIMEOUT_MS, onTimeout: handleIdleTimeout });

  // Carrega o perfil do usuário (grupo + permissões de UI do grupo) a cada mudança de sessão.
  // Fonte dos gates de UI do hard delete e do assistente de IA. As DUAS leituras são legais com o
  // token do próprio usuário: a policy da 065 expõe a própria linha de `user_profile`, e a do
  // `user_group` expõe o catálogo (`USING (true)`) — por isso um embed só, sem ida extra e sem
  // endpoint novo. Puramente cosmético: a autorização real é imposta no servidor
  // (requireAdminGroup nas rotas DELETE; assertAiChatAllowed em /api/ai-chat).
  // Perfil ausente → grupo 0 (sentinela).
  const uid = user?.id ?? null;
  useEffect(() => {
    let active = true;
    const loadGroup = async () => {
      if (!uid) {
        if (active) setPerfil({ groupId: null, aiChatEnabled: null });
        return;
      }
      const { data, error } = await supabase
        .from('user_profile')
        .select('group_id, user_group(ai_chat_enabled)')
        .eq('user_id', uid)
        .maybeSingle();
      if (!active) return;

      // 🔴 ASSIMETRIA PROPOSITAL COM O SERVIDOR: lá o gate falha FECHADO (não consegui provar que
      // pode ⇒ não pode); aqui ele falha ABERTO. Esconder o botão de quem tem direito por causa de
      // um soluço de rede é o pior desfecho de uma camada que não protege nada — e o clique acaba
      // em 403 curado de qualquer jeito, que é uma resposta melhor que um widget desaparecido.
      if (error) {
        setPerfil({ groupId: 0, aiChatEnabled: true });
        return;
      }

      const grupo = data?.user_group as { ai_chat_enabled?: unknown } | null | undefined;
      setPerfil({
        groupId: (data?.group_id as number | undefined) ?? 0,
        aiChatEnabled: grupo?.ai_chat_enabled === true,
      });
    };
    void loadGroup();
    return () => {
      active = false;
    };
  }, [uid]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      session,
      loading,
      isAdmin: deriveIsAdmin(user),
      groupId,
      isAdminGroup: groupId === ADMIN_GROUP_ID,
      aiChatEnabled,
      signOut,
    }),
    [user, session, loading, groupId, aiChatEnabled, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth deve ser usado dentro de AuthProvider');
  return ctx;
}
