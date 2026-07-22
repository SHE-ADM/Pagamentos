// src/components/dashboard/KpiCard.tsx
// Card de KPI clicável (= filtro) da faixa superior dos dashboards, compartilhado por
// /dashboard_vencimentos e /dashboard_despesas — antes o bloco era duplicado literalmente
// nas duas páginas, então qualquer ajuste visual precisava ser feito (e lembrado) duas vezes.
// Apresentacional puro: quem decide o que está ativo e o que fazer no clique é a página.
import type { LucideIcon } from 'lucide-react';
import { fmtMoney } from '../../lib/format';
import { cn } from '../../lib/cn';
import { kpiCard, kpiIcon, kpiValue, type KpiTone } from './kpiCard.variants';

// Formata a contagem no padrão pt-BR (1.234 contas) — sem isso, mês com mais de mil
// contas mostraria "1234" cru ao lado do valor, que é formatado.
const fmtCount = (n: number): string => new Intl.NumberFormat('pt-BR').format(n);

type Props = {
  icon: LucideIcon;
  label: string;
  amount: number;
  count: number;
  tone: KpiTone;
  /** Selecionado: o card vira o filtro em vigor (anel + selo "filtrando"). */
  active: boolean;
  onClick: () => void;
};

export function KpiCard({ icon: Icon, label, amount, count, tone, active, onClick }: Readonly<Props>) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={active ? 'Limpar filtro' : `Filtrar por ${label}`}
      className={kpiCard({ tone, active })}
    >
      <div className={kpiIcon({ tone })}>
        <Icon size={14} />
      </div>
      <div className="min-w-0">
        <div className={cn('font-mono text-xl font-semibold leading-tight truncate', kpiValue({ tone }))}>{fmtMoney(amount)}</div>
        <div className={cn('text-base leading-tight', kpiValue({ tone }))}>
          {fmtCount(count)}<span className="text-xs font-normal text-slate-500 ml-1">conta(s)</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-xs text-slate-500 truncate">{label}</span>
          {/* Sinal NÃO-cromático do estado ativo (WCAG 1.4.1): o anel sozinho seria o
              único indicador, invisível para quem não distingue a cor de marca. */}
          {active && (
            <span className="shrink-0 rounded-sm bg-brand-light px-1 text-xs font-semibold text-brand-dark">
              filtrando
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
