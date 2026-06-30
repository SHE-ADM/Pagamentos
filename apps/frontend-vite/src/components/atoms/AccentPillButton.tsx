import { ArrowRight } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '../../lib/cn';

interface AccentPillButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
  loadingLabel?: string;
  children: ReactNode;
}

const accentPillButton = cva(
  `w-full h-10 text-sm font-bold text-white rounded-md flex items-center justify-center gap-2
   transition-colors
   bg-loginGreen-accent hover:bg-loginGreen-accentHover
   disabled:bg-loginGreen-accentMuted disabled:cursor-not-allowed`,
);

// Atom — botão de ação primária com ícone de avanço.
// Estados: default (verde), hover (verde escuro), disabled/loading (verde atenuado).
export default function AccentPillButton({
  loading,
  loadingLabel,
  children,
  className,
  ...buttonProps
}: Readonly<AccentPillButtonProps>) {
  return (
    <button
      {...buttonProps}
      disabled={loading || buttonProps.disabled}
      className={cn(accentPillButton(), className)}
    >
      {loading ? (
        (loadingLabel ?? 'Aguarde…')
      ) : (
        <>
          {children}
          <ArrowRight size={16} strokeWidth={2.5} />
        </>
      )}
    </button>
  );
}
