// src/components/StatusBadge.tsx
import { FileText, ScanLine } from 'lucide-react';
import { cn } from '../lib/cn';
import { badgeLabel, badgeVariants, resolveBadge, type BadgeKind } from './statusBadge.variants';

interface StatusBadgeProps {
  value: string | null | undefined;
}

export default function StatusBadge({ value }: Readonly<StatusBadgeProps>) {
  // Apenas nulo/vazio vira travessão; valor não mapeado cai no fallback neutro.
  if (!value) return <span className="text-ink-secondary">—</span>;

  const resolved = resolveBadge(value);
  const variant = resolved?.variant ?? 'neutral';
  // 'plain' = valor sem prefixo (nenhum ponto/ícone); fora da união BadgeKind.
  const kind: BadgeKind | 'plain' = resolved?.kind ?? 'plain';

  return (
    <span className={cn(badgeVariants({ variant }))}>
      {kind === 'status' && (
        // Ponto colorido herda a cor do texto (bg-current).
        <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" aria-hidden="true" />
      )}
      {kind === 'document' && <FileText size={11} className="opacity-70" aria-hidden="true" />}
      {kind === 'source' && <ScanLine size={11} className="opacity-70" aria-hidden="true" />}
      {badgeLabel(value)}
    </span>
  );
}
