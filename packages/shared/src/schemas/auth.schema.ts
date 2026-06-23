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
