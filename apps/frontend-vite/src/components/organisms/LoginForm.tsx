import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { loginSchema, type LoginInput } from '@sheild/shared';
import { supabase } from '../../lib/supabaseClient';
import { setRememberPreference, getRememberPreference } from '../../lib/authStorage';
import FilledTextField from '../atoms/FilledTextField';
import AccentPillButton from '../atoms/AccentPillButton';
import SocialLinksBar from '../molecules/SocialLinksBar';

export default function LoginForm() {
  const navigate = useNavigate();
  const [showPassword, setShowPassword] = useState(false);
  // Inicializa refletindo a última escolha salva — uma vez marcado, permanece
  // marcado nas próximas sessões até o usuário desmarcar.
  const [remember, setRemember] = useState(getRememberPreference);
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const { control, handleSubmit } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = async (data: LoginInput) => {
    setServerError(null);
    setLoading(true);
    // Define onde a sessão será persistida ANTES do signIn, para que o token
    // recém-emitido já vá para o storage correto (local vs session).
    setRememberPreference(remember);
    const { error } = await supabase.auth.signInWithPassword({
      email: data.email,
      password: data.password,
    });
    setLoading(false);
    if (error) {
      setServerError('E-mail ou senha incorretos.');
      return;
    }
    navigate('/consulta');
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-2.5 w-full">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-extrabold text-loginGreen-ink tracking-tight leading-none">Login</h1>
        <p className="text-base font-medium text-loginGreen-accent">Boas-vindas! Faça seu login.</p>
      </div>

      {/* Campo e-mail */}
      <Controller
        name="email"
        control={control}
        render={({ field, fieldState }) => (
          <FilledTextField
            {...field}
            label="Email ou usuário"
            type="email"
            autoComplete="email"
            placeholder="usuario123"
            error={fieldState.error?.message}
          />
        )}
      />

      {/* Campo senha com toggle */}
      <Controller
        name="password"
        control={control}
        render={({ field, fieldState }) => (
          <FilledTextField
            {...field}
            label="Senha"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            placeholder="••••••"
            error={fieldState.error?.message}
            endAdornment={
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                className="text-loginGreen-inkFaint hover:text-loginGreen-borderFocus flex items-center shrink-0 transition-colors"
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            }
          />
        )}
      />

      {/* Lembrar-me + Esqueci a senha */}
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-base font-medium text-loginGreen-inkMid cursor-pointer select-none">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="w-3.5 h-3.5 accent-loginGreen-borderFocus cursor-pointer shrink-0"
          />
          <span>Lembrar-me</span>
        </label>
        <Link
          to="/auth/forgot-password"
          className="text-base font-semibold text-loginGreen-accent hover:underline whitespace-nowrap"
        >
          Esqueci a senha
        </Link>
      </div>

      {/* Erro do servidor (credenciais inválidas) */}
      {serverError && (
        <p className="bg-status-error-bg text-status-error-fg rounded-md px-3 py-2 text-base">{serverError}</p>
      )}

      {/* Botão Login */}
      <AccentPillButton type="submit" loading={loading} loadingLabel="Entrando…" className="my-2.5">
        Login
      </AccentPillButton>

      {/* Logos sociais */}
      <SocialLinksBar />
    </form>
  );
}
