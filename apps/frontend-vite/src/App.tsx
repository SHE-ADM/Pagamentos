// src/App.tsx
import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import LoginPage from './pages/auth/LoginPage';

// Rotas carregadas sob demanda (code-splitting) — só o login entra no bundle
// inicial; as telas de dados e os fluxos de auth secundários viram chunks à parte.
const ForgotPasswordPage = lazy(() => import('./pages/auth/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./pages/auth/ResetPasswordPage'));
const Emails = lazy(() => import('./pages/Emails'));
const Consulta = lazy(() => import('./pages/Consulta'));
const Erros = lazy(() => import('./pages/Erros'));

function RouteFallback() {
  return (
    <div className="flex h-full min-h-48 items-center justify-center text-sm text-ink-secondary">
      Carregando…
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/auth/login" element={<LoginPage />} />
          <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/auth/reset-password" element={<ResetPasswordPage />} />
          <Route
            path="/*"
            element={
              <ProtectedRoute>
                <Layout>
                  <Suspense fallback={<RouteFallback />}>
                    <Routes>
                      <Route path="/" element={<Navigate to="/consulta" replace />} />
                      <Route path="/emails" element={<Emails />} />
                      <Route path="/consulta" element={<Consulta />} />
                      <Route path="/erros" element={<Erros />} />
                    </Routes>
                  </Suspense>
                </Layout>
              </ProtectedRoute>
            }
          />
        </Routes>
      </Suspense>
    </AuthProvider>
  );
}
