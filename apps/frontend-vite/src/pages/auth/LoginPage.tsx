import LoginForm from '../../components/organisms/LoginForm';

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-white flex items-center justify-center px-4 py-8 font-jakarta antialiased">
      {/* Frame externo */}
      <div className="w-full max-w-sm flex flex-col border-[6px] border-loginGreen-border rounded-2xl overflow-hidden">
        {/* Banner */}
        <div className="relative">
          <img
            src="/login-banner-v2.png"
            alt="Otimotex — catálogo de tecidos"
            className="w-[calc(100%+2px)] max-w-none -ml-px h-56 object-cover object-[center_25%] block"
          />
          {/* Moldura interna — topo e base apenas */}
          <div className="absolute inset-0 border-t-[6px] border-b-[6px] border-loginGreen-border pointer-events-none" />
        </div>

        {/* Divisor */}
        <div className="h-1 bg-loginGreen-border" />

        {/* Card */}
        <div className="bg-white px-6 pt-2.5 pb-3 flex flex-col ring-inset ring-4 ring-loginGreen-border/25">
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
