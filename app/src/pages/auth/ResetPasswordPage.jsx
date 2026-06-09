// src/pages/auth/ResetPasswordPage.jsx
import AuthLayout from '../../components/AuthLayout'
import ResetPasswordForm from '../../components/organisms/ResetPasswordForm'

export default function ResetPasswordPage() {
  return (
    <AuthLayout title="Redefinir senha" subtitle="Defina uma nova senha de acesso">
      <ResetPasswordForm />
    </AuthLayout>
  )
}
