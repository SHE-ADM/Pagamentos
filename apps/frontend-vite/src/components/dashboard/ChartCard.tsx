// src/components/dashboard/ChartCard.tsx
// Casca de um card de gráfico/lista dos dashboards: moldura + título + subtítulo (+ ícone).
// Existia DUPLICADA em 11 blocos entre pages/Dashboard.tsx e pages/DashboardFinanceiro.tsx —
// mesmo markup, só mudando os textos. Além do custo de manutenção, duplicação em código
// novo reprova o quality gate do SonarCloud (já aconteceu neste repo).
//
// Apresentacional PURO: sem estado, sem dado, sem acesso a serviço — recebe o conteúdo por
// `children`. As duas variantes (com e sem ícone) preservam EXATAMENTE o markup anterior,
// para o layout e os testes das duas páginas não regredirem.
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

// Tom do ícone — classes LITERAIS completas (Tailwind JIT não gera nome computado).
const TONE_CLS = {
  brand: 'flex h-6 w-6 items-center justify-center rounded-lg bg-brand/10 text-brand',
  danger: 'flex h-6 w-6 items-center justify-center rounded-lg bg-status-error-solid/10 text-status-error-fg',
} as const;

// Não exportado: só o contrato de props usa (export sem consumidor = órfão no ts-prune).
type ChartCardTone = keyof typeof TONE_CLS;

// `dense` = padding menor (p-2.5), usado onde 4 donuts dividem a mesma linha (xl) em
// /dashboard_vencimentos; o padrão (p-3) vale para os demais cards.
const PADDING_CLS = { normal: 'card p-3', dense: 'card p-2.5' } as const;

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
  tone = 'brand',
  dense = false,
  className,
  children,
}: Readonly<ChartCardProps>) {
  const frameCls = PADDING_CLS[dense ? 'dense' : 'normal'] + (className ? ` ${className}` : '');
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
          <span className={TONE_CLS[tone]}>
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
