// src/components/dashboard/KpiRow.tsx
// Faixa dos 5 cards de KPI (grid + o map sobre KpiCard). Existe para as páginas não
// repetirem o mesmo `map` com as mesmas 8 props — depois de extrair o KpiCard, o bloco
// de chamada continuava idêntico nas duas telas.
//
// Regra do "ativo" mora AQUI (era repetida nas duas páginas): o KPI 'total' representa a
// AUSÊNCIA de filtro, então nunca aparece selecionado.
import type { LucideIcon } from 'lucide-react';
import type { KpiFilter } from '../../services/supabase';
import { KpiCard } from './KpiCard';
import type { KpiTone } from './kpiCard.variants';

export interface KpiEntry {
  icon: LucideIcon;
  label: string;
  amount: number;
  count: number;
  tone: KpiTone;
  filter: KpiFilter;
}

type Props = Readonly<{
  items: KpiEntry[];
  /** Filtro em vigor na página. */
  filter: KpiFilter;
  onToggle: (filter: KpiFilter) => void;
}>;

export function KpiRow({ items, filter, onToggle }: Props) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2 mb-3">
      {items.map((k) => (
        <KpiCard
          key={k.label}
          icon={k.icon}
          label={k.label}
          amount={k.amount}
          count={k.count}
          tone={k.tone}
          active={filter === k.filter && k.filter !== 'total'}
          onClick={() => onToggle(k.filter)}
        />
      ))}
    </div>
  );
}
