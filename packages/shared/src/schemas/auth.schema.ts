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

// Troca de senha obrigatória no 1º acesso. A marca POSITIVA `password_changed`
// (em user_metadata) só é gravada quando o próprio usuário define sua senha. A
// ausência da marca = senha ainda é a temporária do admin → força a troca. Esse
// desenho cobre QUALQUER caminho de criação (Supabase Dashboard ou API): um usuário
// novo nunca tem a marca. Usuários já existentes recebem a marca por backfill, para
// não serem forçados. (user_metadata é client-writable — o próprio fluxo de troca
// grava a marca; adequado ao modelo de sessão confiável deste app interno.)
export const PASSWORD_CHANGED_META_KEY = 'password_changed';

/**
 * Decide se o usuário deve ser forçado a trocar a senha (1º acesso). Recebe o
 * `user_metadata` do Supabase. True quando a marca `password_changed` NÃO é `true`
 * (ausente ou false) — senha ainda é a temporária definida pelo admin.
 */
export function mustChangePassword(
  userMetadata: Record<string, unknown> | null | undefined,
): boolean {
  return userMetadata?.[PASSWORD_CHANGED_META_KEY] !== true;
}
