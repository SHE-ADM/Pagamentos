// src/components/dashboard/ChartCard.tsx
// Casca de um card de gráfico/lista dos dashboards: moldura + título + subtítulo (+ ícone).
// Existia DUPLICADA em 10 blocos entre pages/Dashboard.tsx e pages/DashboardFinanceiro.tsx —
// mesmo markup, só mudando os textos. Além do custo de manutenção, duplicação em código
// novo reprova o quality gate do SonarCloud (já aconteceu neste repo).
//
// Apresentacional PURO: sem estado, sem dado, sem acesso a serviço — recebe o conteúdo por
// `children`. As duas variantes (com e sem ícone) preservam EXATAMENTE o markup anterior,
// para o layout e os testes das duas páginas não regredirem.
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { chartCardFrame, chartCardIcon, type ChartCardTone } from './chartCard.variants';

interface ChartCardProps {
  title: string;
  subtitle: string;
  /** Ícone opcional à esquerda do título (cards de ranking/lista). */
  icon?: LucideIcon;
  /** Tom do ícone; ignorado sem `icon`. */
  tone?: ChartCardTone;
  dense?: boolean;
  /** Classe extra da moldura (ex.: `mb-3` quando o card ocupa a linha inteira). */
  className?: string;
  children: ReactNode;
}

export function ChartCard({
  title,
  subtitle,
  icon: Icon,
  tone,
  dense = false,
  className,
  children,
}: Readonly<ChartCardProps>) {
  // `cn` (clsx + tailwind-merge) e não concatenação: a classe do chamador precisa VENCER a
  // da variante quando as duas mexem no mesmo utilitário. Com `+`, um `className="p-4"`
  // produziria "p-3 p-4" e quem ganha passaria a depender da ordem no CSS, não da intenção.
  const frameCls = cn(chartCardFrame({ dense }), className);
  const heading = (
    <div>
      <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
      <p className="text-xs text-slate-500">{subtitle}</p>
    </div>
  );

  return (
    <div className={frameCls}>
      {Icon ? (
        <div className="flex items-center gap-2 mb-2">
          <span className={cn(chartCardIcon({ tone }))}>
            <Icon size={14} />
          </span>
          {heading}
        </div>
      ) : (
        <div className="mb-2">{heading}</div>
      )}
      {children}
    </div>
  );
}
