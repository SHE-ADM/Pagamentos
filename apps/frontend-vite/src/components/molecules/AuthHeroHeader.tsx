// src/components/molecules/AuthHeroHeader.tsx
// Molecule — cabecalho decorativo das telas de autenticacao: gradiente
// `auth` com circulos sobrepostos, recriando em CSS a composicao da
// referencia visual (Login Page.png), com o titulo da tela por cima.

interface AuthHeroHeaderProps {
  title: string;
  subtitle?: string;
}

export default function AuthHeroHeader({ title, subtitle }: AuthHeroHeaderProps) {
  return (
    <div className="relative h-40 overflow-hidden rounded-t-2xl bg-gradient-auth">
      <div className="absolute -left-10 -top-16 h-44 w-44 rounded-full bg-white/10" />
      <div className="absolute -right-12 -top-8 h-36 w-36 rounded-full bg-white/15" />
      <div className="absolute left-1/2 top-20 h-20 w-20 -translate-x-1/2 rounded-full bg-white/25 shadow-lg" />

      <div className="relative z-10 flex h-full flex-col items-center justify-center px-6 text-center">
        <h1 className="font-sans text-xl font-bold text-white">{title}</h1>
        {subtitle && <p className="mt-1 text-xs text-white/80">{subtitle}</p>}
      </div>
    </div>
  );
}
