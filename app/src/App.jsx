// src/App.jsx
import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import LoginPage          from './pages/auth/LoginPage'
import ForgotPasswordPage from './pages/auth/ForgotPasswordPage'
import ResetPasswordPage  from './pages/auth/ResetPasswordPage'
import Emails   from './pages/Emails'
import Consulta from './pages/Consulta'
import Erros    from './pages/Erros'

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/auth/login"           element={<LoginPage />} />
        <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/auth/reset-password"  element={<ResetPasswordPage />} />
        <Route
          path="/*"
          element={
            <ProtectedRoute>
              <Layout>
                <Routes>
                  <Route path="/"         element={<Navigate to="/emails" replace />} />
                  <Route path="/emails"   element={<Emails />} />
                  <Route path="/consulta" element={<Consulta />} />
                  <Route path="/erros"    element={<Erros />} />
                </Routes>
              </Layout>
            </ProtectedRoute>
          }
        />
      </Routes>
    </AuthProvider>
  )
}
