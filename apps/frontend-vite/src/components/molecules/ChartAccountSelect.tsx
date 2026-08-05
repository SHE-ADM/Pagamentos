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
  /**
   * Apresentação. `'form'` (padrão) = comportamento de sempre, intocado para o ContaForm
   * e o SupplierForm. `'filter'` = uso em BARRA DE FILTRO: sem rótulo em bloco (o
   * placeholder já nomeia o campo e o nome acessível continua vindo do `aria-label`),
   * altura alinhada à do `.input` dos <select> nativos vizinhos e — o principal —
   * carga TARDIA da lista (ver `filterDefaults`).
   */
  variant?: 'form' | 'filter';
  /** Texto do campo vazio. Default por variante. */
  placeholder?: string;
}

export default function ChartAccountSelect({
  value,
  onChange,
  label,
  error,
  id,
  variant = 'form',
  placeholder,
}: Readonly<ChartAccountSelectProps>) {
  const isFilter = variant === 'filter';
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

  // ── Carga TARDIA da lista inicial (só variant='filter') ──────────────────────
  // No 'form' o campo é obrigatório e sempre usado, então `defaultOptions` booleano
  // (= carrega na montagem) se paga. Num FILTRO opcional isso custaria ~530 descrições
  // na ABERTURA de /consulta, que é justamente o que não pode acontecer.
  //
  // Passar `defaultOptions={false}` e virar para `true` ao abrir o menu NÃO funciona:
  // no react-select 5.10.2 o efeito que dispara a carga tem lista de dependências vazia
  // ("designed to only run when the component mounts", useAsync). O que ele reavalia a
  // cada render é o `defaultOptions` quando ele é um ARRAY — por isso a lista é buscada
  // aqui, no primeiro onMenuOpen, e entregue como array.
  const [filterDefaults, setFilterDefaults] = useState<ChartAccountOption[] | undefined>(undefined);
  const [loadingDefaults, setLoadingDefaults] = useState(false);

  const handleMenuOpen = useCallback(() => {
    if (filterDefaults !== undefined || loadingDefaults) return; // já carregou / carregando
    setLoadingDefaults(true);
    void loadOptions('').then((opts) => {
      // Só memoiza o SUCESSO. `loadOptions` engole a exceção e devolve [] — gravar esse []
      // marcaria "já carregado" e a guarda acima bloquearia toda abertura seguinte: uma
      // indisponibilidade momentânea da Next API no instante da 1ª abertura deixava o menu
      // vazio pelo resto do mount. Lista legitimamente vazia (cadastro sem plano postável)
      // custa uma requisição por abertura — preço barato para não fossilizar uma falha.
      if (opts.length > 0) setFilterDefaults(opts);
      setLoadingDefaults(false);
    });
  }, [filterDefaults, loadingDefaults, loadOptions]);

  return (
    <div>
      {!isFilter && <span className="block text-sm font-medium text-gray-700 mb-1">{label}</span>}
      <AsyncSelect<ChartAccountOption>
        inputId={id}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        value={selected}
        isClearable
        cacheOptions
        defaultOptions={isFilter ? filterDefaults : true}
        onMenuOpen={isFilter ? handleMenuOpen : undefined}
        isLoading={isFilter ? loadingDefaults : undefined}
        loadOptions={loadOptions}
        onChange={(opt) => {
          setSelected(opt);
          onChange(opt ? opt.value : null);
        }}
        placeholder={placeholder ?? (isFilter ? 'Plano de contas' : 'Buscar plano de contas…')}
        loadingMessage={() => 'Buscando…'}
        noOptionsMessage={() => loadError ?? 'Nenhum plano de contas encontrado'}
        classNamePrefix="rs"
        classNames={{
          control: () =>
            isFilter
              ? 'min-h-[34px] rounded-lg border border-slate-200 bg-white text-sm'
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
