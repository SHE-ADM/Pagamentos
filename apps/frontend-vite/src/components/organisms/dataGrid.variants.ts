// Variantes visuais do DataGrid — separadas do componente para não disparar o
// aviso react-refresh/only-export-components (Fast Refresh). Cada slot é um cva
// com base + tema; cada valor é string literal completa (JIT-safe — o Tailwind
// não gera CSS para nomes de classe computados/concatenados).
import { cva } from 'class-variance-authority';

/** Tema visual do grid: `default` (slate, /consulta) ou `silver` (zinc, /emails). */
export type GridVariant = 'default' | 'silver';

/** Célula de cabeçalho (th) — tema + alinhamento + estado de ordenação.
 *  Sem `sticky`: a tabela vive num wrapper `overflow-x-auto` (rolagem horizontal),
 *  que seria um novo contexto de rolagem e quebraria o sticky vertical. */
export const headerCell = cva('select-none transition-colors', {
  variants: {
    variant: { default: 'table-header', silver: 'table-header-silver' },
    align: { left: '', right: 'text-right', center: 'text-center' },
    sortable: { true: 'cursor-pointer', false: '' },
    active: { true: 'bg-slate-100', false: '' },
  },
  // Hover só em coluna ordenável que ainda não é a ativa.
  compoundVariants: [{ sortable: true, active: false, class: 'hover:bg-slate-100' }],
  defaultVariants: { variant: 'default', align: 'left', sortable: false, active: false },
});

/** Ícone de ordenação no cabeçalho — destacado quando a coluna está ativa. */
export const sortIcon = cva('', {
  variants: { active: { true: 'text-brand', false: 'text-slate-300' } },
  defaultVariants: { active: false },
});

/** Linha de dados (tr) — selecionada (acento) ou hover por tema. */
export const bodyRow = cva('cursor-pointer transition-colors', {
  variants: {
    variant: { default: '', silver: '' },
    selected: { true: 'bg-brand/5 border-l-2 border-brand', false: '' },
  },
  compoundVariants: [
    { variant: 'default', selected: false, class: 'hover:bg-slate-50/60' },
    { variant: 'silver', selected: false, class: 'bg-zinc-100 hover:bg-zinc-200/60' },
  ],
  defaultVariants: { variant: 'default', selected: false },
});

/**
 * Célula (td) — tema + alinhamento. `dense` adiciona o tipo monoespaçado/menor
 * das linhas de dados; o skeleton usa a célula sem `dense`.
 */
export const bodyCell = cva('', {
  variants: {
    variant: { default: 'table-cell text-slate-600', silver: 'table-cell-silver text-zinc-600' },
    align: { left: '', right: 'text-right', center: 'text-center' },
    dense: { true: 'text-xs font-mono', false: '' },
  },
  defaultVariants: { variant: 'default', align: 'left', dense: false },
});

/** Barra pulsante do skeleton de carregamento. */
export const skeletonBar = cva('h-3 rounded', {
  variants: { variant: { default: 'bg-slate-100', silver: 'bg-zinc-100' } },
  defaultVariants: { variant: 'default' },
});

/** Ícone circular do estado vazio. */
export const emptyIcon = cva('flex h-14 w-14 items-center justify-center rounded-full', {
  variants: { variant: { default: 'bg-slate-100 text-slate-300', silver: 'bg-zinc-100 text-zinc-300' } },
  defaultVariants: { variant: 'default' },
});

/** Texto do estado vazio. */
export const emptyText = cva('text-sm max-w-xs', {
  variants: { variant: { default: 'text-slate-400', silver: 'text-zinc-400' } },
  defaultVariants: { variant: 'default' },
});

/** Célula da sub-linha de detalhe (colunas que desceram no mobile/tablet). */
export const secondCell = cva('', {
  variants: { variant: { default: 'table-cell-secondary', silver: 'table-cell-secondary-silver' } },
  defaultVariants: { variant: 'default' },
});

/** Texto da sub-linha de detalhe por tom (separador, rótulo, valor) e tema. */
export const secondText = cva('', {
  variants: {
    variant: { default: '', silver: '' },
    tone: { sep: '', label: '', value: '' },
  },
  compoundVariants: [
    { variant: 'default', tone: 'sep', class: 'text-slate-300' },
    { variant: 'default', tone: 'label', class: 'text-slate-400' },
    { variant: 'default', tone: 'value', class: 'text-slate-500' },
    { variant: 'silver', tone: 'sep', class: 'text-zinc-300' },
    { variant: 'silver', tone: 'label', class: 'text-zinc-400' },
    { variant: 'silver', tone: 'value', class: 'text-zinc-500' },
  ],
  defaultVariants: { variant: 'default', tone: 'value' },
});

/** Célula do painel de detalhe expandido abaixo da linha selecionada. */
export const detailCell = cva('p-0 border-b', {
  variants: { variant: { default: 'border-slate-100', silver: 'border-zinc-100' } },
  defaultVariants: { variant: 'default' },
});
