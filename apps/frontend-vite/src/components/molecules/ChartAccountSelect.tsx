// src/components/molecules/ChartAccountSelect.tsx
// Molecule — seletor de plano de contas com react-select (AsyncSelect): pesquisa
// o cadastro financial_chart_of_account (apenas contas postáveis) na Next API e
// retorna o chart_account_id escolhido. NÃO é creatable (cadastro externo ao app).
import { useState } from 'react';
import AsyncSelect from 'react-select/async';
import type { ChartAccount } from '@sheild/shared';
import { listChartAccounts } from '../../services/lookups';

interface ChartAccountOption {
  value: number; // chart_account_id
  label: string;
}

interface ChartAccountSelectProps {
  /** chart_account_id selecionado (controlado pelo formulário). */
  value: number | null;
  /**
   * Centro de custo selecionado (cascata): filtra os planos disponíveis. Quando `null`,
   * o select fica DESABILITADO e vazio — o plano de contas depende do centro de custo.
   * O pai deve remontar este componente (via `key`) ao trocar o centro.
   */
  costCenterId: number | null;
  /** Rótulo já selecionado (modo edição) — exibe sem refazer fetch. */
  defaultLabel?: string | null;
  onChange: (id: number | null) => void;
  label: string;
  error?: string;
  id?: string;
}

// Exibe apenas a descrição; fallback para código e, por fim, o id.
const chartAccountLabel = (c: ChartAccount): string =>
  c.account_description ?? c.account_code ?? `#${c.chart_account_id}`;

export default function ChartAccountSelect({ value, costCenterId, defaultLabel, onChange, label, error, id }: Readonly<ChartAccountSelectProps>) {
  const [selected, setSelected] = useState<ChartAccountOption | null>(
    value == null ? null : { value, label: defaultLabel ?? `#${value}` },
  );

  const disabled = costCenterId == null;

  // Carrega os planos do centro de custo selecionado (código/descrição). Sem centro,
  // não vai à rede (lista vazia). Fecha sobre `costCenterId` (prop).
  const loadOptions = async (input: string): Promise<ChartAccountOption[]> => {
    const data = await listChartAccounts(costCenterId, input || undefined);
    return data.map((c) => ({ value: c.chart_account_id, label: chartAccountLabel(c) }));
  };

  return (
    <div>
      <span className="block text-sm font-medium text-gray-700 mb-1">{label}</span>
      <AsyncSelect<ChartAccountOption>
        inputId={id}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        value={selected}
        isDisabled={disabled}
        isClearable
        cacheOptions
        defaultOptions
        loadOptions={loadOptions}
        onChange={(opt) => {
          setSelected(opt);
          onChange(opt ? opt.value : null);
        }}
        placeholder={disabled ? 'Selecione um centro de custo primeiro' : 'Buscar plano de contas…'}
        loadingMessage={() => 'Buscando…'}
        noOptionsMessage={() => 'Nenhuma conta encontrada para este centro de custo'}
        classNamePrefix="rs"
        classNames={{
          control: ({ isDisabled }) =>
            isDisabled
              ? 'min-h-[38px] rounded-lg border border-slate-200 bg-slate-50 text-sm cursor-not-allowed'
              : 'min-h-[38px] rounded-lg border border-slate-200 bg-white text-sm',
          menu: () => 'rounded-lg border border-slate-200 bg-white shadow-lg text-sm z-20',
          option: ({ isFocused }) => (isFocused ? 'bg-brand/10 px-3 py-2' : 'px-3 py-2'),
        }}
      />
      {error && <span className="block mt-1 text-xs text-status-error-fg">{error}</span>}
    </div>
  );
}
