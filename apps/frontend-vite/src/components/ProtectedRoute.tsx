// src/components/ProtectedRoute.tsx
import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { mustChangePassword } from '@sheild/shared';
import { useAuth } from '../contexts/AuthContext';

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-gray-500">Carregando…</div>
    );
  }

  if (!user) return <Navigate to="/auth/login" replace />;

  // Troca de senha obrigatória no 1º acesso: enquanto a senha for a temporária do admin
  // (sem a marca password_changed em app_metadata — SERVER-CONTROLLED, S1-1), nenhuma
  // rota protegida é acessível.
  if (mustChangePassword(user.app_metadata)) {
    return <Navigate to="/auth/change-password" replace />;
  }

  return <>{children}</>;
}
