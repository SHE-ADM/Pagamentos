// src/components/dashboard/kpiCard.variants.ts
// Variantes do card de KPI dos dashboards (cva em arquivo próprio — não exportar cva de
// um módulo de componente: dispara react-refresh/only-export-components).
//
// Contraste (WCAG AA) das decisões de cor aqui — medido e travado em
// tests/contrast-usage.a11y.test.ts, NÃO afrouxar sem remedir:
//   • hover usa `bg-slate-50`, o tom mais escuro em que TODOS os textos do card ainda
//     passam (slate-500 = 4,55 · status-success-fg = 4,79). Com `bg-slate-100` o
//     slate-500 cairia para 4,34 e reprovaria.
//   • o selo do estado ativo usa brand-dark sobre brand-light (5,46). Tintar o CARD
//     INTEIRO de brand-light foi descartado: derrubaria slate-500 para 4,19 e
//     status-success-fg para 4,42.
import { cva } from 'class-variance-authority';

export type KpiTone = 'neutral' | 'success' | 'muted' | 'danger';

// Cada valor de variante é uma string literal COMPLETA (Tailwind JIT não gera CSS para
// nome de classe computado).
export const kpiCard = cva(
  'flex items-center gap-2 rounded-lg p-2 border-l-4 bg-white text-left w-full cursor-pointer' +
    ' shadow-xs animate-fade-in-up transition-all duration-150' +
    // Affordance de clique: o card "levanta" e escurece de leve no hover. `-translate-y`
    // é transform — não desloca os vizinhos (mudar a espessura da borda deslocaria).
    // `motion-reduce:*` desliga o movimento para quem pediu menos animação no SO; o
    // hover continua perceptível pelo fundo + sombra.
    ' hover:bg-slate-50 hover:shadow-md hover:-translate-y-0.5' +
    ' motion-reduce:transition-none motion-reduce:hover:translate-y-0' +
    // FOCO ≠ ATIVO (WCAG 2.4.7): o anel de foco usa OUTRA cor e um halo maior que o do
    // estado ativo. Com os dois iguais (era `ring-brand` nos dois), chegar por teclado ao
    // card já selecionado não mudava nada na tela — o foco ficava invisível ali.
    ' focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark' +
    ' focus-visible:ring-offset-2 focus-visible:ring-offset-white',
  {
    variants: {
      tone: {
        neutral: 'border-l-brand',
        success: 'border-l-status-success-fg',
        muted: 'border-l-brand',
        danger: 'border-l-status-error-solid',
      },
      // Selecionado = anel de marca + halo (ring-offset) + elevação. O selo "filtrando"
      // no corpo do card completa o sinal: WCAG 1.4.1 proíbe cor como ÚNICO indicador.
      // Sem `hover:ring-*` em lugar nenhum — competiria com este anel na mesma variável
      // (--tw-ring-width) e o hover apagaria o destaque do card ativo.
      // `ring-offset-white` explícito: o halo depende da cor do fundo atrás do card (hoje
      // o <main> é branco) e o default do Tailwind não é garantia contratual.
      active: {
        true: 'ring-2 ring-brand ring-offset-1 ring-offset-white shadow-md',
        false: '',
      },
    },
    defaultVariants: { tone: 'neutral', active: false },
  },
);

export const kpiIcon = cva('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', {
  variants: {
    tone: {
      neutral: 'bg-brand/10 text-brand',
      success: 'bg-status-success-bg text-status-success-fg',
      muted: 'bg-brand/10 text-brand',
      danger: 'bg-status-error-solid/10 text-status-error-fg',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export const kpiValue = cva('', {
  variants: {
    tone: {
      neutral: 'text-slate-800',
      success: 'text-status-success-fg',
      muted: 'text-slate-500',
      danger: 'text-status-error-fg',
    },
  },
  defaultVariants: { tone: 'neutral' },
});
