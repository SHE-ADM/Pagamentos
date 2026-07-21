// src/components/dashboard/chartCard.variants.ts
// Variantes da casca de card dos dashboards (cva em arquivo próprio — não exportar cva de
// um módulo de componente: dispara react-refresh/only-export-components).
//
// Cada valor de variante é uma string literal COMPLETA: o Tailwind JIT não gera CSS para
// nome de classe computado, então um `p-${x}` sairia sem estilo, em silêncio.
import { cva } from 'class-variance-authority';

export type ChartCardTone = 'brand' | 'danger';

// `dense` = padding menor, usado onde 4 donuts dividem a mesma linha (xl) em
// /dashboard_vencimentos; o padrão vale para os demais cards.
export const chartCardFrame = cva('card', {
  variants: {
    dense: { true: 'p-2.5', false: 'p-3' },
  },
  defaultVariants: { dense: false },
});

// Selo do ícone (cards de ranking/lista). O tom `danger` marca a lista de contas críticas.
export const chartCardIcon = cva('flex h-6 w-6 items-center justify-center rounded-lg', {
  variants: {
    tone: {
      brand: 'bg-brand/10 text-brand',
      danger: 'bg-status-error-solid/10 text-status-error-fg',
    },
  },
  defaultVariants: { tone: 'brand' },
});
