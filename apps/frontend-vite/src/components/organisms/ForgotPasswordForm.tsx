// src/components/organisms/ForgotPasswordForm.tsx
// Organism — solicita o link de redefinicao de senha por e-mail via
// supabase.auth.resetPasswordForEmail. Mostra sempre uma mensagem de
// sucesso generica (nao revela se o e-mail existe — regra de seguranca).

import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'react-router-dom';
import { forgotPasswordSchema, type ForgotPasswordInput } from '@sheild/shared';
import { supabase } from '../../lib/supabaseClient';
import AuthInput from '../atoms/AuthInput';
import GradientPillButton from '../atoms/GradientPillButton';
import InlineMessage from '../molecules/InlineMessage';

export default function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  const { control, handleSubmit } = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  });

  const onSubmit = async (data: ForgotPasswordInput) => {
    setLoading(true);
    await supabase.auth.resetPasswordForEmail(data.email, {
      redirectTo: `${globalThis.location.origin}/auth/reset-password`,
    });
    setLoading(false);
    setSent(true);
  };

  if (sent) {
    return (
      <div className="space-y-4">
        <InlineMessage type="success">
          Se este e-mail estiver cadastrado, você receberá um link em instantes. Verifique também sua caixa de
          spam.
        </InlineMessage>
        <Link to="/auth/login" className="block text-center text-xs text-auth-navy hover:underline">
          ← Voltar ao login
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <p className="text-xs text-gray-500">
        Digite seu e-mail e enviaremos um link para redefinir sua senha.
      </p>

      <Controller
        name="email"
        control={control}
        render={({ field, fieldState }) => (
          <AuthInput
            {...field}
            label="E-mail"
            type="email"
            autoComplete="email"
            placeholder="seu@email.com"
            error={fieldState.error?.message}
          />
        )}
      />

      <GradientPillButton type="submit" loading={loading} loadingLabel="Enviando…">
        Enviar link de redefinição
      </GradientPillButton>

      <Link to="/auth/login" className="block text-center text-xs text-auth-navy hover:underline">
        ← Voltar ao login
      </Link>
    </form>
  );
}
