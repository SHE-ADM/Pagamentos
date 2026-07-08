// src/components/organisms/ChangePasswordForm.tsx
// Organism — troca de senha OBRIGATÓRIA no 1º acesso. Diferente do ResetPasswordForm
// (fluxo de "esqueci a senha", que vem de um link de e-mail e desloga ao final), aqui
// o usuário JÁ está logado com a senha temporária do admin: define a nova senha e
// CONTINUA na aplicação. Ao definir, marca password_changed em APP_METADATA via o
// endpoint POST /api/users/me/password-changed (server-controlled — S1-1) e recarrega a
// sessão para o cliente ver a marca — é o que tira o usuário do estado "deve trocar"
// (ver ProtectedRoute). NÃO grava mais a marca em user_metadata (client-writable).

import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router-dom';
import { resetPasswordSchema, type ResetPasswordInput } from '@sheild/shared';
import { supabase } from '../../lib/supabaseClient';
import { dataApiCall } from '../../services/dataApi';
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

    // 1) Define a nova senha (sem gravar a marca em user_metadata — client-writable).
    const { error } = await supabase.auth.updateUser({ password: data.password });
    if (error) {
      setLoading(false);
      setServerError('Não foi possível alterar a senha. Tente novamente.');
      return;
    }

    // 2) Marca password_changed em APP_METADATA (server-controlled) e recarrega a sessão
    //    para o cliente ver a marca nova (o TOKEN_REFRESHED atualiza o AuthContext →
    //    ProtectedRoute libera). A senha JÁ foi trocada; se este passo falhar, orienta a
    //    refazer o login (a marca será aplicada e o gate reavaliado).
    try {
      await dataApiCall('/users/me/password-changed', { method: 'POST' });
      await supabase.auth.refreshSession();
    } catch {
      setLoading(false);
      setServerError('Senha alterada, mas houve um erro ao concluir. Faça login novamente.');
      return;
    }

    setLoading(false);
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
