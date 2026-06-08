// src/components/organisms/ResetPasswordForm.jsx
// Organism — define a nova senha apos o usuario clicar no link do e-mail
// de redefinicao. O Supabase processa o token da URL automaticamente via
// onAuthStateChange (evento PASSWORD_RECOVERY) e abre uma sessao temporaria;
// em seguida supabase.auth.updateUser troca a senha.

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import AuthInput from '../atoms/AuthInput'
import GradientPillButton from '../atoms/GradientPillButton'
import InlineMessage from '../molecules/InlineMessage'

const MIN_PASSWORD_LENGTH = 8

export default function ResetPasswordForm() {
  const navigate = useNavigate()
  const [password, setPassword]               = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError]     = useState(null)
  const [loading, setLoading] = useState(false)

  const validate = () => {
    if (password.length < MIN_PASSWORD_LENGTH) {
      return `A senha deve ter no mínimo ${MIN_PASSWORD_LENGTH} caracteres.`
    }
    if (password !== confirmPassword) {
      return 'As senhas não conferem.'
    }
    return null
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)

    const validationError = validate()
    if (validationError) {
      setError(validationError)
      return
    }

    setLoading(true)
    const { error } = await supabase.auth.updateUser({ password })
    setLoading(false)

    if (error) {
      setError('Não foi possível redefinir a senha. Solicite um novo link e tente novamente.')
      return
    }

    await supabase.auth.signOut()
    navigate('/auth/login', { replace: true, state: { passwordReset: true } })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-xs text-gray-500">
        Defina sua nova senha de acesso.
      </p>

      <AuthInput
        label="Nova senha"
        type="password"
        autoComplete="new-password"
        placeholder="••••••••"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />

      <AuthInput
        label="Confirmar nova senha"
        type="password"
        autoComplete="new-password"
        placeholder="••••••••"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        required
      />

      <InlineMessage type="error">{error}</InlineMessage>

      <GradientPillButton type="submit" loading={loading} loadingLabel="Redefinindo…">
        Redefinir senha
      </GradientPillButton>
    </form>
  )
}
