import LoginForm from '../../components/organisms/LoginForm'

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-white flex items-center justify-center px-4 py-8 font-jakarta antialiased">

      {/* Frame externo */}
      <div className="w-full max-w-sm flex flex-col border-8 border-loginGreen-border rounded-2xl overflow-hidden">

        {/* Banner */}
        <div className="relative">
          <img
            src="/login-banner-v2.png"
            alt="Otimotex — catálogo de tecidos"
            className="w-full h-64 object-cover object-[center_25%] block"
          />
          {/* Moldura interna — topo e base apenas */}
          <div className="absolute inset-0 border-t-8 border-b-8 border-loginGreen-border pointer-events-none" />
        </div>

        {/* Divisor */}
        <div className="h-1 bg-loginGreen-border" />

        {/* Card */}
        <div className="bg-white p-6 pb-7 flex flex-col ring-inset ring-4 ring-loginGreen-border/25">
          <LoginForm />
        </div>

      </div>
    </div>
  )
}
