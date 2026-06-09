import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface GradientPillButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
  loadingLabel?: string;
  children: ReactNode;
}

// Atom — botao em formato pill com gradiente da paleta `auth`, com estado
// de carregamento. Usado nas acoes principais das telas de autenticacao.
export default function GradientPillButton({
  loading,
  loadingLabel,
  children,
  className = '',
  ...buttonProps
}: GradientPillButtonProps) {
  return (
    <button
      className={`w-full rounded-full bg-gradient-auth text-white font-semibold text-sm
                  py-2.5 shadow-md transition-opacity hover:opacity-90
                  disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      disabled={loading || buttonProps.disabled}
      {...buttonProps}
    >
      {loading ? (loadingLabel ?? 'Aguarde…') : children}
    </button>
  );
}
