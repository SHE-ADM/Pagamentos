import { Fragment, type ReactNode } from 'react';
import { Inbox, ArrowUp, ArrowDown, ArrowUpDown, type LucideIcon } from 'lucide-react';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import type { ColumnDef } from '../../hooks/useGridColumns';
import { cn } from '../../lib/cn';

interface DataGridProps<T> {
  columns: ColumnDef<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  selectedId?: string | null;
  onRowClick: (row: T) => void;
  sortCol: string | null;
  sortDir: 'asc' | 'desc' | null;
  onSort: (col: string) => void;
  loading?: boolean;
  emptyMessage?: string;
  /** Rótulo acessível da tabela (cada página descreve seu conteúdo). */
  ariaLabel?: string;
  /** Tema visual: `default` (slate, /consulta) ou `silver` (zinc, /emails). */
  variant?: GridVariant;
  /** Painel de detalhe expandido abaixo da linha selecionada. */
  renderDetail?: (row: T) => ReactNode;
}

type GridVariant = 'default' | 'silver';

/**
 * Classes por tema. Cada valor é uma string literal completa (JIT-safe — o
 * Tailwind não gera CSS para nomes de classe computados/concatenados).
 */
const VARIANT_STYLES = {
  default: {
    header: 'table-header',
    cell: 'table-cell text-slate-600',
    rowHover: 'hover:bg-slate-50/60',
    skeleton: 'bg-slate-100',
    emptyIcon: 'bg-slate-100 text-slate-300',
    emptyText: 'text-slate-400',
    secondCell: 'table-cell-secondary',
    secondSep: 'text-slate-300',
    secondLabel: 'text-slate-400',
    secondValue: 'text-slate-500',
    detailBorder: 'border-slate-100',
  },
  silver: {
    header: 'table-header-silver',
    cell: 'table-cell-silver text-zinc-600',
    rowHover: 'bg-zinc-100 hover:bg-zinc-200/60',
    skeleton: 'bg-zinc-100',
    emptyIcon: 'bg-zinc-100 text-zinc-300',
    emptyText: 'text-zinc-400',
    secondCell: 'table-cell-secondary-silver',
    secondSep: 'text-zinc-300',
    secondLabel: 'text-zinc-400',
    secondValue: 'text-zinc-500',
    detailBorder: 'border-zinc-100',
  },
} as const;

const SKELETON_ROWS = 5;

/** Classe de alinhamento do conteúdo (if/return — sem ternário aninhado). */
function alignClass(align?: 'left' | 'right' | 'center'): string {
  if (align === 'right') return 'text-right';
  if (align === 'center') return 'text-center';
  return '';
}

const hasValue = (v: unknown): boolean => v != null && v !== '';

/**
 * Grid responsivo genérico. Em `lg` mostra todas as colunas (tabela clássica);
 * em `md`/`sm` oculta as marcadas com `hideOn` e desce as `secondLine` para uma
 * sub-linha densa abaixo de cada registro. O painel de detalhe (ao clicar na
 * linha) vem pela prop `renderDetail`. A responsividade reaproveita a mesma regra
 * de `useGridColumns`, aplicada genericamente às `columns` recebidas.
 */
export default function DataGrid<T>({
  columns,
  rows,
  rowKey,
  selectedId,
  onRowClick,
  sortCol,
  sortDir,
  onSort,
  loading = false,
  emptyMessage = 'Nenhum registro encontrado',
  ariaLabel = 'Registros financeiros',
  variant = 'default',
  renderDetail,
}: Readonly<DataGridProps<T>>) {
  const styles = VARIANT_STYLES[variant];
  const breakpoint = useBreakpoint();
  // O `!== 'lg'` estreita o tipo do breakpoint para 'sm' | 'md' (permite includes).
  const hidden = (col: ColumnDef<T>): boolean =>
    breakpoint !== 'lg' && (col.hideOn?.includes(breakpoint) ?? false);
  const visibleColumns = columns.filter((c) => !hidden(c));
  const secondLineColumns = columns.filter((c) => c.secondLine && hidden(c));
  const colSpan = visibleColumns.length || 1;

  const head = (
    <thead>
      <tr>
        {visibleColumns.map((col) => {
          const sortKey = col.sortKey;
          const active = !!sortKey && sortCol === sortKey;
          let SortIcon: LucideIcon = ArrowUpDown;
          let ariaSortVal: 'ascending' | 'descending' | 'none' = 'none';
          let titleVal = `Ordenar por ${col.header} crescente`;
          if (active && sortDir === 'asc') {
            SortIcon = ArrowUp;
            ariaSortVal = 'ascending';
            titleVal = `Ordenar por ${col.header} descendente`;
          } else if (active && sortDir === 'desc') {
            SortIcon = ArrowDown;
            ariaSortVal = 'descending';
            titleVal = `Remover ordenação de ${col.header}`;
          }
          return (
            <th
              key={String(col.key)}
              aria-sort={ariaSortVal}
              title={sortKey ? titleVal : undefined}
              onClick={sortKey ? () => onSort(sortKey) : undefined}
              className={cn(
                styles.header,
                'sticky top-0 z-10 select-none transition-colors',
                alignClass(col.align),
                sortKey && 'cursor-pointer',
                active && 'bg-slate-100',
                !active && sortKey && 'hover:bg-slate-100',
              )}
            >
              <span className="inline-flex items-center gap-1">
                {col.header}
                {sortKey && (
                  <SortIcon size={11} className={active ? 'text-brand' : 'text-slate-300'} />
                )}
              </span>
            </th>
          );
        })}
      </tr>
    </thead>
  );

  let body: ReactNode;
  if (loading && rows.length === 0) {
    // Loading: linhas skeleton pulsando.
    body = Array.from({ length: SKELETON_ROWS }, (_, i) => (
      <tr key={`skeleton-${i}`} className="animate-pulse">
        {visibleColumns.map((col) => (
          <td key={String(col.key)} className={styles.cell}>
            <div className={cn('h-3 rounded', styles.skeleton)} />
          </td>
        ))}
      </tr>
    ));
  } else if (rows.length === 0) {
    // Empty: ícone centralizado.
    body = (
      <tr>
        <td colSpan={colSpan} className="py-12">
          <div className="flex flex-col items-center justify-center text-center gap-3">
            <div className={cn('flex h-14 w-14 items-center justify-center rounded-full', styles.emptyIcon)}>
              <Inbox size={26} />
            </div>
            <p className={cn('text-sm max-w-xs', styles.emptyText)}>{emptyMessage}</p>
          </div>
        </td>
      </tr>
    );
  } else {
    body = rows.map((row) => {
      const key = rowKey(row);
      const isSelected = selectedId != null && key === selectedId;
      const secondLineItems = secondLineColumns.filter((c) => hasValue(row[c.key]));
      return (
        <Fragment key={key}>
          <tr
            onClick={() => onRowClick(row)}
            className={cn(
              'cursor-pointer transition-colors',
              isSelected && 'bg-brand/5 border-l-2 border-brand',
              !isSelected && styles.rowHover,
            )}
          >
            {visibleColumns.map((col) => (
              <td
                key={String(col.key)}
                className={cn(styles.cell, 'text-xs font-mono', alignClass(col.align), col.className)}
              >
                {col.render(row)}
              </td>
            ))}
          </tr>

          {secondLineItems.length > 0 && (
            <tr aria-label="Campos adicionais do registro">
              <td colSpan={colSpan} className={styles.secondCell}>
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  {secondLineItems.map((col, idx) => (
                    <span key={String(col.key)} className="inline-flex items-center gap-1 whitespace-nowrap">
                      {idx > 0 && <span className={styles.secondSep}>·</span>}
                      <span className={styles.secondLabel}>{col.secondLineLabel ?? col.header}:</span>
                      <span className={styles.secondValue}>{col.render(row)}</span>
                    </span>
                  ))}
                </div>
              </td>
            </tr>
          )}

          {isSelected && renderDetail && (
            <tr>
              <td colSpan={colSpan} className={cn('p-0 border-b', styles.detailBorder)}>
                <div className="animate-fade-in-up">{renderDetail(row)}</div>
              </td>
            </tr>
          )}
        </Fragment>
      );
    });
  }

  return (
    <table aria-label={ariaLabel} className="w-full">
      {head}
      <tbody>{body}</tbody>
    </table>
  );
}
