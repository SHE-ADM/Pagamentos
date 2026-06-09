import { ArrowRight } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface AccentPillButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
  loadingLabel?: string;
  children: ReactNode;
}

// Atom — botão de ação primária com ícone de avanço.
// Estados: default (verde), hover (verde escuro), disabled/loading (verde atenuado).
export default function AccentPillButton({ loading, loadingLabel, children, ...buttonProps }: AccentPillButtonProps) {
  return (
    <button
      {...buttonProps}
      disabled={loading || buttonProps.disabled}
      className="w-full h-14 text-xl font-bold text-white rounded-lg flex items-center justify-center gap-2.5
        transition-colors
        bg-loginGreen-accent hover:bg-loginGreen-accentHover
        disabled:bg-loginGreen-accentMuted disabled:cursor-not-allowed"
    >
      {loading ? (
        (loadingLabel ?? 'Aguarde…')
      ) : (
        <>
          {children}
          <ArrowRight size={20} strokeWidth={2.5} />
        </>
      )}
    </button>
  );
}
