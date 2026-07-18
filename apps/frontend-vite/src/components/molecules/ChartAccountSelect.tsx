// src/components/molecules/ChartAccountSelect.tsx
// Molecule — 1º select da classificação contábil (cascata INVERTIDA Plano → Centro):
// pesquisa as DESCRIÇÕES distintas de planos de contas postáveis na Next API e retorna a
// descrição escolhida. A mesma descrição ("Serviços Gerais") existe em vários centros de
// custo; a escolha do CENTRO (2º select, CostCenterSelect) é que resolve o chart_account_id.
// NÃO é creatable (cadastro externo ao app).
import { useCallback, useState } from 'react';
import AsyncSelect from 'react-select/async';
import { listPlanoDescriptions } from '../../services/lookups';

// Mensagem exibida quando o lookup FALHA (API de dados fora, 401/500) — distinta de
// "lista vazia". Evita o engano de "Nenhum plano encontrado" quando a Next API não respondeu.
const LOAD_ERROR_MSG = 'Não foi possível carregar os planos de contas (API de dados indisponível).';

interface ChartAccountOption {
  value: string; // account_description
  label: string;
}

interface ChartAccountSelectProps {
  /** account_description selecionada (controlada pelo formulário). */
  value: string | null;
  onChange: (description: string | null) => void;
  label: string;
  error?: string;
  id?: string;
}

export default function ChartAccountSelect({ value, onChange, label, error, id }: Readonly<ChartAccountSelectProps>) {
  // Mirror CONTROLADO do `value` (padrão dos selects do projeto): react-select guarda a
  // opção, mas o pai é a fonte de verdade — sincroniza no render, sem useEffect nem remonte
  // por `key`. Para o plano, value e label são a própria descrição.
  const [selected, setSelected] = useState<ChartAccountOption | null>(
    value == null ? null : { value, label: value },
  );
  if (value !== (selected?.value ?? null)) {
    setSelected(value == null ? null : { value, label: value });
  }

  // Erro de carregamento (API indisponível) — distingue "falhou" de "lista vazia".
  const [loadError, setLoadError] = useState<string | null>(null);

  // Carrega as descrições de planos postáveis (busca por código/descrição). Em falha,
  // marca o erro (mostrado abaixo e no menu) e devolve [] — sem mascarar como "nenhum".
  const loadOptions = useCallback(async (input: string): Promise<ChartAccountOption[]> => {
    try {
      const data = await listPlanoDescriptions(input || undefined);
      setLoadError(null);
      return data.map((c) => ({ value: c.account_description, label: c.account_description }));
    } catch {
      setLoadError(LOAD_ERROR_MSG);
      return [];
    }
  }, []);

  return (
    <div>
      <span className="block text-sm font-medium text-gray-700 mb-1">{label}</span>
      <AsyncSelect<ChartAccountOption>
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
        placeholder="Buscar plano de contas…"
        loadingMessage={() => 'Buscando…'}
        noOptionsMessage={() => loadError ?? 'Nenhum plano de contas encontrado'}
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
