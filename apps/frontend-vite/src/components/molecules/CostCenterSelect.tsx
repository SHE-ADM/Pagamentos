// src/components/molecules/CostCenterSelect.tsx
// Molecule — seletor de centro de custo com react-select (AsyncSelect): pesquisa
// o cadastro financial_cost_center na Next API e retorna o cost_center_id
// escolhido. Diferente do SupplierSelect, NÃO é creatable (cadastro externo ao app).
import { useCallback, useState } from 'react';
import AsyncSelect from 'react-select/async';
import type { CostCenter } from '@sheild/shared';
import { listCostCenters } from '../../services/lookups';

// Mensagem exibida quando o lookup FALHA (API de dados fora, 401/500) — distinta de
// "lista vazia". Evita o engano de "Nenhum centro de custo encontrado" quando, na
// verdade, a Next API (:3000) não respondeu.
const LOAD_ERROR_MSG = 'Não foi possível carregar os centros de custo (API de dados indisponível).';

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

export default function CostCenterSelect({ value, defaultLabel, onChange, label, error, id }: Readonly<CostCenterSelectProps>) {
  // Mirror CONTROLADO do `value`: react-select guarda a opção selecionada, mas o pai é
  // a fonte de verdade. Sincronizamos `selected` com a prop DURANTE O RENDER (padrão
  // React "ajustar estado ao mudar prop") — sem useEffect e sem o antigo hack de remontar
  // o componente por `key`, que zerava o valor em races de timing (cadastro/edição de
  // contas). Quando o id não muda, preserva o rótulo já conhecido (ex.: escolha do usuário).
  const [selected, setSelected] = useState<CostCenterOption | null>(
    value == null ? null : { value, label: defaultLabel ?? `#${value}` },
  );
  if (value !== (selected?.value ?? null)) {
    setSelected(value == null ? null : { value, label: defaultLabel ?? `#${value}` });
  }

  // Erro de carregamento (API indisponível) — distingue "falhou" de "lista vazia".
  const [loadError, setLoadError] = useState<string | null>(null);

  // Carrega opções pela busca textual (código/descrição) na Next API. Em falha, marca
  // o erro (mostrado abaixo e no menu) e devolve [] — sem mascarar como "nenhum encontrado".
  const loadOptions = useCallback(async (input: string): Promise<CostCenterOption[]> => {
    try {
      const data = await listCostCenters(input || undefined);
      setLoadError(null);
      return data.map((c) => ({ value: c.cost_center_id, label: costCenterLabel(c) }));
    } catch {
      setLoadError(LOAD_ERROR_MSG);
      return [];
    }
  }, []);

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
        noOptionsMessage={() => loadError ?? 'Nenhum centro de custo encontrado'}
        classNamePrefix="rs"
        classNames={{
          control: () => 'min-h-[38px] rounded-lg border border-slate-200 bg-white text-sm',
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
