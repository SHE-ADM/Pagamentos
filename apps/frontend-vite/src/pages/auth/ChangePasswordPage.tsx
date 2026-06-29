// src/pages/auth/ChangePasswordPage.tsx
// Tela full-page de troca de senha OBRIGATÓRIA no 1º acesso. Exige sessão (o usuário
// chega aqui logado com a senha temporária); sem sessão, volta ao login. Quem já
// trocou (marca password_changed) não precisa estar aqui → vai para o app.
import { Navigate } from 'react-router-dom';
import { mustChangePassword } from '@sheild/shared';
import { useAuth } from '../../contexts/AuthContext';
import AuthLayout from '../../components/AuthLayout';
import ChangePasswordForm from '../../components/organisms/ChangePasswordForm';

export default function ChangePasswordPage() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-gray-500">Carregando…</div>
    );
  }
  if (!user) return <Navigate to="/auth/login" replace />;
  // Já trocou a senha → não há o que fazer aqui.
  if (!mustChangePassword(user.user_metadata)) return <Navigate to="/consulta" replace />;

  return (
    <AuthLayout title="Defina sua senha" subtitle="Primeiro acesso — escolha uma nova senha">
      <ChangePasswordForm />
    </AuthLayout>
  );
}
