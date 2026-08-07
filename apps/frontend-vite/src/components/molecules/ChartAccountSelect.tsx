// src/components/molecules/ChartAccountSelect.tsx
// Molecule — 1º select da classificação contábil (cascata INVERTIDA Plano → Centro):
// pesquisa as DESCRIÇÕES distintas de planos de contas postáveis na Next API e retorna a
// descrição escolhida. A mesma descrição ("Serviços Gerais") existe em vários centros de
// custo; a escolha do CENTRO (2º select, CostCenterSelect) é que resolve o chart_account_id.
// NÃO é creatable (cadastro externo ao app).
import { useCallback, useRef, useState } from 'react';
import AsyncSelect from 'react-select/async';
import { listPlanoDescriptions } from '../../services/lookups';
import { listUsedChartAccountDescriptions } from '../../services/supabase';

// Mensagem exibida quando o lookup FALHA (API de dados fora, 401/500) — distinta de
// "lista vazia". Evita o engano de "Nenhum plano encontrado" quando a Next API não respondeu.
const LOAD_ERROR_MSG = 'Não foi possível carregar os planos de contas (API de dados indisponível).';

interface ChartAccountOption {
  value: string; // account_description
  label: string;
}

// Normaliza para COMPARAÇÃO: sem acento e em minúsculas. Em pt-BR isto é a regra, não o
// requinte — sem ele "servicos" não acha "Serviços". Melhora inclusive o que existia
// antes: o `ilike` do PostgreSQL é case-insensitive mas NÃO ignora acento.
// `\p{Diacritic}` (fonte ASCII) em vez do range de combinantes escrito literalmente — o
// literal depende da codificação do arquivo, que este repositório já viu se perder.
const normalize = (s: string): string =>
  s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

// Filtro em MEMÓRIA sobre o catálogo já carregado. Substring, como o `ilike %termo%` que
// o servidor fazia — só que na mesma tecla, sem ida à rede.
function filterCatalog(all: ChartAccountOption[], term: string): ChartAccountOption[] {
  const t = normalize(term.trim());
  return t ? all.filter((o) => normalize(o.label).includes(t)) : all;
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

  // ── Catálogo COMPLETO em memória, buscado UMA vez ────────────────────────────
  // Antes cada tecla disparava uma busca no servidor (`?search=<termo>`). Medido no dev
  // server contra o cadastro real: 420 a 1160 ms POR requisição, uma por caractere, com
  // as respostas chegando FORA DE ORDEM — e o react-select descarta todas menos a da
  // última requisição emitida. Resultado: enquanto o usuário digita a lista fica em
  // "Buscando…", e só assenta quando ele PARA. É exatamente o sintoma relatado ("não
  // oferece os planos conforme vou digitando; só achando o texto inteiro").
  //
  // O cadastro tem ~610 linhas postáveis — cabe inteiro em memória, então a lista vem
  // numa requisição só e a digitação passa a filtrar localmente, na mesma tecla.
  //
  // Ref, e não estado: a atribuição é imediata, então duas chamadas concorrentes (abrir o
  // menu e já digitar) compartilham a MESMA promessa em vez de disparar duas requisições.
  // Mesmo padrão de `loadingMoreRef`/`readingRef` em Consulta.tsx. Por INSTÂNCIA (não de
  // módulo) para não servir catálogo obsoleto depois de um cadastro novo em /tabelas.
  const catalogRef = useRef<Promise<ChartAccountOption[]> | null>(null);

  // ── De ONDE vem o catálogo, por variante ─────────────────────────────────────
  // FILTRO: só as descrições que aparecem de fato em `financial_account_control` (busca
  // GERAL, independente dos filtros em tela). Escolher um plano sem conta nenhuma devolvia
  // grid vazio, indistinguível de filtro quebrado — medido, 611 planos cadastrados contra
  // 84 em uso. A consulta vai pelo Supabase REST com o token do usuário, então a RLS vale:
  // o grupo restrito recebe só as opções que o grid dele consegue mostrar.
  //
  // FORMULÁRIO: o cadastro INTEIRO, pela Next API. Aqui o usuário está classificando uma
  // conta nova, e restringir ao que já foi usado impediria justamente a primeira conta de
  // um plano — o oposto do que o filtro precisa.
  const loadCatalog = useCallback((): Promise<ChartAccountOption[]> => {
    // A escolha da fonte fica DENTRO do `??=`: o lado direito só é avaliado quando o ref
    // está vazio. Montar a promessa fora dele dispararia a requisição a cada tecla, mesmo
    // com o catálogo já em memória — justamente o que este bloco existe para evitar.
    catalogRef.current ??= (
      isFilter
        ? listUsedChartAccountDescriptions()
        : listPlanoDescriptions().then((data) => data.map((c) => c.account_description))
    ).then(
      (descriptions) => descriptions.map((d) => ({ value: d, label: d })),
      (e: unknown) => {
        // A FALHA não é memoizada: uma indisponibilidade momentânea da API não pode
        // deixar o select vazio pelo resto do mount (mesma lição do `filterDefaults`).
        catalogRef.current = null;
        throw e;
      },
    );
    return catalogRef.current;
  }, [isFilter]);

  // Filtra o catálogo pelo que foi digitado. Em falha, marca o erro (mostrado abaixo e no
  // menu) e devolve [] — sem mascarar como "nenhum encontrado".
  //
  // ⚠️ Mudança de comportamento deliberada: a busca por CÓDIGO do plano deixou de existir
  // (o `or` do servidor casava `account_code` também). O código não é exibido na opção,
  // então casar por ele devolvia uma descrição que o usuário não tinha como conferir — e
  // mantê-lo exigiria o round trip por tecla que este bloco existe para eliminar.
  const loadOptions = useCallback(async (input: string): Promise<ChartAccountOption[]> => {
    try {
      const all = await loadCatalog();
      setLoadError(null);
      return filterCatalog(all, input);
    } catch {
      setLoadError(LOAD_ERROR_MSG);
      return [];
    }
  }, [loadCatalog]);

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
        // Sem `cacheOptions`: ele existia para não repetir REQUISIÇÃO por termo digitado, e
        // não há mais requisição por termo — o filtro é em memória. Mantê-lo só acumularia
        // um array por prefixo digitado e sugeriria, ao próximo leitor, que ainda há rede
        // no caminho da digitação.
        defaultOptions={isFilter ? filterDefaults : true}
        onMenuOpen={isFilter ? handleMenuOpen : undefined}
        isLoading={isFilter ? loadingDefaults : undefined}
        loadOptions={loadOptions}
        onChange={(opt) => {
          setSelected(opt);
          onChange(opt ? opt.value : null);
        }}
        // ── O menu do FILTRO precisa sair do contêiner que o corta ──────────────────
        // Na barra de filtros de /consulta este select vive dentro de um
        // `overflow-x-auto` (a grade única de 8 colunas, que rola as duas linhas juntas).
        // Pelo CSS, `overflow-x: auto` com `overflow-y: visible` faz o Y computar para
        // `auto` TAMBÉM — ou seja, o contêiner corta na vertical. Como o react-select
        // renderiza o menu inline, logo abaixo do controle, ele nascia clipado: a lista
        // simplesmente não aparecia, e digitar o texto exato "funcionava" só porque a
        // opção invisível ficava focada e o Enter a escolhia.
        //
        // Portal SÓ na variante de filtro: no 'form' o select vive dentro de um
        // <dialog> aberto por showModal(), que pinta na TOP LAYER — um portal para o
        // body ficaria ATRÁS do modal, trocando um sumiço por outro.
        menuPortalTarget={isFilter ? document.body : undefined}
        styles={isFilter ? { menuPortal: (base) => ({ ...base, zIndex: 50 }) } : undefined}
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
