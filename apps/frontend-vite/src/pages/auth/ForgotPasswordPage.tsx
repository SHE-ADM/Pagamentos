// src/pages/auth/ForgotPasswordPage.tsx
import AuthLayout from '../../components/AuthLayout';
import ForgotPasswordForm from '../../components/organisms/ForgotPasswordForm';

export default function ForgotPasswordPage() {
  return (
    <AuthLayout title="Esqueci minha senha" subtitle="Vamos te ajudar a recuperar o acesso">
      <ForgotPasswordForm />
    </AuthLayout>
  );
}
