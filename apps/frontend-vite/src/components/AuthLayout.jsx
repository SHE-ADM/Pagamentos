// src/components/AuthLayout.jsx
// Wrapper full-page das telas de autenticacao: fundo com gradiente `auth`,
// card branco central com cabecalho decorativo (AuthHeroHeader), conteudo
// (formulario) e fileira de logos sociais — composicao baseada na
// referencia visual (Login Page.png).

import AuthHeroHeader from './molecules/AuthHeroHeader'
import SocialLinksBar from './molecules/SocialLinksBar'

export default function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-auth px-4 py-10">
      <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-xl">
        <AuthHeroHeader title={title} subtitle={subtitle} />

        <div className="px-6 pb-6 pt-8 space-y-5">
          {children}

          <div className="pt-2">
            <SocialLinksBar />
          </div>
        </div>
      </div>
    </div>
  )
}
