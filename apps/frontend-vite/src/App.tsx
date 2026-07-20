// src/App.tsx
import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import LoginPage from './pages/auth/LoginPage';
import { clearChunkReloadCount } from './lib/chunkReload';

// Rotas carregadas sob demanda (code-splitting) — só o login entra no bundle
// inicial; as telas de dados e os fluxos de auth secundários viram chunks à parte.
const ForgotPasswordPage = lazy(() => import('./pages/auth/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./pages/auth/ResetPasswordPage'));
const ChangePasswordPage = lazy(() => import('./pages/auth/ChangePasswordPage'));
const Emails = lazy(() => import('./pages/Emails'));
const Consulta = lazy(() => import('./pages/Consulta'));
const Erros = lazy(() => import('./pages/Erros'));
const SuppliersPage = lazy(() => import('./pages/SuppliersPage'));
const CostCentersPage = lazy(() => import('./pages/CostCentersPage'));
const BanksPage = lazy(() => import('./pages/BanksPage'));
const FinancialAccountsPage = lazy(() => import('./pages/FinancialAccountsPage'));
const ChartAccountsPage = lazy(() => import('./pages/ChartAccountsPage'));
const ChartAccountGroupsPage = lazy(() => import('./pages/ChartAccountGroupsPage'));
const ChartAccountSubgroupsPage = lazy(() => import('./pages/ChartAccountSubgroupsPage'));
const ContasNovaPage = lazy(() => import('./pages/ContasNovaPage'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const CobrancaEnvios = lazy(() => import('./pages/cobranca/CobrancaEnvios'));
const CobrancaErros = lazy(() => import('./pages/cobranca/CobrancaErros'));

function RouteFallback() {
  return (
    <div className="flex h-full min-h-48 items-center justify-center text-sm text-ink-secondary">
      Carregando…
    </div>
  );
}

export default function App() {
  // O bundle principal montou sem erro → reseta o contador anti-loop de reload de
  // chunk (libera novas tentativas para uma falha futura). Ver lib/chunkReload.
  useEffect(() => {
    clearChunkReloadCount();
  }, []);

  return (
    <AuthProvider>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/auth/login" element={<LoginPage />} />
          <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/auth/reset-password" element={<ResetPasswordPage />} />
          {/* Troca obrigatória no 1º acesso — exige sessão; auto-guarda dentro da página. */}
          <Route path="/auth/change-password" element={<ChangePasswordPage />} />
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
                      <Route path="/contas" element={<ContasNovaPage />} />
                      <Route path="/fornecedores" element={<SuppliersPage />} />
                      <Route path="/tabelas/centros-de-custo" element={<CostCentersPage />} />
                      <Route path="/tabelas/bancos" element={<BanksPage />} />
                      <Route path="/tabelas/contas" element={<FinancialAccountsPage />} />
                      <Route path="/tabelas/plano-de-contas" element={<ChartAccountsPage />} />
                      <Route path="/tabelas/grupos-plano-de-contas" element={<ChartAccountGroupsPage />} />
                      <Route path="/tabelas/subgrupos-plano-de-contas" element={<ChartAccountSubgroupsPage />} />
                      <Route path="/dashboard_vencimentos" element={<Dashboard />} />
                      {/* Compat: rota antiga /dashboard → preserva bookmarks/histórico. */}
                      <Route path="/dashboard" element={<Navigate to="/dashboard_vencimentos" replace />} />
                      <Route path="/erros" element={<Erros />} />
                      <Route path="/cobranca/envios" element={<CobrancaEnvios />} />
                      <Route path="/cobranca/erros" element={<CobrancaErros />} />

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
