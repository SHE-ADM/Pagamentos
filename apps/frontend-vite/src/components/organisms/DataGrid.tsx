import { Fragment, type ReactNode } from 'react';
import { Inbox, ArrowUp, ArrowDown, ArrowUpDown, type LucideIcon } from 'lucide-react';
import { useContainerBreakpoint } from '../../hooks/useContainerBreakpoint';
import type { ColumnDef } from '../../hooks/useGridColumns';
import { cn } from '../../lib/cn';
import {
  type GridVariant,
  headerCell,
  sortIcon,
  bodyRow,
  bodyCell,
  skeletonBar,
  emptyIcon,
  emptyText,
  secondCell,
  secondText,
  detailCell,
} from './dataGrid.variants';

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

const SKELETON_ROWS = 5;

const hasValue = (v: unknown): boolean => v != null && v !== '';

/**
 * Grid responsivo genérico ("à prova de mobile"). O breakpoint vem da largura
 * REAL do container (`useContainerBreakpoint` + ResizeObserver), não da janela —
 * então sidebar/paddings são considerados. Em `lg` mostra todas as colunas; em
 * `md`/`sm` oculta as marcadas com `hideOn` e desce as `secondLine` para uma
 * sub-linha densa. Colunas com `truncate` cortam texto longo (com `title`). A
 * `<table>` fica num wrapper `overflow-x-auto` — se ainda assim não couber, rola
 * horizontalmente em vez de cortar. Estilos por tema vêm de `dataGrid.variants.ts`.
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
  const { ref, breakpoint } = useContainerBreakpoint<HTMLDivElement>();
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
              className={headerCell({
                variant,
                align: col.align ?? 'left',
                sortable: !!sortKey,
                active,
              })}
            >
              <span className="inline-flex items-center gap-1">
                {col.header}
                {sortKey && <SortIcon size={11} className={sortIcon({ active })} />}
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
          <td key={String(col.key)} className={bodyCell({ variant })}>
            <div className={skeletonBar({ variant })} />
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
            <div className={emptyIcon({ variant })}>
              <Inbox size={26} />
            </div>
            <p className={emptyText({ variant })}>{emptyMessage}</p>
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
            className={bodyRow({ variant, selected: isSelected })}
          >
            {visibleColumns.map((col) => {
              const value = col.render(row);
              // Truncagem opcional: corta texto longo e expõe o valor no `title`.
              const title = typeof value === 'string' ? value : undefined;
              const content = col.truncate ? (
                <span className="block truncate" title={title}>
                  {value}
                </span>
              ) : (
                value
              );
              return (
                <td
                  key={String(col.key)}
                  className={cn(
                    bodyCell({ variant, align: col.align ?? 'left', dense: true }),
                    col.truncate && 'max-w-[14rem]',
                    col.className,
                  )}
                >
                  {content}
                </td>
              );
            })}
          </tr>

          {secondLineItems.length > 0 && (
            <tr aria-label="Campos adicionais do registro">
              <td colSpan={colSpan} className={secondCell({ variant })}>
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  {secondLineItems.map((col, idx) => (
                    <span key={String(col.key)} className="inline-flex items-center gap-1 whitespace-nowrap">
                      {idx > 0 && <span className={secondText({ variant, tone: 'sep' })}>·</span>}
                      <span className={secondText({ variant, tone: 'label' })}>
                        {col.secondLineLabel ?? col.header}:
                      </span>
                      <span className={secondText({ variant, tone: 'value' })}>{col.render(row)}</span>
                    </span>
                  ))}
                </div>
              </td>
            </tr>
          )}

          {isSelected && renderDetail && (
            <tr>
              <td colSpan={colSpan} className={detailCell({ variant })}>
                <div className="animate-fade-in-up">{renderDetail(row)}</div>
              </td>
            </tr>
          )}
        </Fragment>
      );
    });
  }

  return (
    <div ref={ref} className="overflow-x-auto">
      <table aria-label={ariaLabel} className="w-full">
        {head}
        <tbody>{body}</tbody>
      </table>
    </div>
  );
}
