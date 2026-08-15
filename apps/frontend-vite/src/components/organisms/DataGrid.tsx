import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
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
  type Row,
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
import { useGridPreferences, type GridDensity, type GridDefaults } from '../../hooks/useGridPreferences';
import type { ColumnDef } from '../../hooks/useGridColumns';
import { buildRenderItems, type RenderItem } from './dataGrid.rows';
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
  footerCell,
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
  /**
   * Classe extra por linha (ex.: pintar a linha por status). Aplicada à `<tr>` E a
   * cada `<td>` — assim o tom vence o fundo opaco das células fixadas (pinned), que
   * de outro modo cobririam a cor nas colunas sticky.
   */
  rowClassName?: (row: T) => string | undefined;
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
  /** Rodapé SEMPRE-visível abaixo das células do registro. Retorne null p/ não emitir. */
  renderRowFooter?: (row: T) => ReactNode;
  /** Liga a barra de gestão (ocultar/fixar/reordenar/redimensionar/densidade) + persistência. */
  gridId?: string;
  enableColumnManagement?: boolean;
  /** Liga a coluna de seleção múltipla + barra de ações em lote. */
  enableSelection?: boolean;
  /** Ação da barra de seleção — recebe as linhas selecionadas (ex.: exportar CSV). */
  onExportSelected?: (rows: T[]) => void;
  /** Opções de situação para ação em lote (value = status_id) — select + "Aplicar" na barra. */
  bulkStatusOptions?: readonly { value: number; label: string }[];
  /** Callback disparado ao aplicar situação em lote — linhas selecionadas + o novo status_id. */
  onBulkStatusChange?: (rows: T[], statusId: number) => Promise<void>;
  /**
   * Ações customizadas na barra de seleção (ex.: botão "Reenviar e-mails"). Recebe as
   * linhas selecionadas e uma função para limpar a seleção. Compõe com `bulkStatusOptions`.
   */
  renderSelectionActions?: (rows: T[], clearSelection: () => void) => ReactNode;
  /** Altura máxima do corpo rolável (habilita cabeçalho fixo). px ou string CSS. */
  maxBodyHeight?: number | string;
  /** Liga a virtualização de LINHAS (só renderiza o que está visível). Exige `maxBodyHeight`. */
  enableRowVirtualization?: boolean;
  /** Há mais páginas a carregar (scroll infinito) — habilita o auto-load ao chegar ao fim. */
  hasMore?: boolean;
  /** Uma página adicional está sendo carregada (evita disparos concorrentes de `onLoadMore`). */
  loadingMore?: boolean;
  /** Dispara o carregamento da próxima página quando a rolagem alcança o fim da lista. */
  onLoadMore?: () => void;
  /** Fixação inicial das colunas (semeada na 1ª carga e no "restaurar layout"). */
  defaultPinning?: ColumnPinningState;
  /** Densidade inicial (ex.: `compact` para abrir denso). */
  defaultDensity?: GridDensity;
  /**
   * Renderiza os CONTROLES da toolbar (densidade · colunas · restaurar) num nó fora do grid —
   * em `/consulta`, a célula livre da 1ª coluna da 2ª linha da barra de filtros. Portal, não
   * elevação de estado: o layout do grid vive no `useGridPreferences` daqui, e subi-lo para a
   * página tocaria todas as telas com grid para atender a uma. Ver o contrato dos três
   * valores em `GridToolbar`, incluindo por que `null` (nó ainda não montado) difere de
   * ausente.
   */
  toolbarControlsTarget?: HTMLElement | null;
  /**
   * Renderiza a BARRA DE SELEÇÃO (N selecionadas · situação em lote · exportar · limpar) num
   * nó fora do grid — em `/consulta`, o cabeçalho da página. Com este destino a faixa acima do
   * grid deixa de existir, e com ela os 48px que precisavam ficar reservados só para o grid
   * não saltar ao marcar a primeira linha. Mesmo contrato de três valores.
   */
  toolbarSelectionTarget?: HTMLElement | null;
}

const SKELETON_ROWS = 5;
const SELECT_ID = '__select__';
const DEFAULT_COL_SIZE = 160;

const hasValue = (v: unknown): boolean => v != null && v !== '';

/** Dados pré-computados de uma linha para o render (principal + sub-linha + detalhe). */
interface RowRender<T> {
  key: string;
  original: T;
  row: Row<T>;
  isSelected: boolean;
  mainCells: Cell<T, unknown>[];
  secondLineItems: Cell<T, unknown>[];
  /** Conteúdo do rodapé sempre-visível do registro (null = sem rodapé). */
  footerNode: ReactNode;
}

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
            className={cn(
              'inline-flex flex-1 items-center gap-1',
              meta.align === 'right' ? 'justify-end' : 'text-left',
            )}
          >
            {headerText}
            <SortIcon size={11} className={sortIcon({ active })} />
          </button>
        ) : (
          <span className={cn('flex-1', meta.align === 'right' && 'text-right')}>{headerText}</span>
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
  rowClassName,
  sortCol,
  sortDir,
  onSort,
  loading = false,
  emptyMessage = 'Nenhum registro encontrado',
  ariaLabel = 'Registros financeiros',
  variant = 'default',
  renderDetail,
  renderRowFooter,
  gridId,
  enableColumnManagement = false,
  enableSelection = false,
  onExportSelected,
  bulkStatusOptions,
  onBulkStatusChange,
  renderSelectionActions,
  maxBodyHeight,
  enableRowVirtualization = false,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  defaultPinning,
  defaultDensity,
  toolbarControlsTarget,
  toolbarSelectionTarget,
}: Readonly<DataGridProps<T>>) {
  // `HTMLElement`, não `HTMLDivElement`: o MESMO ref é anexado a um `<div>` ou a um
  // `<section>`, conforme o viewport role ou não (ver `rolavel`, no fim do componente). Com o
  // genérico estreito, uma incompatibilidade aqui degradaria em SILÊNCIO justo o que depende
  // do ref — o `getScrollElement` da virtualização e o `ResizeObserver` do breakpoint.
  const { ref: viewportRef, breakpoint } = useContainerBreakpoint<HTMLElement>();
  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({});
  const [bulkStatus, setBulkStatus] = useState<number | ''>('');
  const [applyingBulk, setApplyingBulk] = useState(false);
  // Altura medida do viewport rolável — 0 sem layout real (jsdom/testes) → desliga a
  // virtualização e renderiza tudo (fallback que mantém os testes verdes).
  const [viewportH, setViewportH] = useState(0);

  const gridDefaults = useMemo<GridDefaults>(
    () => ({ pinning: defaultPinning, density: defaultDensity }),
    [defaultPinning, defaultDensity],
  );
  const columnIds = useMemo(() => columns.map((c) => String(c.key)), [columns]);
  const { prefs, setColumnSizing, setColumnVisibility, setColumnPinning, setColumnOrder, setDensity, reset } =
    useGridPreferences(gridId, columnIds, gridDefaults);

  const managed = enableColumnManagement;
  const density = managed ? prefs.density : 'comfortable';
  const stickyHeader = managed && maxBodyHeight != null;

  // ColumnDef próprio → ColumnDef do TanStack; campos customizados vão em `meta`.
  // Coluna de seleção (quando ligada) é prefixada e tratada à parte (não some, não
  // reordena, não redimensiona; fixada à esquerda).
  const tanstackColumns = useMemo<TanStackColumnDef<T>[]>(() => {
    const dataColumns: TanStackColumnDef<T>[] = columns.map((col) => ({
      id: String(col.key),
      // Colunas sintéticas (derivadas de JOIN) não existem em T → undefined; o
      // accessor só alimenta sort/filter client-side, que não usamos (manualSorting).
      accessorFn: (row) => row[col.key as keyof T],
      header: col.header,
      cell: ({ row }) => col.render(row.original),
      size: col.size ?? DEFAULT_COL_SIZE,
      minSize: col.minSize ?? 56,
      meta: {
        hideOn: col.hideOn,
        secondLine: col.secondLine,
        secondLineLabel: col.secondLineLabel,
        sortKey: col.sortKey,
        align: col.align,
        truncate: col.truncate,
        wrap: col.wrap,
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

  // @tanstack/react-table não é compilável pelo React Compiler (hook de lib de terceiros
  // que retorna objeto não-memoizável) — aviso informativo, fora do nosso controle.
  // eslint-disable-next-line react-hooks/incompatible-library
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
    onColumnOrderChange: setColumnOrder,
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
  const pinClass = (column: Column<T, unknown>, kind: 'header' | 'body', selected = false): string => {
    const pinned = column.getIsPinned();
    return managed && pinned ? pinnedCell({ variant, kind, side: pinned, selected }) : '';
  };
  // Id da 1ª coluna fixada à esquerda (com seleção é SELECT_ID; senão, a fixada pelo
  // usuário) — é a única célula que recebe o acento brand da linha selecionada.
  const firstLeftPinnedId = columnPinning.left?.[0];

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

  // ── Virtualização de linhas (opt-in) ─────────────────────────────────────────
  // Mede a altura do viewport rolável; 0 = sem layout (jsdom/testes) → não virtualiza
  // e renderiza tudo (fallback). Em navegador real, ativa a virtualização.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      setViewportH(entries[0]?.contentRect.height ?? el.clientHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewportRef]);

  // Achata as linhas em itens de render (1 item = 1 <tr>: principal/sub-linha/detalhe),
  // base tanto do caminho virtualizado quanto do plano (fallback).
  const modelRows = table.getRowModel().rows;
  const rowRenders: RowRender<T>[] = modelRows.map((row) => {
    const cells = row.getVisibleCells();
    return {
      key: row.id,
      original: row.original,
      row,
      isSelected: selectedId != null && row.id === selectedId,
      mainCells: cells.filter((c) => !isHidden(colMeta(c.column))),
      secondLineItems: cells.filter(
        (c) => colMeta(c.column).secondLine && isHidden(colMeta(c.column)) && hasValue(c.getValue()),
      ),
      footerNode: renderRowFooter?.(row.original) ?? null,
    };
  });
  const renderItems = buildRenderItems(
    rowRenders.map((rr) => ({
      key: rr.key,
      hasSecondLine: rr.secondLineItems.length > 0,
      hasFooter: rr.footerNode != null,
      isSelected: rr.isSelected,
    })),
    !!renderDetail,
  );

  const rowEstimate = density === 'compact' ? 33 : 41;
  const rowVirtualizer = useVirtualizer({
    count: renderItems.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: (index) => {
      const kind = renderItems[index]?.kind;
      if (kind === 'detail') return 320;
      if (kind === 'second') return 28;
      if (kind === 'footer') return 30;
      return rowEstimate;
    },
    overscan: 10,
    // Roda o callback do ResizeObserver dentro de um rAF — reduz as notificações
    // de resize descartadas pelo navegador em "ResizeObserver loop" (o callback
    // dispara re-render, que muda o layout), uma das origens do scrollRect defasado.
    useAnimationFrameWithResizeObserver: true,
  });

  const effectiveVirtualize =
    enableRowVirtualization && maxBodyHeight != null && viewportH > 0 && renderItems.length > 0;

  // Auto-recuperação da virtualização. O @tanstack/react-virtual cacheia a altura
  // do viewport (`scrollRect`) via ResizeObserver. Quando a aba fica em segundo plano
  // (inatividade) o navegador pode descartar as notificações de resize — ao voltar,
  // o `scrollRect` segue defasado (pequeno) e a janela virtual encolhe, "sumindo"
  // com as linhas e deixando o corpo em branco. Ao reganhar foco/visibilidade (ou
  // num resize de janela), re-medimos o viewport real e, SÓ se divergir do cache,
  // reinjetamos no virtualizer e forçamos a remedição — restaurando a janela correta.
  const healVirtualizer = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const height = Math.round(rect.height);
    if (height <= 0) return; // sem layout real — não sobrescrever um valor bom
    const cached = rowVirtualizer.scrollRect?.height ?? 0;
    if (Math.abs(cached - height) <= 1) return; // já em sincronia — nada a fazer
    rowVirtualizer.scrollRect = { width: Math.round(rect.width), height };
    rowVirtualizer.measure();
  }, [rowVirtualizer, viewportRef]);

  useEffect(() => {
    if (!effectiveVirtualize) return;
    let raf = 0;
    const schedule = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(healVirtualizer);
    };
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') schedule();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', schedule);
    window.addEventListener('pageshow', schedule);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', schedule);
      window.removeEventListener('pageshow', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [effectiveVirtualize, healVirtualizer]);

  // Scroll infinito: ao alcançar o fim da lista virtual, pede a próxima página.
  const virtualItems = rowVirtualizer.getVirtualItems();
  const lastVirtualIndex = virtualItems.length ? virtualItems[virtualItems.length - 1].index : -1;
  useEffect(() => {
    if (!effectiveVirtualize || !hasMore || loadingMore || !onLoadMore) return;
    if (lastVirtualIndex >= renderItems.length - 1) onLoadMore();
  }, [effectiveVirtualize, hasMore, loadingMore, onLoadMore, lastVirtualIndex, renderItems.length]);

  // ── Render de cada item (tr) — reutilizado pelo caminho virtual e pelo plano ──
  type MeasureRef = ((node: Element | null) => void) | undefined;

  const renderBodyRowTr = (rr: RowRender<T>, itemKey: string, dataIndex: number | undefined, measureRef: MeasureRef): ReactNode => {
    // Tom por linha (ex.: cancelado). Aplicado à <tr> e a cada <td> para vencer o
    // fundo opaco das células fixadas (twMerge: última classe de bg prevalece).
    const tint = rowClassName?.(rr.original);
    return (
    <tr
      key={itemKey}
      data-index={dataIndex}
      ref={measureRef}
      onClick={() => onRowClick(rr.original)}
      className={cn(bodyRow({ variant, selected: rr.isSelected }), tint)}
    >
      {rr.mainCells.map((cell) => {
        const column = cell.column;
        const m = colMeta(column);
        const accent = rr.isSelected && column.id === firstLeftPinnedId;
        const cls = cn(
          bodyCell({ variant, align: m.align ?? 'left', dense: column.id !== SELECT_ID, density, wrap: !!m.wrap }),
          managed && m.truncate && 'max-w-56',
          m.className,
          pinClass(column, 'body', accent),
          tint,
        );
        if (column.id === SELECT_ID) {
          return (
            <td key={cell.id} style={cellStyle(column)} className={cls}>
              <SelectCheckbox
                checked={rr.row.getIsSelected()}
                onToggle={(v) => rr.row.toggleSelected(v)}
                ariaLabel={`Selecionar linha ${rr.key}`}
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
    );
  };

  const renderSecondLineTr = (rr: RowRender<T>, itemKey: string, dataIndex: number | undefined, measureRef: MeasureRef): ReactNode => (
    <tr key={itemKey} data-index={dataIndex} ref={measureRef} aria-label="Campos adicionais do registro">
      <td colSpan={colSpan} className={secondCell({ variant })}>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          {rr.secondLineItems.map((cell, idx) => {
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
  );

  const renderDetailRowTr = (rr: RowRender<T>, itemKey: string, dataIndex: number | undefined, measureRef: MeasureRef): ReactNode => (
    <tr key={itemKey} data-index={dataIndex} ref={measureRef}>
      <td colSpan={colSpan} className={detailCell({ variant })}>
        <div className="animate-fade-in-up">{renderDetail?.(rr.original)}</div>
      </td>
    </tr>
  );

  const renderFooterTr = (rr: RowRender<T>, itemKey: string, dataIndex: number | undefined, measureRef: MeasureRef): ReactNode => (
    <tr key={itemKey} data-index={dataIndex} ref={measureRef} aria-label="Informação adicional do registro">
      <td colSpan={colSpan} className={footerCell({ variant })}>
        <div className="animate-fade-in-up">{rr.footerNode}</div>
      </td>
    </tr>
  );

  const renderOneItem = (item: RenderItem, dataIndex?: number): ReactNode => {
    const rr = rowRenders[item.rowIndex];
    const measureRef: MeasureRef = dataIndex != null ? rowVirtualizer.measureElement : undefined;
    if (item.kind === 'second') return renderSecondLineTr(rr, item.key, dataIndex, measureRef);
    if (item.kind === 'footer') return renderFooterTr(rr, item.key, dataIndex, measureRef);
    if (item.kind === 'detail') return renderDetailRowTr(rr, item.key, dataIndex, measureRef);
    return renderBodyRowTr(rr, item.key, dataIndex, measureRef);
  };

  // ── Corpo ───────────────────────────────────────────────────────────────────
  const spacerStyle = (height: number): CSSProperties => ({ height, padding: 0, borderWidth: 0 });
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
  } else if (effectiveVirtualize) {
    // Janela virtual: linhas em fluxo normal entre dois <tr> espaçadores (preserva
    // table-fixed, larguras, fixação sticky e o cabeçalho fixo).
    const padTop = virtualItems.length ? virtualItems[0].start : 0;
    const padBottom = virtualItems.length
      ? rowVirtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end
      : 0;
    body = (
      <>
        {padTop > 0 && (
          <tr aria-hidden="true">
            <td colSpan={colSpan} style={spacerStyle(padTop)} />
          </tr>
        )}
        {virtualItems.map((vi) => renderOneItem(renderItems[vi.index], vi.index))}
        {padBottom > 0 && (
          <tr aria-hidden="true">
            <td colSpan={colSpan} style={spacerStyle(padBottom)} />
          </tr>
        )}
      </>
    );
  } else {
    body = renderItems.map((item) => renderOneItem(item));
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

  // 🔴 Região rolável PRECISA de acesso por teclado (WCAG 2.1.1 / axe
  // `scrollable-region-focusable`). Com `maxBodyHeight` o viewport rola de fato, e a regra
  // aceita duas saídas: ter conteúdo focável DENTRO, ou ser focável ele mesmo.
  //
  // A primeira saída não é garantida aqui e falhar nela é SILENCIOSO: em `/consulta` e
  // `/emails` há checkbox de seleção e cabeçalho ordenável, então a região passava "de
  // carona" no conteúdo; no `ExpenseDetailModal` não há NADA focável (as linhas do detalhe
  // não são selecionáveis e as colunas não são ordenáveis, e no modo não-gerenciado o `<th>`
  // é `<th onClick>`, não `<button>`) — quem navega por teclado não conseguia rolar a lista
  // de contas do drill-down. Violação `serious` pega pela camada de a11y em NAVEGADOR
  // (2026-08-15), no primeiro run em que aquele `<dialog>` foi escaneado; o jsdom não a vê.
  //
  // Por isso a saída escolhida é a SEGUNDA, e sem opt-in: quem tem `maxBodyHeight` é focável
  // e nomeado, ponto. Uma prop opcional reintroduziria exatamente o modo de falha acima — o
  // próximo grid sem conteúdo focável nasceria quebrado e ninguém notaria.
  //
  // `<section>` + `aria-label`, não `<div role="region">`: o papel `region` é implícito e o
  // `role=` explícito dispara o S6819 do SonarCloud. Sem `maxBodyHeight` não há rolagem
  // vertical, então nada muda para os grids que não a usam (segue `<div>`, sem tab stop novo).
  // Um ÚNICO elemento, com os atributos condicionados — não dois ramos `<section>`/`<div>`:
  // o mesmo `viewportRef` não tipa nos dois (`RefObject<HTMLElement>` não é atribuível a
  // `Ref<HTMLDivElement>` e vice-versa), e duplicar o ref seria pior. `<section>` SEM nome
  // acessível tem papel `generic` — idêntico ao `<div>` na árvore de acessibilidade —, então
  // os grids sem `maxBodyHeight` não ganham landmark nem tab stop.
  const rolavel = maxBodyHeight != null;
  const grid = (
    <section
      ref={viewportRef}
      className={viewportClass}
      style={viewportStyle}
      aria-label={rolavel ? ariaLabel : undefined}
      tabIndex={rolavel ? 0 : undefined}
    >
      <table aria-label={ariaLabel} className={tableClass} style={tableStyle}>
        {head}
        <tbody>{body}</tbody>
      </table>
    </section>
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
          // Repassado sempre: `undefined` (página que não pediu o slot) preserva o
          // comportamento inline, e é exatamente o que o contrato da prop distingue de `null`.
          controlsPortalTarget={toolbarControlsTarget}
          selectionPortalTarget={toolbarSelectionTarget}
          selectedCount={enableSelection ? selectedRows.length : 0}
          onExportSelected={
            enableSelection && onExportSelected
              ? () => onExportSelected(selectedRows.map((r) => r.original))
              : undefined
          }
          onClearSelection={enableSelection ? () => table.resetRowSelection() : undefined}
          selectionActions={
            enableSelection && (renderSelectionActions || (bulkStatusOptions && onBulkStatusChange)) ? (
              <>
                {bulkStatusOptions && onBulkStatusChange && (
                  <>
                    <select
                      value={bulkStatus === '' ? '' : String(bulkStatus)}
                      onChange={(e) => setBulkStatus(e.target.value ? Number(e.target.value) : '')}
                      aria-label="Selecionar nova situação"
                      className="h-7 rounded-sm border border-brand/30 bg-white px-2 text-xs text-slate-700 focus:outline-hidden focus:ring-1 focus:ring-brand"
                    >
                      <option value="">Alterar situação...</option>
                      {bulkStatusOptions.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={bulkStatus === '' || applyingBulk}
                      onClick={async () => {
                        if (bulkStatus === '') return;
                        // Trava durante o await — evita duplo clique disparar dois PATCH.
                        setApplyingBulk(true);
                        try {
                          const rows = selectedRows.map((r) => r.original);
                          await onBulkStatusChange(rows, bulkStatus);
                          setBulkStatus('');
                          table.resetRowSelection();
                        } finally {
                          setApplyingBulk(false);
                        }
                      }}
                      className="btn btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Aplicar
                    </button>
                  </>
                )}
                {renderSelectionActions?.(selectedRows.map((r) => r.original), () => table.resetRowSelection())}
              </>
            ) : undefined
          }
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
