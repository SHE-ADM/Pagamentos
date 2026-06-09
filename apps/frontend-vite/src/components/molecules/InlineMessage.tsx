// src/components/molecules/InlineMessage.tsx
// Molecule — banner de feedback inline (sucesso/erro) para as telas de
// autenticacao. Nunca usar alert() do navegador.

import type { ReactNode } from 'react';

type InlineMessageType = 'error' | 'success';

const styles: Record<InlineMessageType, string> = {
  error: 'bg-red-50 text-red-700',
  success: 'bg-green-50 text-green-700',
};

interface InlineMessageProps {
  type?: InlineMessageType;
  children?: ReactNode;
}

export default function InlineMessage({ type = 'error', children }: InlineMessageProps) {
  if (!children) return null;
  return <p className={`rounded-lg px-3 py-2 text-sm ${styles[type]}`}>{children}</p>;
}
