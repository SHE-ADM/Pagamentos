// src/components/ProtectedRoute.tsx
import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-gray-400">Carregando…</div>
    );
  }

  if (!user) return <Navigate to="/auth/login" replace />;

  return <>{children}</>;
}
