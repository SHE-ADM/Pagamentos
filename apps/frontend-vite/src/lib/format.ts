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

/** Número → moeda BRL compacta (ex.: "R$ 12,3 mil", "R$ 1,2 mi"). '—' quando null.
 *  Usado onde o espaço é curto (ex.: furo central dos donuts). */
export const fmtMoneyCompact = (v: number | null): string =>
  v == null
    ? '—'
    : Number(v).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
        notation: 'compact',
        maximumFractionDigits: 1,
      });

/**
 * Bytes → tamanho legível (B / KB / MB), com vírgula decimal do pt-BR.
 * Base 1024 (o que o SO e o Storage reportam). '—' quando não informado.
 */
export const fmtBytes = (bytes: number | null | undefined): string => {
  if (bytes == null || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} KB`;
  return `${(kb / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
};

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

// Une código + descrição num par legível ("código — descrição"); '' quando ambos vazios
// (para ser descartado pelo filter no concat abaixo).
const codeDesc = (code?: string | null, desc?: string | null): string =>
  [code, desc].filter(Boolean).join(' — ');

// Célula "Plano de contas" do grid de /consulta (visualização enriquecida): concatena
// plano de contas + grupo + subgrupo + centro de custo. Cada parte é "código — descrição";
// partes ausentes (id 0 / embed nulo) são omitidas. Grupo/subgrupo vêm dos embeds aninhados
// em `chart_account`; o centro de custo é o da própria conta (`cost_center_id`), o mesmo que
// era exibido na coluna removida. Separador ' · '.
export const fmtChartAccountFull = (r: FinancialAccountControl): string => {
  const parts = [
    r.chart_account_id ? codeDesc(r.chart_account?.account_code, r.chart_account?.account_description) || `#${r.chart_account_id}` : '',
    codeDesc(r.chart_account?.group?.group_code, r.chart_account?.group?.group_description),
    codeDesc(r.chart_account?.subgroup?.subgroup_code, r.chart_account?.subgroup?.subgroup_description),
    r.cost_center_id ? codeDesc(r.cost_center?.cost_center_code, r.cost_center?.cost_center_description) || `#${r.cost_center_id}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : '—';
};
