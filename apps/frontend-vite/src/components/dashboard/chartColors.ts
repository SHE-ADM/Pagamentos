// src/components/dashboard/chartColors.ts
// Cores dos gráficos dos dashboards (donuts/legendas), compartilhadas por
// vencimentos e financeiro. Só tokens `--color-status-*` do @theme já validados
// ≥3:1 sobre branco (preenchimento gráfico — WCAG 1.4.11); nunca hex hardcoded.

// Cor semântica por NOME de status — usada no donut de situação e na legenda.
const STATUS_VAR: Record<string, string> = {
  pago: 'var(--color-status-success-fg)',
  'a vencer': 'var(--color-status-info-fg)',
  vencido: 'var(--color-status-error-solid)',
  pendente: 'var(--color-status-neutral-fg)',
  prorrogado: 'var(--color-status-prorrogado-fg)',
  baixado: 'var(--color-status-baixado-fg)',
  'cartório': 'var(--color-status-warning-fg)',
  protestado: 'var(--color-status-error-fg)',
};

export const statusColor = (s: string): string => STATUS_VAR[s] ?? 'var(--color-slate-300)';

// Paleta cíclica para donuts SEM cor semântica por categoria (tipos de conta/pagamento,
// natureza, tipo). "outros"/"não informado" ficam em cinza neutro.
const DONUT_PALETTE = [
  'var(--color-status-info-fg)', // #1d4ed8 azul
  'var(--color-status-success-fg)', // #15803d verde
  'var(--color-status-warning-fg)', // #b45309 âmbar
  'var(--color-status-error-fg)', // #b91c1c vermelho
  'var(--color-status-source-fg)', // #0f766e teal
  'var(--color-status-prorrogado-fg)', // #7c3aed violeta
  'var(--color-status-baixado-fg)', // #0e7490 ciano
  'var(--color-status-neutral-fg)', // #475569 slate
];

export const paletteColor = (label: string, i: number): string =>
  label === 'outros' || label === 'não informado' ? 'var(--color-slate-300)' : DONUT_PALETTE[i % DONUT_PALETTE.length];
