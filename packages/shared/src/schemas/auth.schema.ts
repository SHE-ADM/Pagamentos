import { z } from 'zod';

// Fonte de verdade dos formulários de autenticação (Supabase Auth).
// Espelha o padrão Sheild (auth-specs.md): login, esqueci a senha, redefinir.

export const loginSchema = z.object({
  email: z.email('E-mail inválido'),
  password: z.string().min(6, 'Senha deve ter no mínimo 6 caracteres'),
});

// Cadastro de usuário — operação de ADMIN (auth.admin.createUser no backend).
// Não há auto-registro: o frontend nunca chama signUp (auth-specs.md).
export const createUserSchema = z.object({
  name: z.string().min(3, 'Nome deve ter no mínimo 3 caracteres').max(255),
  email: z.email('E-mail inválido'),
  password: z.string().min(8, 'Senha deve ter no mínimo 8 caracteres'),
});

export const forgotPasswordSchema = z.object({
  email: z.email('E-mail inválido'),
});

export const resetPasswordSchema = z
  .object({
    password: z.string().min(8, 'Senha deve ter no mínimo 8 caracteres'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'As senhas não conferem',
    path: ['confirmPassword'],
  });

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

// Troca de senha obrigatória no 1º acesso. A marca POSITIVA `password_changed` vive em
// `app_metadata` — campo SERVER-CONTROLLED (só gravável via Admin API/service_role, o
// usuário NÃO consegue forjá-lo, ao contrário de `user_metadata`). Ela só é gravada
// quando o próprio usuário define sua senha (endpoint POST /api/users/me/password-changed,
// requireAuth). A ausência da marca = senha ainda é a temporária do admin → força a troca.
// Cobre QUALQUER caminho de criação (Dashboard ou API): um usuário novo nunca tem a marca.
// A obrigatoriedade NÃO depende mais de campo client-writable (achado S1-1).
// BACKFILL: usuários já existentes precisam de app_metadata.password_changed=true (via Admin
// API / SQL em auth.users.raw_app_meta_data), senão são forçados a trocar uma vez.
export const PASSWORD_CHANGED_META_KEY = 'password_changed';

/**
 * Decide se o usuário deve ser forçado a trocar a senha (1º acesso). Recebe o
 * `app_metadata` do Supabase (server-controlled). True quando a marca `password_changed`
 * NÃO é `true` (ausente ou false) — senha ainda é a temporária definida pelo admin.
 */
export function mustChangePassword(
  appMetadata: Record<string, unknown> | null | undefined,
): boolean {
  return appMetadata?.[PASSWORD_CHANGED_META_KEY] !== true;
}
