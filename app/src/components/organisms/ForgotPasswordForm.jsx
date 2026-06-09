// src/components/organisms/ForgotPasswordForm.jsx
// Organism — solicita o link de redefinicao de senha por e-mail via
// supabase.auth.resetPasswordForEmail. Mostra sempre uma mensagem de
// sucesso generica (nao revela se o e-mail existe — regra de seguranca).

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import AuthInput from '../atoms/AuthInput'
import GradientPillButton from '../atoms/GradientPillButton'
import InlineMessage from '../molecules/InlineMessage'

export default function ForgotPasswordForm() {
  const [email, setEmail]     = useState('')
  const [sent, setSent]       = useState(false)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)

    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/reset-password`,
    })

    setLoading(false)
    setSent(true)
  }

  if (sent) {
    return (
      <div className="space-y-4">
        <InlineMessage type="success">
          Se este e-mail estiver cadastrado, você receberá um link em instantes.
          Verifique também sua caixa de spam.
        </InlineMessage>
        <Link to="/auth/login" className="block text-center text-xs text-auth-navy hover:underline">
          ← Voltar ao login
        </Link>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-xs text-gray-500">
        Digite seu e-mail e enviaremos um link para redefinir sua senha.
      </p>

      <AuthInput
        label="E-mail"
        type="email"
        autoComplete="email"
        placeholder="seu@email.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />

      <GradientPillButton type="submit" loading={loading} loadingLabel="Enviando…">
        Enviar link de redefinição
      </GradientPillButton>

      <Link to="/auth/login" className="block text-center text-xs text-auth-navy hover:underline">
        ← Voltar ao login
      </Link>
    </form>
  )
}
