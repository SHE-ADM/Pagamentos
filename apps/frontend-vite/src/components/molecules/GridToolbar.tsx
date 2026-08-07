import { type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { RotateCcw, Download, X } from 'lucide-react';
import ColumnVisibilityMenu, { type ColumnMenuItem, type PinSide } from './ColumnVisibilityMenu';
import type { GridDensity } from '../../hooks/useGridPreferences';

interface GridToolbarProps {
  columnItems: ColumnMenuItem[];
  onToggleVisible: (id: string, visible: boolean) => void;
  onSetPin: (id: string, pin: PinSide) => void;
  onResetLayout: () => void;
  density: GridDensity;
  onDensityChange: (density: GridDensity) => void;
  /** Seleção (opcional) — barra de ações em lote some quando 0 linhas selecionadas. */
  selectedCount?: number;
  onExportSelected?: () => void;
  onClearSelection?: () => void;
  /** Ações extras renderizadas dentro da barra de seleção, ao lado do botão de exportar. */
  selectionActions?: ReactNode;
  /**
   * Onde renderizar o bloco de CONTROLES (densidade · colunas · restaurar). Portal, e não
   * elevação de estado, porque o estado de layout vive no `useGridPreferences` do DataGrid:
   * subi-lo para a página tocaria todas as telas com grid para atender a uma.
   *
   * Três valores, com semânticas distintas:
   * - **ausente** (`undefined`) — inline, acima do grid. É o padrão e o que todas as outras
   *   telas usam.
   * - **elemento** — os controles saem para lá.
   * - **`null`** — portal pedido, nó de destino ainda não montado: não renderiza os controles
   *   neste frame. É o que evita o flash de eles aparecerem acima do grid e pularem para o
   *   slot no render seguinte, já que o callback ref do destino só resolve depois do primeiro
   *   render da página.
   */
  controlsPortalTarget?: HTMLElement | null;
  /**
   * Onde renderizar a BARRA DE SELEÇÃO (N selecionadas · ações em lote · exportar · limpar).
   * Mesmo contrato de três valores de `controlsPortalTarget`.
   *
   * 🔴 Enquanto ela mora acima do grid, a faixa precisa ter a altura RESERVADA mesmo vazia,
   * senão marcar a primeira linha empurra o grid ~48px para baixo sob o ponteiro. Reservar
   * custa 48px de espaço permanente — que é altura de grid perdida em toda sessão, para
   * proteger um único clique.
   *
   * Levar a barra para um destino que JÁ TEM altura própria (o cabeçalho da página, cujos
   * botões impõem ~46px) resolve os dois lados: nada é reservado acima do grid e nada salta
   * quando a barra aparece. Por isso, **com este portal a faixa não é emitida** — reservar
   * altura para um conteúdo que vai renderizar noutro lugar seria espaço morto.
   */
  selectionPortalTarget?: HTMLElement | null;
}

interface DensityButtonProps {
  active: boolean;
  label: string;
  onClick: () => void;
}

function DensityButton({ active, label, onClick }: Readonly<DensityButtonProps>) {
  const tone = active
    ? 'bg-brand-dark text-white border-brand-dark'
    : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50';
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`px-2.5 py-1 text-xs font-medium border transition-colors first:rounded-l-lg last:rounded-r-lg -ml-px first:ml-0 ${tone}`}
    >
      {label}
    </button>
  );
}

/**
 * Barra de ferramentas acima do DataGrid: gestão de colunas (mostrar/ocultar + fixar),
 * densidade, restaurar layout e — quando há seleção — ações em lote (exportar/limpar).
 * É apresentacional: recebe estado e callbacks; quem gerencia o estado é o DataGrid.
 */
export default function GridToolbar({
  columnItems,
  onToggleVisible,
  onSetPin,
  onResetLayout,
  density,
  onDensityChange,
  selectedCount = 0,
  onExportSelected,
  onClearSelection,
  selectionActions,
  controlsPortalTarget,
  selectionPortalTarget,
}: Readonly<GridToolbarProps>) {
  const hasSelection = selectedCount > 0;
  // `undefined` = prop ausente = sem portal. Distinto de `null` (portal pedido, nó ainda
  // não montado) — ver o contrato dos três valores na declaração das props.
  const usesControlsPortal = controlsPortalTarget !== undefined;
  const usesSelectionPortal = selectionPortalTarget !== undefined;

  const controls = (
    // `flex-wrap` porque no modo portal a célula de destino pode ser mais estreita que a
    // soma dos botões: quebrar a linha é degradação aceitável, sobrepor a coluna vizinha não.
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center" role="group" aria-label="Densidade das linhas">
        <DensityButton
          active={density === 'comfortable'}
          label="Confortável"
          onClick={() => onDensityChange('comfortable')}
        />
        <DensityButton
          active={density === 'compact'}
          label="Compacto"
          onClick={() => onDensityChange('compact')}
        />
      </div>
      <ColumnVisibilityMenu
        items={columnItems}
        onToggleVisible={onToggleVisible}
        onSetPin={onSetPin}
      />
      <button type="button" onClick={onResetLayout} className="btn" title="Restaurar layout padrão">
        <RotateCcw size={14} /> Restaurar
      </button>
    </div>
  );

  // Barra de seleção — só existe quando há linhas marcadas.
  //
  // O padding vertical depende de onde ela vai morar, e o número não é arbitrário: o item
  // mais alto dela é um `.btn` (34px). Inline, sobre a faixa de 48px, `py-1.5` a deixa em
  // 46px e sobra folga. No cabeçalho da página, o bloco do título mede 38px — então `py-0.5`
  // a deixa em exatos 38px e a barra entra sem alterar a altura da linha. Com `py-1.5` ali,
  // ela mediria 46px e o cabeçalho cresceria 8px ao marcar a primeira conta, que é
  // justamente o salto que mover a barra para lá existe para eliminar.
  const selection =
    hasSelection && (onExportSelected || selectionActions) ? (
      <div
        className={`flex items-center gap-2 rounded-lg bg-brand/5 px-3 ${usesSelectionPortal ? 'py-0.5' : 'py-1.5'}`}
      >
        {/* `whitespace-nowrap`: no cabeçalho da página a barra divide a linha com o título e
            os botões globais, e em tela estreita "3 selecionadas" quebraria em duas linhas —
            crescendo a altura do cabeçalho e empurrando o grid. */}
        <span className="whitespace-nowrap text-xs font-medium text-brand">
          {selectedCount} selecionada{selectedCount > 1 ? 's' : ''}
        </span>
        {selectionActions}
        {onExportSelected && (
          <button type="button" onClick={onExportSelected} className="btn btn-primary">
            <Download size={14} /> Exportar selecionadas
          </button>
        )}
        {onClearSelection && (
          <button
            type="button"
            aria-label="Limpar seleção"
            onClick={onClearSelection}
            className="flex h-6 w-6 items-center justify-center rounded-sm text-brand hover:bg-brand/10"
          >
            <X size={14} />
          </button>
        )}
      </div>
    ) : null;

  // Padrão (nenhum portal): controles à esquerda, seleção à direita, acima do grid.
  if (!usesControlsPortal && !usesSelectionPortal) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 py-2">
        {controls}
        {selection}
      </div>
    );
  }

  // Ao menos um dos dois saiu por portal. Cada bloco é resolvido de forma independente:
  // quem tem portal vai para o destino (ou não renderiza, se o nó ainda não montou); quem
  // não tem mantém a própria faixa acima do grid, com o comportamento de sempre.
  //
  // 🔴 A faixa da SELEÇÃO só reserva altura (`min-h-12` ≈ 48px, o que a barra ocupa: `.btn`
  // de ~34px + folga) quando a barra de fato vive ali. Sem a reserva, marcar a primeira
  // linha empurraria o grid para baixo sob o ponteiro — quem seleciona várias contas em
  // sequência para baixa em lote clicaria na linha errada. Com `selectionPortalTarget` a
  // barra renderiza noutro lugar, então não há o que reservar: os 48px voltam a ser grid.
  //
  // Sem `py-*` na faixa: o padding somaria à altura reservada e devolveria espaço morto —
  // o `min-h` já lhe dá exatamente a altura de que a barra precisa.
  return (
    <>
      {usesControlsPortal ? (
        controlsPortalTarget && createPortal(controls, controlsPortalTarget)
      ) : (
        <div className="flex flex-wrap items-center gap-2 py-2">{controls}</div>
      )}
      {usesSelectionPortal ? (
        selectionPortalTarget && createPortal(selection, selectionPortalTarget)
      ) : (
        <div className="flex min-h-12 flex-wrap items-center justify-end gap-2">{selection}</div>
      )}
    </>
  );
}
