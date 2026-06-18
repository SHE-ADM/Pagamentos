// src/components/atoms/Alert.tsx
// Atom — banner de feedback de página (erro/sucesso/aviso/info). Centraliza a
// escolha de cores e ícone via cva + tokens semânticos `status-*`, em vez de
// classes escolhidas à mão em cada uso. Para feedback inline de auth, ver
// molecules/InlineMessage.
import type { ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { AlertCircle, CheckCircle2, AlertTriangle, Info, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

// Cada valor é string literal completa — exigência do JIT do Tailwind.
const alertVariants = cva('flex gap-2 rounded-lg border p-3 text-sm', {
  variants: {
    variant: {
      error: 'bg-status-error-bg border-status-error-border text-status-error-fg',
      success: 'bg-status-success-bg border-status-success-border text-status-success-fg',
      warning: 'bg-status-warning-bg border-status-warning-border text-status-warning-fg',
      info: 'bg-status-info-bg border-status-info-border text-status-info-fg',
    },
  },
  defaultVariants: { variant: 'error' },
});

type AlertVariant = NonNullable<VariantProps<typeof alertVariants>['variant']>;

// Ícone por variante — selecionado pela mesma chave da cva (sem escolha manual no uso).
const ICONS: Record<AlertVariant, LucideIcon> = {
  error: AlertCircle,
  success: CheckCircle2,
  warning: AlertTriangle,
  info: Info,
};

interface AlertProps {
  variant?: AlertVariant;
  children: ReactNode;
  className?: string;
}

export default function Alert({ variant = 'error', children, className }: Readonly<AlertProps>) {
  const Icon = ICONS[variant];
  return (
    <div role="alert" className={cn(alertVariants({ variant }), className)}>
      <Icon size={16} aria-hidden="true" className="shrink-0 mt-0.5" />
      <span>{children}</span>
    </div>
  );
}
