// src/components/molecules/ChartAccountSelect.tsx
// Molecule — seletor de plano de contas com react-select (AsyncSelect): pesquisa
// o cadastro financial_chart_of_account (apenas contas postáveis) na Next API e
// retorna o chart_account_id escolhido. NÃO é creatable (cadastro externo ao app).
import { useCallback, useState } from 'react';
import AsyncSelect from 'react-select/async';
import type { ChartAccount } from '@sheild/shared';
import { listChartAccounts } from '../../services/lookups';

// Mensagem exibida quando o lookup FALHA (API de dados fora, 401/500) — distinta de
// "lista vazia". Evita o engano de "Nenhuma conta encontrada" quando a Next API não respondeu.
const LOAD_ERROR_MSG = 'Não foi possível carregar os planos de contas (API de dados indisponível).';

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
  // Mirror CONTROLADO do `value` (mesma estratégia do CostCenterSelect): sincroniza
  // `selected` com a prop no render, sem useEffect nem remonte por `key` do componente —
  // o que antes zerava o valor em races de timing. Preserva o rótulo quando o id não muda.
  const [selected, setSelected] = useState<ChartAccountOption | null>(
    value == null ? null : { value, label: defaultLabel ?? `#${value}` },
  );
  if (value !== (selected?.value ?? null)) {
    setSelected(value == null ? null : { value, label: defaultLabel ?? `#${value}` });
  }

  const disabled = costCenterId == null;

  // Erro de carregamento (API indisponível) — distingue "falhou" de "lista vazia".
  const [loadError, setLoadError] = useState<string | null>(null);

  // Carrega os planos do centro de custo selecionado (código/descrição). Sem centro,
  // não vai à rede (lista vazia). Em falha, marca o erro e devolve []. Fecha sobre `costCenterId`.
  const loadOptions = useCallback(
    async (input: string): Promise<ChartAccountOption[]> => {
      try {
        const data = await listChartAccounts(costCenterId, input || undefined);
        setLoadError(null);
        return data.map((c) => ({ value: c.chart_account_id, label: chartAccountLabel(c) }));
      } catch {
        setLoadError(LOAD_ERROR_MSG);
        return [];
      }
    },
    [costCenterId],
  );

  return (
    <div>
      <span className="block text-sm font-medium text-gray-700 mb-1">{label}</span>
      <AsyncSelect<ChartAccountOption>
        // Recarrega as opções (defaultOptions) ao trocar o centro de custo — cascata.
        // O `value` é controlado pelo pai, então o item selecionado PERSISTE através
        // deste remonte interno (diferente de remontar o componente inteiro por `key`).
        key={costCenterId ?? 'none'}
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
        noOptionsMessage={() => loadError ?? 'Nenhuma conta encontrada para este centro de custo'}
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
      {(error ?? loadError) && (
        <span className="block mt-1 text-xs text-status-error-fg">{error ?? loadError}</span>
      )}
    </div>
  );
}
