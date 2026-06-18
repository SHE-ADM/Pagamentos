import { useEffect, useRef, useState } from 'react';
import { Columns, ArrowLeftToLine, ArrowRightToLine, Minus } from 'lucide-react';

/** Estado de fixação de uma coluna: borda esquerda, direita ou nenhuma. */
export type PinSide = 'left' | 'right' | false;

/** Descritor de uma coluna no menu de gestão (desacoplado do `table` do TanStack). */
export interface ColumnMenuItem {
  id: string;
  label: string;
  visible: boolean;
  /** Coluna que não pode ser ocultada (ex.: seleção) — checkbox desabilitado. */
  canHide: boolean;
  pin: PinSide;
}

interface ColumnVisibilityMenuProps {
  items: ColumnMenuItem[];
  onToggleVisible: (id: string, visible: boolean) => void;
  onSetPin: (id: string, pin: PinSide) => void;
}

interface PinButtonProps {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}

function PinButton({ active, label, onClick, children }: Readonly<PinButtonProps>) {
  const tone = active
    ? 'bg-brand text-white border-brand'
    : 'bg-white text-slate-400 border-slate-200 hover:bg-slate-50';
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={`flex h-6 w-6 items-center justify-center rounded-sm border transition-colors ${tone}`}
    >
      {children}
    </button>
  );
}

/**
 * Menu (popover) para gerenciar colunas do DataGrid: mostrar/ocultar e fixar
 * (esquerda/nenhuma/direita). Fecha ao clicar fora ou via Escape. O botão expõe
 * `aria-expanded`/`aria-haspopup`; cada controle tem nome acessível.
 */
export default function ColumnVisibilityMenu({
  items,
  onToggleVisible,
  onSetPin,
}: Readonly<ColumnVisibilityMenuProps>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const hiddenCount = items.filter((i) => !i.visible).length;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="btn"
      >
        <Columns size={14} />
        <span>Colunas</span>
        {hiddenCount > 0 && (
          <span className="badge bg-brand/10 text-brand">{hiddenCount} ocultas</span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Gerenciar colunas"
          className="absolute right-0 z-40 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-2 shadow-lg"
        >
          <p className="px-2 py-1 text-xs font-semibold uppercase tracking-widest text-slate-400">
            Colunas
          </p>
          <ul className="max-h-72 overflow-y-auto">
            {items.map((item) => (
              <li key={item.id} className="flex items-center gap-2 rounded-sm px-2 py-1 hover:bg-slate-50">
                <label className="flex flex-1 cursor-pointer items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={item.visible}
                    disabled={!item.canHide}
                    aria-label={`Mostrar coluna ${item.label}`}
                    onChange={(e) => onToggleVisible(item.id, e.target.checked)}
                    className="h-4 w-4 cursor-pointer accent-brand disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <span className="truncate">{item.label}</span>
                </label>
                <div className="flex items-center gap-1">
                  <PinButton
                    active={item.pin === 'left'}
                    label={`Fixar ${item.label} à esquerda`}
                    onClick={() => onSetPin(item.id, item.pin === 'left' ? false : 'left')}
                  >
                    <ArrowLeftToLine size={13} />
                  </PinButton>
                  <PinButton
                    active={item.pin === false}
                    label={`Não fixar ${item.label}`}
                    onClick={() => onSetPin(item.id, false)}
                  >
                    <Minus size={13} />
                  </PinButton>
                  <PinButton
                    active={item.pin === 'right'}
                    label={`Fixar ${item.label} à direita`}
                    onClick={() => onSetPin(item.id, item.pin === 'right' ? false : 'right')}
                  >
                    <ArrowRightToLine size={13} />
                  </PinButton>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
