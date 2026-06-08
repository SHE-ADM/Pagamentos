import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Eye, EyeOff } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import FilledTextField from '../atoms/FilledTextField'
import AccentPillButton from '../atoms/AccentPillButton'
import SocialLinksBar from '../molecules/SocialLinksBar'

export default function LoginForm() {
  const navigate = useNavigate()
  const [email, setEmail]               = useState('')
  const [password, setPassword]         = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [remember, setRemember]         = useState(true)
  const [error, setError]               = useState(null)
  const [loading, setLoading]           = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)
    if (error) {
      setError('E-mail ou senha incorretos.')
      return
    }
    navigate('/emails')
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5 w-full">

      {/* Cabeçalho */}
      <div className="flex flex-col gap-1.5">
        <h1 className="text-4xl font-extrabold text-loginGreen-ink tracking-tight leading-none">
          Login
        </h1>
        <p className="text-lg font-medium text-loginGreen-accent">
          Boas-vindas! Faça seu login.
        </p>
      </div>

      {/* Campo e-mail */}
      <FilledTextField
        label="Email ou usuário"
        type="email"
        autoComplete="email"
        placeholder="usuario123"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />

      {/* Campo senha com toggle */}
      <FilledTextField
        label="Senha"
        type={showPassword ? 'text' : 'password'}
        autoComplete="current-password"
        placeholder="••••••"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        endAdornment={
          <button
            type="button"
            onClick={() => setShowPassword((prev) => !prev)}
            aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
            className="text-loginGreen-inkFaint hover:text-loginGreen-borderFocus flex items-center flex-shrink-0 transition-colors"
          >
            {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
          </button>
        }
      />

      {/* Lembrar-me + Esqueci a senha */}
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm font-medium text-loginGreen-inkMid cursor-pointer select-none">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="w-4.5 h-4.5 accent-loginGreen-borderFocus cursor-pointer flex-shrink-0"
          />
          Lembrar-me
        </label>
        <Link
          to="/auth/forgot-password"
          className="text-sm font-semibold text-loginGreen-accent hover:underline whitespace-nowrap"
        >
          Esqueci a senha
        </Link>
      </div>

      {/* Mensagem de erro */}
      {error && (
        <p className="bg-red-50 text-red-700 rounded-lg px-3.5 py-2.5 text-sm">
          {error}
        </p>
      )}

      {/* Botão Login */}
      <AccentPillButton type="submit" loading={loading} loadingLabel="Entrando…">
        Login
      </AccentPillButton>

      {/* Logos sociais */}
      <SocialLinksBar />

    </form>
  )
}
