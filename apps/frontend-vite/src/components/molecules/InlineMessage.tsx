// src/components/molecules/InlineMessage.tsx
// Molecule — banner de feedback inline (sucesso/erro) para as telas de
// autenticacao. Nunca usar alert() do navegador.

import type { ReactNode } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '../../lib/cn';

type InlineMessageType = 'error' | 'success';

const messageVariants = cva('rounded-lg px-3 py-2 text-sm', {
  variants: {
    type: {
      error: 'bg-status-error-bg text-status-error-fg',
      success: 'bg-status-success-bg text-status-success-fg',
    },
  },
  defaultVariants: { type: 'error' },
});

interface InlineMessageProps {
  type?: InlineMessageType;
  children?: ReactNode;
}

export default function InlineMessage({ type = 'error', children }: Readonly<InlineMessageProps>) {
  if (!children) return null;
  return <p className={cn(messageVariants({ type }))}>{children}</p>;
}
