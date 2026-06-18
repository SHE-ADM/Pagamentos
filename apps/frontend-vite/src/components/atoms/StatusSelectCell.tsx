import { useState, useRef, useEffect } from 'react';
import { Pencil } from 'lucide-react';
import StatusBadge from '../StatusBadge';
import { cn } from '../../lib/cn';

export interface StatusOption {
  value: string;          // status_name no banco
  label: string;          // status_short_name ou valor capitalizado
}

interface Props {
  rowId: number;
  value: string;
  options: Readonly<StatusOption[]>;
  onSave: (rowId: number, newStatus: string) => Promise<void>;
}

/**
 * Célula editável de status para o DataGrid de /consulta.
 *
 * View mode: StatusBadge + ícone de lápis (hover) → indica editabilidade.
 * Edit mode: <select> nativo estilizado com os valores da tabela `status`.
 *
 * Padrão idêntico ao CheckToggle: estado local otimista, revert em erro,
 * stopPropagation para não disparar onRowClick do DataGrid.
 */
export default function StatusSelectCell({ rowId, value, options, onSave }: Readonly<Props>) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [current, setCurrent] = useState(value);
  const [lastValue, setLastValue] = useState(value);
  const selectRef = useRef<HTMLSelectElement>(null);

  // Sincroniza com o valor do pai (reload completo ou filtro novo) ajustando o estado
  // DURANTE O RENDER quando `value` muda e não estamos editando/salvando — padrão
  // "you might not need an effect" (compiler-friendly; sem setState dentro de effect).
  if (value !== lastValue && !editing && !saving) {
    setLastValue(value);
    setCurrent(value);
  }

  // Foca o select assim que o modo de edição abre.
  useEffect(() => {
    if (editing) selectRef.current?.focus();
  }, [editing]);

  const handleButtonClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // impede onRowClick do DataGrid
    if (!saving) setEditing(true);
  };

  const handleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value;
    setEditing(false);
    if (next === current) return; // sem mudança — não chama a API
    const prev = current;
    setCurrent(next); // update otimista
    setSaving(true);
    try {
      await onSave(rowId, next);
    } catch {
      setCurrent(prev); // reverte em caso de erro
    } finally {
      setSaving(false);
    }
  };

  const stopProp = (e: React.MouseEvent) => e.stopPropagation();

  if (editing) {
    return (
      <select
        ref={selectRef}
        defaultValue={current}
        onChange={handleChange}
        onBlur={() => setEditing(false)}
        onClick={stopProp}
        aria-label="Alterar situação"
        className={cn(
          'w-full rounded-sm border border-brand/40 bg-white',
          'px-2 py-0.5 text-xs text-slate-700 shadow-xs',
          'focus:outline-hidden focus:ring-1 focus:ring-brand',
        )}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <button
      type="button"
      disabled={saving}
      onClick={handleButtonClick}
      title="Clique para alterar a situação"
      aria-label={`Situação: ${current}. Clique para alterar.`}
      className={cn(
        'group flex items-center gap-1.5 rounded-sm px-1 -mx-1',
        'transition-colors hover:bg-slate-100',
        saving ? 'cursor-wait opacity-60' : 'cursor-pointer',
      )}
    >
      <StatusBadge value={current} />
      {saving ? (
        <span
          aria-label="Salvando…"
          className="h-3 w-3 shrink-0 animate-spin rounded-full border border-slate-400 border-t-transparent"
        />
      ) : (
        <Pencil
          size={10}
          aria-hidden="true"
          className="shrink-0 text-slate-400 opacity-0 transition-opacity group-hover:opacity-100"
        />
      )}
    </button>
  );
}
