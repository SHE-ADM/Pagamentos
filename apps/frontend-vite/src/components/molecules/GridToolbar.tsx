import { type ReactNode } from 'react';
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
}

interface DensityButtonProps {
  active: boolean;
  label: string;
  onClick: () => void;
}

function DensityButton({ active, label, onClick }: Readonly<DensityButtonProps>) {
  const tone = active
    ? 'bg-brand text-white border-brand'
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
}: Readonly<GridToolbarProps>) {
  const hasSelection = selectedCount > 0;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2">
      {/* Controles sempre à esquerda (densidade, colunas, restaurar). */}
      <div className="flex items-center gap-2">
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

      {/* Barra de seleção à direita (só quando há linhas selecionadas). */}
      {hasSelection && (onExportSelected || selectionActions) && (
        <div className="flex items-center gap-2 rounded-lg bg-brand/5 px-3 py-1.5">
          <span className="text-xs font-medium text-brand">
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
              className="flex h-6 w-6 items-center justify-center rounded text-brand hover:bg-brand/10"
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
