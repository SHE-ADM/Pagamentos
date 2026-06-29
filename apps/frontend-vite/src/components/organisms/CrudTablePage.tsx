// src/components/organisms/CrudTablePage.tsx
// Organism genérico de página CRUD de cadastro (grupo Tabelas): lista paginada +
// busca (debounce) e modal de criar/editar (form via render prop). Generaliza o
// padrão de CostCentersPage para reuso pelos cadastros de Bancos/Contas/Plano de
// contas/Grupos/Sub grupos. A EXCLUSÃO foi removida da UI (só criar/editar).
//
// Genérico em <T, TInput>: T = linha do grid; TInput = payload de criação/edição
// (o form valida e chama onSubmit(TInput)).
import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { RefreshCw, Plus, type LucideIcon } from 'lucide-react';
import type { ColumnDef } from '../../hooks/useGridColumns';
import DataGrid from './DataGrid';
import Alert from '../atoms/Alert';
import SearchInput from '../molecules/SearchInput';
import { getErrorMessage } from '../../lib/getErrorMessage';

const SEARCH_DEBOUNCE_MS = 350;
const NOTICE_DISMISS_MS = 5000;
const DEFAULT_PAGE_SIZE = 20;
// Altura máxima do corpo do grid — habilita o cabeçalho fixo (viewport rolável),
// padronizando com o grid de /consulta. Vh para acompanhar a altura da janela.
const GRID_MAX_BODY_HEIGHT = '70vh';

interface CrudFormRenderArgs<T, TInput> {
  mode: 'create' | 'edit';
  row?: T;
  onSubmit: (data: TInput) => Promise<void>;
  onCancel: () => void;
  submitError: string | null;
  submitting: boolean;
}

interface CrudTablePageProps<T, TInput> {
  title: string;
  subtitle: string;
  icon: LucideIcon;
  /** Identificador estável do grid — chave das preferências de layout (localStorage). */
  gridId: string;
  rowKey: (row: T) => string;
  columns: (onEdit: (r: T) => void) => ColumnDef<T>[];
  list: (params: {
    page: number;
    limit: number;
    search?: string;
    sort?: string;
    order?: 'asc' | 'desc';
  }) => Promise<{ data: T[]; total: number }>;
  onCreate: (data: TInput) => Promise<unknown>;
  onUpdate: (row: T, data: TInput) => Promise<unknown>;
  renderForm: (args: CrudFormRenderArgs<T, TInput>) => ReactNode;
  newButtonLabel: string;
  searchId: string;
  searchPlaceholder: string;
  searchAriaLabel: string;
  emptyMessage: string;
  gridAriaLabel: string;
  countLabel: (total: number) => string; // ex.: (n) => `${n} bancos`
  messages: { created: string; updated: string };
  formTitle: { create: string; edit: string };
  pageSize?: number;
}

type FormState<T> = { mode: 'create' | 'edit'; row?: T } | null;

export default function CrudTablePage<T, TInput>(props: Readonly<CrudTablePageProps<T, TInput>>) {
  const { icon: Icon, pageSize = DEFAULT_PAGE_SIZE } = props;

  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  // Ordenação server-side: col/dir aplicados na requisição. Ciclo asc→desc→nenhum.
  const [sort, setSort] = useState<{ col: string | null; dir: 'asc' | 'desc' | null }>({ col: null, dir: null });

  const [form, setForm] = useState<FormState<T>>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const formDialogRef = useRef<HTMLDialogElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await props.list({
        page,
        limit: pageSize,
        search: search || undefined,
        sort: sort.col ?? undefined,
        order: sort.dir ?? undefined,
      });
      setRows(result.data);
      setTotal(result.total);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [page, search, sort, pageSize, props]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    if (searchInput === search) return;
    const t = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput, search]);

  useEffect(() => {
    const el = formDialogRef.current;
    if (!el) return;
    try {
      if (form) el.showModal();
      else el.close();
    } catch {
      /* jsdom */
    }
  }, [form]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_DISMISS_MS);
    return () => clearTimeout(t);
  }, [notice]);

  // Ciclo de ordenação: nenhuma → asc → desc → nenhuma. Reseta para a 1ª página.
  const handleSort = (col: string) => {
    setSort((prev) => {
      if (prev.col !== col) return { col, dir: 'asc' };
      if (prev.dir === 'asc') return { col, dir: 'desc' };
      return { col: null, dir: null };
    });
    setPage(1);
  };

  const openCreate = () => {
    setFormError(null);
    setForm({ mode: 'create' });
  };
  const openEdit = (row: T) => {
    setFormError(null);
    setForm({ mode: 'edit', row });
  };
  const closeForm = () => setForm(null);

  const handleSubmit = async (data: TInput) => {
    if (!form) return;
    setSubmitting(true);
    setFormError(null);
    try {
      if (form.mode === 'create') {
        await props.onCreate(data);
        setNotice(props.messages.created);
      } else if (form.row) {
        await props.onUpdate(form.row, data);
        setNotice(props.messages.updated);
      }
      setForm(null);
      await load();
    } catch (e) {
      setFormError(getErrorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const columns = props.columns(openEdit);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-gray-200 bg-white flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-gray-900">{props.title}</h1>
          <p className="text-xs text-gray-500 mt-0.5">{props.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="btn" disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Carregando…' : 'Atualizar'}
          </button>
          <button onClick={openCreate} className="btn btn-primary">
            <Plus size={14} /> {props.newButtonLabel}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <Alert variant="error" className="mb-4">
            <strong>Erro:</strong> {error}
          </Alert>
        )}
        {notice && (
          <Alert variant="success" className="mb-4">
            {notice}
          </Alert>
        )}

        <div className="flex gap-2 mb-4 flex-wrap">
          <SearchInput
            id={props.searchId}
            ariaLabel={props.searchAriaLabel}
            placeholder={props.searchPlaceholder}
            value={searchInput}
            onChange={setSearchInput}
          />
        </div>

        <div className="card overflow-hidden mb-2">
          <DataGrid<T>
            columns={columns}
            rows={rows}
            rowKey={props.rowKey}
            onRowClick={() => undefined}
            sortCol={sort.col}
            sortDir={sort.dir}
            onSort={handleSort}
            // Padrão do grid de /consulta: gestão de colunas (mostrar/ocultar, fixar,
            // reordenar, redimensionar, restaurar), densidade compacta e cabeçalho fixo.
            gridId={props.gridId}
            enableColumnManagement
            defaultDensity="compact"
            maxBodyHeight={GRID_MAX_BODY_HEIGHT}
            loading={loading}
            ariaLabel={props.gridAriaLabel}
            emptyMessage={props.emptyMessage}
          />
        </div>

        <div className="flex items-center justify-between py-2 px-1">
          <span className="text-xs text-gray-500">
            {props.countLabel(total)} · Página {page} de {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage(page - 1)} disabled={page <= 1 || loading} className="btn">
              ← Anterior
            </button>
            <button onClick={() => setPage(page + 1)} disabled={page >= totalPages || loading} className="btn">
              Próxima →
            </button>
          </div>
        </div>
      </div>

      {form && (
        <dialog
          ref={formDialogRef}
          aria-label={form.mode === 'edit' ? props.formTitle.edit : props.formTitle.create}
          onCancel={closeForm}
          className="fixed inset-0 m-auto h-fit max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border-0 bg-white p-0 shadow-lg backdrop:bg-black/50"
        >
          <div className="p-6">
            <div className="mb-4 flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 text-brand">
                <Icon size={16} />
              </div>
              <h2 className="text-base font-semibold text-gray-900">
                {form.mode === 'edit' ? props.formTitle.edit : props.formTitle.create}
              </h2>
            </div>
            {props.renderForm({
              mode: form.mode,
              row: form.row,
              onSubmit: handleSubmit,
              onCancel: closeForm,
              submitError: formError,
              submitting,
            })}
          </div>
        </dialog>
      )}
    </div>
  );
}
