// src/components/molecules/CostCenterSelect.tsx
// Molecule — seletor de centro de custo com react-select (AsyncSelect): pesquisa
// o cadastro financial_cost_center na Next API e retorna o cost_center_id
// escolhido. Diferente do SupplierSelect, NÃO é creatable (cadastro externo ao app).
import { useState } from 'react';
import AsyncSelect from 'react-select/async';
import type { CostCenter } from '@sheild/shared';
import { listCostCenters } from '../../services/lookups';

interface CostCenterOption {
  value: number; // cost_center_id
  label: string;
}

interface CostCenterSelectProps {
  /** cost_center_id selecionado (controlado pelo formulário). */
  value: number | null;
  /** Rótulo já selecionado (modo edição) — exibe sem refazer fetch. */
  defaultLabel?: string | null;
  onChange: (id: number | null) => void;
  label: string;
  error?: string;
  id?: string;
}

// Exibe apenas a descrição; fallback para código e, por fim, o id.
const costCenterLabel = (c: CostCenter): string =>
  c.cost_center_description ?? c.cost_center_code ?? `#${c.cost_center_id}`;

// Carrega opções pela busca textual (código/descrição) na Next API.
async function loadOptions(input: string): Promise<CostCenterOption[]> {
  const data = await listCostCenters(input || undefined);
  return data.map((c) => ({ value: c.cost_center_id, label: costCenterLabel(c) }));
}

export default function CostCenterSelect({ value, defaultLabel, onChange, label, error, id }: Readonly<CostCenterSelectProps>) {
  const [selected, setSelected] = useState<CostCenterOption | null>(
    value == null ? null : { value, label: defaultLabel ?? `#${value}` },
  );

  return (
    <div>
      <span className="block text-sm font-medium text-gray-700 mb-1">{label}</span>
      <AsyncSelect<CostCenterOption>
        inputId={id}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        value={selected}
        isClearable
        cacheOptions
        defaultOptions
        loadOptions={loadOptions}
        onChange={(opt) => {
          setSelected(opt);
          onChange(opt ? opt.value : null);
        }}
        placeholder="Buscar centro de custo…"
        loadingMessage={() => 'Buscando…'}
        noOptionsMessage={() => 'Nenhum centro de custo encontrado'}
        classNamePrefix="rs"
        classNames={{
          control: () => 'min-h-[38px] rounded-lg border border-slate-200 bg-white text-sm',
          menu: () => 'rounded-lg border border-slate-200 bg-white shadow-lg text-sm z-20',
          option: ({ isFocused }) => (isFocused ? 'bg-brand/10 px-3 py-2' : 'px-3 py-2'),
        }}
      />
      {error && <span className="block mt-1 text-xs text-status-error-fg">{error}</span>}
    </div>
  );
}
