// lib/users.ts
// Módulo de usuários SOBRE o Supabase Auth (sem tabela própria, sem JWT customizado).
// Repository (acesso ao provedor) → Service (regras + validação Zod). As rotas mapeiam
// UserServiceError para o status HTTP via instanceof (mesmo padrão de PythonBridgeError).

import type { AuthError, User } from '@supabase/supabase-js';
import type { ZodError } from 'zod';
import { createUserSchema, loginSchema, PASSWORD_CHANGED_META_KEY } from '@sheild/shared/schemas';
import { getSupabaseAdmin } from './supabase-admin';
import { getAnonClient } from './auth';
import { ApiServiceError } from './api-error';

// Erro de negócio com status HTTP — capturado por instanceof nos route handlers.
export class UserServiceError extends ApiServiceError {
  constructor(message: string, status: number) {
    super(message, status, 'UserServiceError');
  }
}

// Saída pública do perfil — NUNCA inclui password_hash (o Supabase sequer o expõe).
// Tipos de retorno internos (consumidos por inferência nas rotas); não exportados
// para não aparecerem como órfãos no ts-prune.
interface PublicUser {
  id: string;
  name: string | null;
  email: string | null;
}

interface UserProfile extends PublicUser {
  created_at: string | null;
}

interface LoginResult {
  access_token: string;
  expires_in: number;
}

// Concatena as mensagens de validação do Zod numa única string para o envelope.
function formatZodError(error: ZodError): string {
  return error.issues.map((i) => i.message).join('; ');
}

// O Supabase sinaliza e-mail já cadastrado por código `email_exists` (ou mensagem
// equivalente em versões anteriores). Mapeado para 409 (conflito).
function isDuplicateEmail(error: AuthError): boolean {
  if (error.code === 'email_exists') return true;
  return /already.*registered|already.*exists/i.test(error.message);
}

// Camada de acesso ao provedor (Supabase Auth). Mantida interna ao módulo:
// os testes exercitam-na através do service, mockando @supabase/supabase-js.
const userRepository = {
  // Cria o usuário com e-mail já confirmado (operação de admin, service_role).
  createAuthUser(input: { name: string; email: string; password: string }) {
    return getSupabaseAdmin().auth.admin.createUser({
      email: input.email,
      password: input.password,
      email_confirm: true,
      user_metadata: { name: input.name },
    });
  },

  // Autentica por e-mail/senha com a chave anon, devolvendo a sessão do Supabase.
  signIn(credentials: { email: string; password: string }) {
    return getAnonClient().auth.signInWithPassword(credentials);
  },

  // Marca `password_changed` em APP_METADATA (server-controlled) via Admin API. O
  // updateUserById MESCLA as chaves de app_metadata (preserva role/group_id existentes).
  markPasswordChanged(userId: string) {
    return getSupabaseAdmin().auth.admin.updateUserById(userId, {
      app_metadata: { [PASSWORD_CHANGED_META_KEY]: true },
    });
  },
};

export const userService = {
  /**
   * Cadastra um usuário (operação de admin). Valida o input com `createUserSchema`,
   * cria a conta no Supabase Auth com e-mail confirmado e devolve os dados públicos.
   * @param raw Corpo da requisição (não confiável) — validado internamente.
   * @returns `{ id, name, email }` — nunca expõe `password_hash`.
   * @throws {UserServiceError} 422 (payload inválido) ou 409 (e-mail já cadastrado).
   */
  async register(raw: unknown): Promise<PublicUser> {
    const parsed = createUserSchema.safeParse(raw);
    if (!parsed.success) throw new UserServiceError(formatZodError(parsed.error), 422);

    const { data, error } = await userRepository.createAuthUser(parsed.data);
    if (error) {
      if (isDuplicateEmail(error)) throw new UserServiceError('E-mail já cadastrado', 409);
      throw new UserServiceError(error.message, 422);
    }
    if (!data.user) throw new UserServiceError('Falha ao criar o usuário', 500);

    return { id: data.user.id, name: parsed.data.name, email: data.user.email ?? parsed.data.email };
  },

  /**
   * Autentica um usuário e devolve o access_token do Supabase + sua expiração.
   * @param raw Corpo da requisição com `{ email, password }` — validado internamente.
   * @returns `{ access_token, expires_in }` da sessão do Supabase.
   * @throws {UserServiceError} 422 (payload inválido) ou 401 (credencial incorreta).
   */
  async login(raw: unknown): Promise<LoginResult> {
    const parsed = loginSchema.safeParse(raw);
    if (!parsed.success) throw new UserServiceError(formatZodError(parsed.error), 422);

    const { data, error } = await userRepository.signIn(parsed.data);
    // Mensagem genérica de propósito — nunca revelar qual campo está errado.
    if (error || !data.session) throw new UserServiceError('E-mail ou senha incorretos', 401);

    return { access_token: data.session.access_token, expires_in: data.session.expires_in };
  },

  /**
   * Mapeia o `User` do Supabase (já autenticado) para o perfil público exibido em
   * GET /api/users/me. O nome vem de `user_metadata.name` (gravado no cadastro).
   * @param user Usuário resolvido pelo guard de autenticação.
   * @returns `{ id, name, email, created_at }` — sem dados sensíveis.
   */
  getProfile(user: User): UserProfile {
    const name = typeof user.user_metadata?.name === 'string' ? user.user_metadata.name : null;
    return { id: user.id, name, email: user.email ?? null, created_at: user.created_at ?? null };
  },

  /**
   * Marca `app_metadata.password_changed = true` para o usuário — chamado APÓS ele
   * definir a própria senha (POST /api/users/me/password-changed, requireAuth). A
   * obrigatoriedade da troca passa a depender de um campo SERVER-CONTROLLED, não de
   * `user_metadata` (client-writable). Ver achado S1-1.
   * @throws {UserServiceError} 500 em falha da Admin API.
   */
  async markPasswordChanged(userId: string): Promise<void> {
    const { error } = await userRepository.markPasswordChanged(userId);
    if (error) throw new UserServiceError(error.message, 500);
  },
};
