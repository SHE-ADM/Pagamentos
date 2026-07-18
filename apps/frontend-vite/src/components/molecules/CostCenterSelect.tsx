// src/components/molecules/CostCenterSelect.tsx
// Molecule — 2º select da classificação contábil (cascata INVERTIDA Plano → Centro):
// dado o PLANO (descrição) escolhido no ChartAccountSelect, lista os CENTROS DE CUSTO que
// o compõem. Cada opção resolve um `chart_account_id` específico (a linha daquele plano
// naquele centro) e o seu `cost_center_id` — por isso o onChange devolve os dois juntos,
// sempre consistentes. NÃO é creatable (cadastro externo ao app).
import { useCallback, useState } from 'react';
import AsyncSelect from 'react-select/async';
import { listCentersForPlano, type CenterForPlanoOption } from '../../services/lookups';

// Mensagem exibida quando o lookup FALHA (API de dados fora, 401/500) — distinta de
// "lista vazia". Evita o engano de "Nenhum centro encontrado" quando a Next API não respondeu.
const LOAD_ERROR_MSG = 'Não foi possível carregar os centros de custo (API de dados indisponível).';

interface CostCenterOption {
  value: number; // chart_account_id (a linha do plano naquele centro)
  costCenterId: number; // cost_center_id resolvido junto
  label: string;
}

interface CostCenterSelectProps {
  /**
   * Plano de contas (descrição) escolhido (cascata): filtra os centros disponíveis. Quando
   * `null`, o select fica DESABILITADO e vazio — o centro depende do plano.
   */
  planoDescription: string | null;
  /** chart_account_id selecionado (controlado pelo formulário). */
  value: number | null;
  /** Rótulo do centro já selecionado (modo edição) — exibe sem refazer fetch. */
  defaultLabel?: string | null;
  /** Devolve o chart_account_id resolvido E o seu cost_center_id (gravados juntos). */
  onChange: (chartAccountId: number | null, costCenterId: number | null) => void;
  label: string;
  error?: string;
  id?: string;
}

// Monta as opções do centro rotulando pela descrição; nos casos raros de mesma descrição
// de plano repetida no MESMO centro (2 códigos), acrescenta o código para diferenciar.
function buildOptions(rows: CenterForPlanoOption[]): CostCenterOption[] {
  const counts = new Map<number, number>();
  for (const r of rows) counts.set(r.cost_center_id, (counts.get(r.cost_center_id) ?? 0) + 1);
  return rows.map((r) => {
    const base = r.cost_center_description ?? `#${r.cost_center_id}`;
    // Mesmo centro repetido (mesma descrição de plano, 2 códigos) → distingue pelo código.
    const ambiguous = (counts.get(r.cost_center_id) ?? 0) > 1 && r.account_code != null;
    return {
      value: r.chart_account_id,
      costCenterId: r.cost_center_id,
      label: ambiguous ? `${base} — ${r.account_code}` : base,
    };
  });
}

export default function CostCenterSelect({
  planoDescription,
  value,
  defaultLabel,
  onChange,
  label,
  error,
  id,
}: Readonly<CostCenterSelectProps>) {
  // Mirror CONTROLADO do `value` (chart_account_id): sincroniza `selected` com a prop no
  // render, sem useEffect nem remonte por `key` do componente. O costCenterId do item
  // semeado não é usado (só o onChange do usuário o propaga) — o pai já tem o valor atual.
  const [selected, setSelected] = useState<CostCenterOption | null>(
    value == null ? null : { value, costCenterId: 0, label: defaultLabel ?? `#${value}` },
  );
  if (value !== (selected?.value ?? null)) {
    setSelected(value == null ? null : { value, costCenterId: 0, label: defaultLabel ?? `#${value}` });
  }

  const disabled = planoDescription == null;

  // Erro de carregamento (API indisponível) — distingue "falhou" de "lista vazia".
  const [loadError, setLoadError] = useState<string | null>(null);

  // Carrega os centros do plano escolhido. Sem plano, não vai à rede (lista vazia). Em
  // falha, marca o erro e devolve []. Fecha sobre `planoDescription`.
  const loadOptions = useCallback(async (): Promise<CostCenterOption[]> => {
    try {
      const data = await listCentersForPlano(planoDescription);
      setLoadError(null);
      return buildOptions(data);
    } catch {
      setLoadError(LOAD_ERROR_MSG);
      return [];
    }
  }, [planoDescription]);

  return (
    <div>
      <span className="block text-sm font-medium text-gray-700 mb-1">{label}</span>
      <AsyncSelect<CostCenterOption>
        // Recarrega as opções (defaultOptions) ao trocar o plano — cascata. O `value` é
        // controlado pelo pai, então o item selecionado PERSISTE através deste remonte interno.
        key={planoDescription ?? 'none'}
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
          onChange(opt ? opt.value : null, opt ? opt.costCenterId : null);
        }}
        placeholder={disabled ? 'Selecione um plano de contas primeiro' : 'Buscar centro de custo…'}
        loadingMessage={() => 'Buscando…'}
        noOptionsMessage={() => loadError ?? 'Nenhum centro de custo para este plano de contas'}
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
