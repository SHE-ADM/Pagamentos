// src/components/organisms/ChangePasswordForm.tsx
// Organism — troca de senha OBRIGATÓRIA no 1º acesso. Diferente do ResetPasswordForm
// (fluxo de "esqueci a senha", que vem de um link de e-mail e desloga ao final), aqui
// o usuário JÁ está logado com a senha temporária do admin: define a nova senha e
// CONTINUA na aplicação. Ao definir, grava a marca PASSWORD_CHANGED_META_KEY em
// user_metadata — é o que tira o usuário do estado "deve trocar" (ver ProtectedRoute).

import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router-dom';
import {
  resetPasswordSchema,
  type ResetPasswordInput,
  PASSWORD_CHANGED_META_KEY,
} from '@sheild/shared';
import { supabase } from '../../lib/supabaseClient';
import AuthInput from '../atoms/AuthInput';
import GradientPillButton from '../atoms/GradientPillButton';
import InlineMessage from '../molecules/InlineMessage';

export default function ChangePasswordForm() {
  const navigate = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const { control, handleSubmit } = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: '', confirmPassword: '' },
  });

  const onSubmit = async (data: ResetPasswordInput) => {
    setServerError(null);
    setLoading(true);
    // Define a nova senha E marca password_changed=true no mesmo updateUser —
    // a marca remove o usuário do estado "deve trocar" (sem endpoint extra). O
    // evento USER_UPDATED atualiza o user no AuthContext.
    const { error } = await supabase.auth.updateUser({
      password: data.password,
      data: { [PASSWORD_CHANGED_META_KEY]: true },
    });
    setLoading(false);

    if (error) {
      setServerError('Não foi possível alterar a senha. Tente novamente.');
      return;
    }

    // Mantém a sessão (não desloga) e segue para o app.
    navigate('/consulta', { replace: true });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <p className="text-xs text-gray-500">
        Por segurança, defina uma nova senha antes de continuar.
      </p>

      <Controller
        name="password"
        control={control}
        render={({ field, fieldState }) => (
          <AuthInput
            {...field}
            label="Nova senha"
            type="password"
            autoComplete="new-password"
            placeholder="••••••••"
            error={fieldState.error?.message}
          />
        )}
      />

      <Controller
        name="confirmPassword"
        control={control}
        render={({ field, fieldState }) => (
          <AuthInput
            {...field}
            label="Confirmar nova senha"
            type="password"
            autoComplete="new-password"
            placeholder="••••••••"
            error={fieldState.error?.message}
          />
        )}
      />

      <InlineMessage type="error">{serverError}</InlineMessage>

      <GradientPillButton type="submit" loading={loading} loadingLabel="Salvando…">
        Salvar nova senha
      </GradientPillButton>
    </form>
  );
}
