// src/components/organisms/ResetPasswordForm.tsx
// Organism — define a nova senha apos o usuario clicar no link do e-mail
// de redefinicao. O Supabase processa o token da URL automaticamente via
// onAuthStateChange (evento PASSWORD_RECOVERY) e abre uma sessao temporaria;
// em seguida supabase.auth.updateUser troca a senha.

import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router-dom';
import { resetPasswordSchema, type ResetPasswordInput } from '@sheild/shared';
import { supabase } from '../../lib/supabaseClient';
import AuthInput from '../atoms/AuthInput';
import GradientPillButton from '../atoms/GradientPillButton';
import InlineMessage from '../molecules/InlineMessage';

export default function ResetPasswordForm() {
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
    const { error } = await supabase.auth.updateUser({ password: data.password });
    setLoading(false);

    if (error) {
      setServerError('Não foi possível redefinir a senha. Solicite um novo link e tente novamente.');
      return;
    }

    await supabase.auth.signOut();
    navigate('/auth/login', { replace: true, state: { passwordReset: true } });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <p className="text-xs text-gray-500">Defina sua nova senha de acesso.</p>

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

      <GradientPillButton type="submit" loading={loading} loadingLabel="Redefinindo…">
        Redefinir senha
      </GradientPillButton>
    </form>
  );
}
