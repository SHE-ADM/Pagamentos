// src/components/dashboard/PriorityList.tsx
// Lista de "Contas críticas e prioritárias" (essenciais + vencidas), compartilhada pelos
// dashboards. Prop `rows: PriorityAccount[]`. Cor/ícone por categoria (essencial) e
// destaque vermelho para vencidas/críticas.
import type { LucideIcon } from 'lucide-react';
import { Droplet, Zap, Wifi, Home, Receipt } from 'lucide-react';
import type { PriorityAccount, PriorityKind } from '../../services/supabase';
import StatusBadge from '../StatusBadge';
import { fmtMoney, fmtDate } from '../../lib/format';

const PRIORITY_ICON: Record<PriorityKind, LucideIcon> = {
  agua: Droplet,
  luz: Zap,
  internet: Wifi,
  telefone: Receipt,
  aluguel: Home,
  tributo: Receipt,
  outro: Receipt,
};

export function PriorityList({ rows }: { rows: PriorityAccount[] }) {
  if (!rows.length) return <p className="text-xs text-slate-500 py-4">Nenhuma conta crítica ou prioritária no período.</p>;
  return (
    <div className="flex flex-col gap-1">
      {rows.map((r) => {
        const Icon = PRIORITY_ICON[r.kind];
        const err = r.critical || r.status === 'vencido';
        return (
          <div key={r.id} className={`flex items-center gap-2 px-2.5 py-1 rounded-lg border border-l-2 ${err ? 'bg-status-error-bg border-status-error-border border-l-status-error-solid' : 'bg-white border-slate-200/80 border-l-brand'}`}>
            <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${err ? 'bg-status-error-solid/10 text-status-error-fg' : 'bg-brand/10 text-brand'}`}>
              <Icon size={13} />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-slate-700 truncate">{r.supplier}</div>
              {/* slate-600 (não slate-500): nas linhas críticas o card é bg-status-error-bg
                  (vermelho-claro) e slate-500 dá 4,35:1 (reprova AA); slate-600 dá ~7:1. */}
              <div className="text-xs text-slate-600">vence {fmtDate(r.due)}</div>
            </div>
            <span className={`font-mono text-xs font-semibold whitespace-nowrap ${err ? 'text-status-error-fg' : 'text-slate-900'}`}>{fmtMoney(r.amount)}</span>
            <StatusBadge value={r.status} />
          </div>
        );
      })}
    </div>
  );
}
