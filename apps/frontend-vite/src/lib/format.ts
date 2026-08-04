// src/lib/format.ts
// Formatadores de exibição compartilhados (data, data/hora, moeda BRL, CNPJ/CPF e
// classificação contábil). FONTE ÚNICA — antes havia cópias idênticas em
// Consulta.tsx, useGridColumns.ts e Emails.tsx (risco de drift).
import type { FinancialAccountControl } from '@sheild/shared';

/** Data YYYY-MM-DD → dd/mm/aaaa (meia-noite local). '—' quando vazio. */
export const fmtDate = (d: string | null): string =>
  d ? new Date(d + 'T00:00:00').toLocaleDateString('pt-BR') : '—';

/**
 * Data corrente no formato YYYY-MM-DD, pela data LOCAL (não UTC) — à noite, o UTC já
 * está no dia seguinte e a data "voltaria um dia". Consumida pelo ContaForm (default de
 * emissão/vencimento na inclusão) e pelo update otimista de situação em /consulta, que
 * espelha o carimbo de `payment_date` feito pela trigger no banco.
 */
export const todayISO = (): string => {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
};

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

/**
 * Nome do fornecedor para exibição: nome fantasia + razão social **quando divergem**.
 *
 * O grid mostrava apenas `trade_name`, e quando o nome fantasia cadastrado é uma MARCA
 * ("PEGAMIL") em vez da razão social ("ITW PPF BRASIL ADESIVOS LTDA") o fornecedor ficava
 * irreconhecível — parecia a conta de outra empresa.
 *
 * Só concatena quando os dois nomes acrescentam informação um ao outro. Quando um CONTÉM o
 * outro ("CIPATEX" dentro de "CIPATEX IMPREGNADORA DE PAPÉIS E TECIDOS LTDA") repetir seria
 * poluição sem ganho: o fantasia sozinho já identifica. A comparação ignora acento, caixa e
 * pontuação, senão "S/A" × "SA" contariam como nomes distintos.
 *
 * Medido no cadastro (1.294 fornecedores ativos): 534 exibem os dois, 734 caem no caso
 * "um contém o outro" e 26 têm só um dos nomes.
 */
export const fmtSupplierName = (
  s?: { trade_name?: string | null; legal_name?: string | null } | null,
): string => {
  const trade = s?.trade_name?.trim() ?? '';
  const legal = s?.legal_name?.trim() ?? '';
  if (!trade) return legal || '—';
  if (!legal) return trade;
  const t = normalizeName(trade);
  const l = normalizeName(legal);
  // Normalização vazia (nome só de pontuação) cairia em includes('') === true e esconderia
  // a razão social — trata como "não comparável" e mostra os dois.
  if (t && l && (l.includes(t) || t.includes(l))) return trade;
  return `${trade} · ${legal}`;
};

// Compara nomes ignorando acento, caixa e pontuação: "S/A" e "SA" são o mesmo nome.
const normalizeName = (v: string): string =>
  v
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
