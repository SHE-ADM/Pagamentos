import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Inbox, ArrowUp, ArrowDown, ArrowUpDown, GripVertical, type LucideIcon } from 'lucide-react';
import {
  useReactTable,
  getCoreRowModel,
  type ColumnDef as TanStackColumnDef,
  type ColumnMeta,
  type ColumnPinningState,
  type SortingState,
  type Column,
  type Cell,
  type Header,
} from '@tanstack/react-table';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
  arrayMove,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { restrictToHorizontalAxis } from '@dnd-kit/modifiers';
import { CSS } from '@dnd-kit/utilities';
import { useContainerBreakpoint } from '../../hooks/useContainerBreakpoint';
import { useGridPreferences, type GridDensity } from '../../hooks/useGridPreferences';
import type { ColumnDef } from '../../hooks/useGridColumns';
import { cn } from '../../lib/cn';
import GridToolbar from '../molecules/GridToolbar';
import type { ColumnMenuItem, PinSide } from '../molecules/ColumnVisibilityMenu';
import SelectCheckbox from '../atoms/SelectCheckbox';
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
  pinnedCell,
  resizeHandle,
  gripHandle,
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
  /** Liga a barra de gestão (ocultar/fixar/reordenar/redimensionar/densidade) + persistência. */
  gridId?: string;
  enableColumnManagement?: boolean;
  /** Liga a coluna de seleção múltipla + barra de ações em lote. */
  enableSelection?: boolean;
  /** Ação da barra de seleção — recebe as linhas selecionadas (ex.: exportar CSV). */
  onExportSelected?: (rows: T[]) => void;
  /** Altura máxima do corpo rolável (habilita cabeçalho fixo). px ou string CSS. */
  maxBodyHeight?: number | string;
}

const SKELETON_ROWS = 5;
const SELECT_ID = '__select__';
const DEFAULT_COL_SIZE = 160;

const hasValue = (v: unknown): boolean => v != null && v !== '';

/** Acesso tipado ao `meta` customizado da coluna (todos os campos são opcionais). */
const colMeta = <T,>(column: Column<T, unknown>): ColumnMeta<T, unknown> =>
  column.columnDef.meta ?? {};

/** Texto do cabeçalho — sempre uma string no nosso ColumnDef (não um renderer). */
const colHeaderText = <T,>(column: Column<T, unknown>): string => {
  const header = column.columnDef.header;
  return typeof header === 'string' ? header : '';
};

/**
 * Valor renderizado da célula chamando o renderer diretamente (sem `flexRender`).
 * `flexRender` envolveria a função em `createElement`, trocando o valor cru por um
 * elemento React — perderíamos o `string` original necessário ao `title` da truncagem.
 */
const cellValue = <T,>(cell: Cell<T, unknown>): ReactNode => {
  const renderer = cell.column.columnDef.cell;
  if (typeof renderer === 'function') return renderer(cell.getContext()) as ReactNode;
  return renderer ?? null;
};

/** Remove `id` dos dois lados e o fixa no lado pedido (data-only, sem a coluna de seleção). */
const applyPin = (pinning: ColumnPinningState, id: string, side: PinSide): ColumnPinningState => {
  const left = (pinning.left ?? []).filter((x) => x !== id);
  const right = (pinning.right ?? []).filter((x) => x !== id);
  if (side === 'left') left.push(id);
  if (side === 'right') right.push(id);
  return { left, right };
};

/** Estilo de fixação (offset sticky) — calculado pelo TanStack a partir das larguras. */
const pinOffsetStyle = <T,>(column: Column<T, unknown>): CSSProperties => {
  const pinned = column.getIsPinned();
  if (pinned === 'left') return { left: column.getStart('left') };
  if (pinned === 'right') return { right: column.getAfter('right') };
  return {};
};

interface SortableHeaderProps<T> {
  header: Header<T, unknown>;
  variant: GridVariant;
  density: GridDensity;
  sortCol: string | null;
  sortDir: 'asc' | 'desc' | null;
  onSort: (col: string) => void;
  stickyHeader: boolean;
}

/** Cabeçalho do modo gerenciável: arraste (grip), ordenação (clique no rótulo) e resize. */
function SortableHeaderCell<T>({
  header,
  variant,
  density,
  sortCol,
  sortDir,
  onSort,
  stickyHeader,
}: Readonly<SortableHeaderProps<T>>) {
  const column = header.column;
  const meta = colMeta(column);
  const sortKey = meta.sortKey;
  const headerText = colHeaderText(column);
  const active = !!sortKey && sortCol === sortKey;
  const pinned = column.getIsPinned();

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: column.id,
  });

  let SortIcon: LucideIcon = ArrowUpDown;
  let ariaSortVal: 'ascending' | 'descending' | 'none' = 'none';
  let titleVal = `Ordenar por ${headerText} crescente`;
  if (active && sortDir === 'asc') {
    SortIcon = ArrowUp;
    ariaSortVal = 'ascending';
    titleVal = `Ordenar por ${headerText} descendente`;
  } else if (active && sortDir === 'desc') {
    SortIcon = ArrowDown;
    ariaSortVal = 'descending';
    titleVal = `Remover ordenação de ${headerText}`;
  }

  const style: CSSProperties = {
    width: column.getSize(),
    transform: CSS.Translate.toString(transform),
    transition,
    ...pinOffsetStyle(column),
    ...(isDragging ? { zIndex: 50, opacity: 0.85 } : {}),
  };

  return (
    <th
      ref={setNodeRef}
      aria-sort={ariaSortVal}
      style={style}
      className={cn(
        'group/th',
        headerCell({ variant, align: meta.align ?? 'left', sortable: !!sortKey, active, density }),
        stickyHeader && !pinned && 'sticky top-0 z-10',
        stickyHeader && pinned && 'top-0',
        pinned && pinnedCell({ variant, kind: 'header', side: pinned }),
      )}
    >
      <div className="flex items-center gap-1">
        <span
          {...attributes}
          {...listeners}
          aria-label={`Reordenar coluna ${headerText}`}
          className={gripHandle({ variant })}
        >
          <GripVertical size={12} />
        </span>
        {sortKey ? (
          <button
            type="button"
            title={titleVal}
            onClick={() => onSort(sortKey)}
            className="inline-flex flex-1 items-center gap-1 text-left"
          >
            {headerText}
            <SortIcon size={11} className={sortIcon({ active })} />
          </button>
        ) : (
          <span className="flex-1">{headerText}</span>
        )}
      </div>
      {column.getCanResize() && (
        <span
          aria-hidden="true"
          title="Redimensionar coluna"
          onMouseDown={header.getResizeHandler()}
          onTouchStart={header.getResizeHandler()}
          onClick={(e) => e.stopPropagation()}
          className={resizeHandle({ active: column.getIsResizing() })}
        />
      )}
    </th>
  );
}

/**
 * Grid responsivo sobre TanStack Table v8 (headless). O TanStack provê row model
 * (core), header groups e os estados de layout (sizing/pinning/visibility/order/
 * selection); sort, filtro e paginação permanecem **server-side** (`manualSorting`).
 * A VISIBILIDADE responsiva (`hideOn` + `useContainerBreakpoint`) é própria e compõe
 * com a visibilidade escolhida pelo usuário: uma coluna aparece se o usuário não a
 * ocultou E o breakpoint não a escondeu (nesse caso desce para a sub-linha). Com
 * `enableColumnManagement`, liga a `GridToolbar`, larguras fixas (resize), fixação
 * (pin sticky), reordenação por arraste (@dnd-kit) e cabeçalho fixo (quando
 * `maxBodyHeight`). Estilos por tema vêm de `dataGrid.variants.ts`.
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
  gridId,
  enableColumnManagement = false,
  enableSelection = false,
  onExportSelected,
  maxBodyHeight,
}: Readonly<DataGridProps<T>>) {
  const { ref, breakpoint } = useContainerBreakpoint<HTMLDivElement>();
  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({});

  const columnIds = useMemo(() => columns.map((c) => String(c.key)), [columns]);
  const { prefs, setColumnSizing, setColumnVisibility, setColumnPinning, setColumnOrder, setDensity, reset } =
    useGridPreferences(gridId, columnIds);

  const managed = enableColumnManagement;
  const density = managed ? prefs.density : 'comfortable';
  const stickyHeader = managed && maxBodyHeight != null;

  // ColumnDef próprio → ColumnDef do TanStack; campos customizados vão em `meta`.
  // Coluna de seleção (quando ligada) é prefixada e tratada à parte (não some, não
  // reordena, não redimensiona; fixada à esquerda).
  const tanstackColumns = useMemo<TanStackColumnDef<T>[]>(() => {
    const dataColumns: TanStackColumnDef<T>[] = columns.map((col) => ({
      id: String(col.key),
      accessorFn: (row) => row[col.key],
      header: col.header,
      cell: ({ row }) => col.render(row.original),
      size: col.size ?? DEFAULT_COL_SIZE,
      meta: {
        hideOn: col.hideOn,
        secondLine: col.secondLine,
        secondLineLabel: col.secondLineLabel,
        sortKey: col.sortKey,
        align: col.align,
        truncate: col.truncate,
        className: col.className,
      },
    }));
    if (!enableSelection) return dataColumns;
    const selectionColumn: TanStackColumnDef<T> = {
      id: SELECT_ID,
      size: 44,
      enableSorting: false,
      enableHiding: false,
      enableResizing: false,
      meta: { align: 'center' },
    };
    return [selectionColumn, ...dataColumns];
  }, [columns, enableSelection]);

  // Sort externo → estado do TanStack (apenas para consistência; ícones leem sortCol/Dir).
  const sorting = useMemo<SortingState>(() => {
    if (!sortCol || !sortDir) return [];
    const sorted = columns.find((c) => c.sortKey === sortCol);
    return sorted ? [{ id: String(sorted.key), desc: sortDir === 'desc' }] : [];
  }, [columns, sortCol, sortDir]);

  // A coluna de seleção é sempre a primeira e fixada à esquerda — injetada na ordem e
  // na fixação efetivas, mas NUNCA gravada nas preferências (mantém prefs data-only).
  const columnOrder = useMemo(
    () => (enableSelection ? [SELECT_ID, ...prefs.order] : prefs.order),
    [enableSelection, prefs.order],
  );
  const columnPinning = useMemo<ColumnPinningState>(
    () => ({
      left: enableSelection ? [SELECT_ID, ...(prefs.pinning.left ?? [])] : (prefs.pinning.left ?? []),
      right: prefs.pinning.right ?? [],
    }),
    [enableSelection, prefs.pinning],
  );

  const table = useReactTable<T>({
    data: rows,
    columns: tanstackColumns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => rowKey(row),
    manualSorting: true,
    manualPagination: true,
    enableRowSelection: enableSelection,
    columnResizeMode: 'onChange',
    state: {
      sorting,
      columnOrder,
      columnVisibility: prefs.visibility,
      columnSizing: prefs.sizing,
      columnPinning,
      rowSelection,
    },
    onColumnSizingChange: setColumnSizing,
    onRowSelectionChange: setRowSelection,
  });

  // `!== 'lg'` estreita o tipo do breakpoint para 'sm' | 'md' (permite includes).
  const isHidden = (m: ColumnMeta<T, unknown>): boolean =>
    breakpoint !== 'lg' && (m.hideOn?.includes(breakpoint) ?? false);

  // getVisibleLeafColumns() já exclui as ocultas pelo usuário; filtramos as do breakpoint.
  const leafColumns = table.getVisibleLeafColumns();
  const visibleColumns = leafColumns.filter((c) => !isHidden(colMeta(c)));
  const colSpan = visibleColumns.length || 1;

  // Estilo (largura + offset de fixação) das células no modo gerenciável.
  const cellStyle = (column: Column<T, unknown>): CSSProperties | undefined =>
    managed ? { width: column.getSize(), ...pinOffsetStyle(column) } : undefined;
  const pinClass = (column: Column<T, unknown>, kind: 'header' | 'body'): string => {
    const pinned = column.getIsPinned();
    return managed && pinned ? pinnedCell({ variant, kind, side: pinned }) : '';
  };

  // ── Cabeçalho ───────────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setColumnOrder((order) => {
      const from = order.indexOf(String(active.id));
      const to = order.indexOf(String(over.id));
      return from === -1 || to === -1 ? order : arrayMove(order, from, to);
    });
  };

  const renderPlainHeader = (header: Header<T, unknown>): ReactNode => {
    const column = header.column;
    const meta = colMeta(column);
    const sortKey = meta.sortKey;
    const headerText = colHeaderText(column);
    const active = !!sortKey && sortCol === sortKey;
    let SortIcon: LucideIcon = ArrowUpDown;
    let ariaSortVal: 'ascending' | 'descending' | 'none' = 'none';
    let titleVal = `Ordenar por ${headerText} crescente`;
    if (active && sortDir === 'asc') {
      SortIcon = ArrowUp;
      ariaSortVal = 'ascending';
      titleVal = `Ordenar por ${headerText} descendente`;
    } else if (active && sortDir === 'desc') {
      SortIcon = ArrowDown;
      ariaSortVal = 'descending';
      titleVal = `Remover ordenação de ${headerText}`;
    }
    return (
      <th
        key={header.id}
        aria-sort={ariaSortVal}
        title={sortKey ? titleVal : undefined}
        onClick={sortKey ? () => onSort(sortKey) : undefined}
        className={headerCell({ variant, align: meta.align ?? 'left', sortable: !!sortKey, active, density })}
      >
        <span className="inline-flex items-center gap-1">
          {headerText}
          {sortKey && <SortIcon size={11} className={sortIcon({ active })} />}
        </span>
      </th>
    );
  };

  const headerGroup = table.getHeaderGroups()[0];
  const visibleHeaders = headerGroup.headers.filter((h) => !isHidden(colMeta(h.column)));
  const sortableIds = visibleHeaders.map((h) => h.column.id).filter((id) => id !== SELECT_ID);

  const renderSelectHeaderCell = (header: Header<T, unknown>): ReactNode => (
    <th
      key={header.id}
      style={cellStyle(header.column)}
      className={cn(
        headerCell({ variant, align: 'center', density }),
        stickyHeader && 'sticky top-0',
        pinClass(header.column, 'header'),
      )}
    >
      <SelectCheckbox
        checked={table.getIsAllRowsSelected()}
        indeterminate={table.getIsSomeRowsSelected()}
        onToggle={(v) => table.toggleAllRowsSelected(v)}
        ariaLabel="Selecionar todas as linhas"
      />
    </th>
  );

  const head = (
    <thead>
      <tr>
        {managed ? (
          <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
            {visibleHeaders.map((header) =>
              header.column.id === SELECT_ID ? (
                renderSelectHeaderCell(header)
              ) : (
                <SortableHeaderCell
                  key={header.id}
                  header={header}
                  variant={variant}
                  density={density}
                  sortCol={sortCol}
                  sortDir={sortDir}
                  onSort={onSort}
                  stickyHeader={stickyHeader}
                />
              ),
            )}
          </SortableContext>
        ) : (
          visibleHeaders.map((header) => renderPlainHeader(header))
        )}
      </tr>
    </thead>
  );

  // ── Corpo ───────────────────────────────────────────────────────────────────
  let body: ReactNode;
  if (loading && rows.length === 0) {
    body = Array.from({ length: SKELETON_ROWS }, (_, i) => (
      <tr key={`skeleton-${i}`} className="animate-pulse">
        {visibleColumns.map((col) => (
          <td key={col.id} style={cellStyle(col)} className={cn(bodyCell({ variant, density }), pinClass(col, 'body'))}>
            <div className={skeletonBar({ variant })} />
          </td>
        ))}
      </tr>
    ));
  } else if (rows.length === 0) {
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
    body = table.getRowModel().rows.map((row) => {
      const key = row.id;
      const isSelected = selectedId != null && key === selectedId;
      const cells = row.getVisibleCells();
      const mainCells = cells.filter((c) => !isHidden(colMeta(c.column)));
      const secondLineItems = cells.filter(
        (c) => colMeta(c.column).secondLine && isHidden(colMeta(c.column)) && hasValue(c.getValue()),
      );
      return (
        <Fragment key={key}>
          <tr onClick={() => onRowClick(row.original)} className={bodyRow({ variant, selected: isSelected })}>
            {mainCells.map((cell) => {
              const column = cell.column;
              const m = colMeta(column);
              const cls = cn(
                bodyCell({ variant, align: m.align ?? 'left', dense: column.id !== SELECT_ID, density }),
                managed && m.truncate && 'max-w-[14rem]',
                m.className,
                pinClass(column, 'body'),
              );
              if (column.id === SELECT_ID) {
                return (
                  <td key={cell.id} style={cellStyle(column)} className={cls}>
                    <SelectCheckbox
                      checked={row.getIsSelected()}
                      onToggle={(v) => row.toggleSelected(v)}
                      ariaLabel={`Selecionar linha ${key}`}
                    />
                  </td>
                );
              }
              const value = cellValue(cell);
              const title = typeof value === 'string' ? value : undefined;
              const content = m.truncate ? (
                <span className="block truncate" title={title}>
                  {value}
                </span>
              ) : (
                value
              );
              return (
                <td key={cell.id} style={cellStyle(column)} className={cls}>
                  {content}
                </td>
              );
            })}
          </tr>

          {secondLineItems.length > 0 && (
            <tr aria-label="Campos adicionais do registro">
              <td colSpan={colSpan} className={secondCell({ variant })}>
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  {secondLineItems.map((cell, idx) => {
                    const m = colMeta(cell.column);
                    return (
                      <span key={cell.id} className="inline-flex items-center gap-1 whitespace-nowrap">
                        {idx > 0 && <span className={secondText({ variant, tone: 'sep' })}>·</span>}
                        <span className={secondText({ variant, tone: 'label' })}>
                          {m.secondLineLabel ?? colHeaderText(cell.column)}:
                        </span>
                        <span className={secondText({ variant, tone: 'value' })}>{cellValue(cell)}</span>
                      </span>
                    );
                  })}
                </div>
              </td>
            </tr>
          )}

          {isSelected && renderDetail && (
            <tr>
              <td colSpan={colSpan} className={detailCell({ variant })}>
                <div className="animate-fade-in-up">{renderDetail(row.original)}</div>
              </td>
            </tr>
          )}
        </Fragment>
      );
    });
  }

  // ── Toolbar (gestão de colunas + densidade + seleção) ─────────────────────────
  const columnItems: ColumnMenuItem[] = table
    .getAllLeafColumns()
    .filter((c) => c.id !== SELECT_ID)
    .map((c) => ({
      id: c.id,
      label: colHeaderText(c),
      visible: c.getIsVisible(),
      canHide: c.getCanHide(),
      pin: c.getIsPinned(),
    }));
  const selectedRows = table.getSelectedRowModel().rows;

  const viewportClass = managed ? 'overflow-auto' : 'overflow-x-auto';
  const viewportStyle: CSSProperties | undefined =
    maxBodyHeight != null ? { maxHeight: maxBodyHeight } : undefined;
  // `min-w-full` faz a tabela preencher o card quando a soma das colunas é menor que
  // ele (table-fixed distribui o espaço extra entre as colunas); quando excede, a
  // largura real (getTotalSize) prevalece e o viewport rola horizontalmente.
  const tableClass = managed ? 'table-fixed border-collapse min-w-full' : 'w-full';
  const tableStyle: CSSProperties | undefined = managed ? { width: table.getTotalSize() } : undefined;

  const grid = (
    <div ref={ref} className={viewportClass} style={viewportStyle}>
      <table aria-label={ariaLabel} className={tableClass} style={tableStyle}>
        {head}
        <tbody>{body}</tbody>
      </table>
    </div>
  );

  return (
    <div>
      {managed && (
        <GridToolbar
          columnItems={columnItems}
          onToggleVisible={(id, visible) => setColumnVisibility((v) => ({ ...v, [id]: visible }))}
          onSetPin={(id, pin) => setColumnPinning((p) => applyPin(p, id, pin))}
          onResetLayout={reset}
          density={density}
          onDensityChange={setDensity}
          selectedCount={enableSelection ? selectedRows.length : 0}
          onExportSelected={
            enableSelection && onExportSelected
              ? () => onExportSelected(selectedRows.map((r) => r.original))
              : undefined
          }
          onClearSelection={enableSelection ? () => table.resetRowSelection() : undefined}
        />
      )}
      {managed ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToHorizontalAxis]}
          onDragEnd={handleDragEnd}
        >
          {grid}
        </DndContext>
      ) : (
        grid
      )}
    </div>
  );
}
