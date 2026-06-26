// src/lib/format.ts
// Formatadores de exibição compartilhados (data, data/hora, moeda BRL, CNPJ/CPF e
// classificação contábil). FONTE ÚNICA — antes havia cópias idênticas em
// Consulta.tsx, useGridColumns.ts e Emails.tsx (risco de drift).
import type { FinancialAccountControl } from '@sheild/shared';

/** Data YYYY-MM-DD → dd/mm/aaaa (meia-noite local). '—' quando vazio. */
export const fmtDate = (d: string | null): string =>
  d ? new Date(d + 'T00:00:00').toLocaleDateString('pt-BR') : '—';

/** Data/hora ISO → dd/mm/aaaa hh:mm. '—' quando vazio. */
export const fmtDateTime = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

/** Número → moeda BRL. '—' quando null. */
export const fmtMoney = (v: number | null): string =>
  v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** CNPJ de 14 dígitos → 00.000.000/0000-00. Devolve o original (ou '—') fora do formato. */
export const fmtCnpj = (c: string | null): string =>
  c?.length === 14
    ? `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`
    : c || '—';

/** CPF de 11 dígitos → 000.000.000-00. Devolve o original (ou '—') fora do formato. */
export const fmtCpf = (c: string | null): string =>
  c?.length === 11 ? `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}` : c || '—';

// Classificação contábil (embeds cost_center / chart_account — código + descrição).
// id 0 = "não informado" (sentinela) → '—' (o plano id 0 tem código literal '0').
export const fmtCostCenter = (r: FinancialAccountControl): string =>
  r.cost_center_id
    ? [r.cost_center?.cost_center_code, r.cost_center?.cost_center_description].filter(Boolean).join(' — ') ||
      `#${r.cost_center_id}`
    : '—';

export const fmtChartAccount = (r: FinancialAccountControl): string =>
  r.chart_account_id
    ? [r.chart_account?.account_code, r.chart_account?.account_description].filter(Boolean).join(' — ') ||
      `#${r.chart_account_id}`
    : '—';
