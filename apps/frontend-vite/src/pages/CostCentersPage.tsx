// src/pages/CostCentersPage.tsx
// Página "Centro de custos" (grupo Tabelas) — lista paginada + busca, criar e
// editar sobre o CRUD da Next API (services/costCenters.ts). A escrita não passa
// pelo REST direto do Supabase porque `financial_cost_center` tem RLS só-leitura
// para authenticated; a Next API grava com service_role. O sentinela id 0
// ("não informado") é preservado e nunca aparece nesta lista. O hard delete é
// oferecido APENAS ao grupo Administrador (isAdminGroup); o backend impõe a trava real.
import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Plus, Layers, Trash2 } from 'lucide-react';
import type { CostCenter, CostCenterCreateInput, ChartAccount } from '@sheild/shared';
import { listCostCentersPage, createCostCenter, updateCostCenter, deleteCostCenter } from '../services/costCenters';
import { listChartAccountsByCostCenter } from '../services/chartAccounts';
import { getCostCenterColumns, getCostCenterChartAccountColumns } from '../hooks/useGridColumns';
import { getErrorMessage } from '../lib/getErrorMessage';
import { useAuth } from '../contexts/AuthContext';
import DataGrid from '../components/organisms/DataGrid';
import CostCenterForm from '../components/organisms/CostCenterForm';
import SearchInput from '../components/molecules/SearchInput';
import Alert from '../components/atoms/Alert';

const PAGE_SIZE = 20;
// Grid mestre (centros de custo) exibe menos registros por página para liberar
// espaço vertical ao grid complementar (plano de contas) logo abaixo.
const MASTER_PAGE_SIZE = 7;
// Colunas do grid complementar são estáticas (read-only) — definir uma vez fora do componente.
const DETAIL_COLUMNS = getCostCenterChartAccountColumns();
// Rótulo do centro selecionado no cabeçalho do grid complementar ("código — descrição").
const costCenterHeading = (c: CostCenter): string =>
  [c.cost_center_code, c.cost_center_description].filter(Boolean).join(' — ') || `#${c.cost_center_id}`;
const SEARCH_DEBOUNCE_MS = 350;
const NOTICE_DISMISS_MS = 5000; // banner de sucesso some sozinho após este tempo

type FormState = { mode: 'create' | 'edit'; costCenter?: CostCenter } | null;

export default function CostCentersPage() {
  const { isAdminGroup } = useAuth();
  const [rows, setRows] = useState<CostCenter[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Busca: valor do input (form) vs. aplicado (dispara o fetch) — debounce 350ms.
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  // Ordenação server-side (ciclo asc→desc→nenhum).
  const [sort, setSort] = useState<{ col: string | null; dir: 'asc' | 'desc' | null }>({ col: null, dir: null });

  // Mestre-detalhe: centro selecionado + grid complementar do plano de contas dele.
  const [selected, setSelected] = useState<CostCenter | null>(null);
  const [detailRows, setDetailRows] = useState<ChartAccount[]>([]);
  const [detailTotal, setDetailTotal] = useState(0);
  const [detailPage, setDetailPage] = useState(1);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  // Ordenação inicial do grid complementar: código (account_code) ascendente.
  const [detailSort, setDetailSort] = useState<{ col: string | null; dir: 'asc' | 'desc' | null }>({
    col: 'account_code',
    dir: 'asc',
  });

  // Modal de criação/edição
  const [form, setForm] = useState<FormState>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Exclusão (hard delete, admin-only): linha alvo da confirmação + estado do request.
  const [deleteTarget, setDeleteTarget] = useState<CostCenter | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const formDialogRef = useRef<HTMLDialogElement>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const detailRef = useRef<HTMLElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listCostCentersPage({
        page,
        limit: MASTER_PAGE_SIZE,
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
  }, [page, search, sort]);

  useEffect(() => {
    // fetch-on-change (seta loading no início) — o effect é a ferramenta correta.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Carga do grid complementar: plano de contas lançável do centro selecionado.
  // Sem seleção, não busca (limpa as linhas). Keyed em [selected, detailSort, detailPage].
  const loadDetail = useCallback(async () => {
    if (!selected) {
      setDetailRows([]);
      setDetailTotal(0);
      setDetailError(null);
      return;
    }
    setDetailLoading(true);
    setDetailError(null);
    try {
      const result = await listChartAccountsByCostCenter(selected.cost_center_id, {
        page: detailPage,
        limit: PAGE_SIZE,
        sort: detailSort.col ?? undefined,
        order: detailSort.dir ?? undefined,
      });
      setDetailRows(result.data);
      setDetailTotal(result.total);
    } catch (e) {
      setDetailError(getErrorMessage(e));
      setDetailRows([]);
      setDetailTotal(0);
    } finally {
      setDetailLoading(false);
    }
  }, [selected, detailPage, detailSort]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDetail();
  }, [loadDetail]);

  // Debounce do input de busca → valor aplicado. Cleanup cancela o timeout pendente.
  useEffect(() => {
    if (searchInput === search) return;
    const t = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput, search]);

  // Abre/fecha os <dialog> nativos (foco/trap/Esc do navegador; try/catch p/ jsdom).
  useEffect(() => {
    const el = formDialogRef.current;
    if (!el) return;
    try {
      if (form) el.showModal();
      else el.close();
    } catch {
      /* showModal indisponível (jsdom) */
    }
  }, [form]);

  useEffect(() => {
    const el = deleteDialogRef.current;
    if (!el) return;
    try {
      if (deleteTarget) el.showModal();
      else el.close();
    } catch {
      /* jsdom */
    }
  }, [deleteTarget]);

  // Ao selecionar um centro, traz o grid complementar (plano de contas) para a viewport —
  // caso contrário ele abriria no rodapé da página, exigindo rolagem para ser visto.
  useEffect(() => {
    if (!selected) return;
    detailRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [selected]);

  // Auto-dispensa o banner de sucesso (evita `notice` stale aparecer para uma ação nova).
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

  // Clique na linha do mestre alterna a seleção (mesmo centro → desmarca). O grid
  // complementar recarrega via efeito; sempre volta à 1ª página do detalhe.
  const handleSelect = (costCenter: CostCenter) => {
    setSelected((prev) => (prev?.cost_center_id === costCenter.cost_center_id ? null : costCenter));
    setDetailPage(1);
  };

  // Ciclo de ordenação do grid complementar (idem mestre); reseta para a 1ª página do detalhe.
  const handleDetailSort = (col: string) => {
    setDetailSort((prev) => {
      if (prev.col !== col) return { col, dir: 'asc' };
      if (prev.dir === 'asc') return { col, dir: 'desc' };
      return { col: null, dir: null };
    });
    setDetailPage(1);
  };

  const openCreate = () => {
    setFormError(null);
    setForm({ mode: 'create' });
  };
  const openEdit = (costCenter: CostCenter) => {
    setFormError(null);
    setForm({ mode: 'edit', costCenter });
  };
  const closeForm = () => setForm(null);

  const handleSubmit = async (data: CostCenterCreateInput) => {
    if (!form) return;
    setSubmitting(true);
    setFormError(null);
    try {
      if (form.mode === 'create') {
        await createCostCenter(data);
        setNotice('Centro de custo cadastrado com sucesso.');
      } else if (form.costCenter) {
        await updateCostCenter(form.costCenter.cost_center_id, data);
        setNotice('Centro de custo atualizado com sucesso.');
      }
      setForm(null);
      await load();
    } catch (e) {
      setFormError(getErrorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  // Exclusão (hard delete) só é oferecida ao grupo Administrador (o backend impõe requireAdminGroup → 403).
  const requestDelete = (costCenter: CostCenter) => {
    setDeleteError(null);
    setDeleteTarget(costCenter);
  };
  const closeDelete = () => {
    setDeleteTarget(null);
    setDeleteError(null);
  };
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteCostCenter(deleteTarget.cost_center_id);
      setNotice('Centro de custo excluído com sucesso.');
      setDeleteTarget(null);
      await load();
    } catch (e) {
      setDeleteError(getErrorMessage(e));
    } finally {
      setDeleting(false);
    }
  };

  const columns = getCostCenterColumns(openEdit, isAdminGroup ? requestDelete : undefined);
  const totalPages = Math.max(1, Math.ceil(total / MASTER_PAGE_SIZE));
  const detailTotalPages = Math.max(1, Math.ceil(detailTotal / PAGE_SIZE));
  const deleteName = deleteTarget
    ? (deleteTarget.cost_center_description ?? deleteTarget.cost_center_code ?? `#${deleteTarget.cost_center_id}`)
    : '';

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-gray-200 bg-white flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-gray-900">Centro de custos</h1>
          <p className="text-xs text-gray-500 mt-0.5">Tabelas</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="btn" disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Carregando…' : 'Atualizar'}
          </button>
          <button onClick={openCreate} className="btn btn-primary">
            <Plus size={14} /> Novo centro de custo
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
            id="cost-centers-search"
            ariaLabel="Buscar centro de custo por código ou descrição"
            placeholder="Buscar por código ou descrição…"
            value={searchInput}
            onChange={setSearchInput}
          />
        </div>

        <div className="card overflow-hidden mb-2">
          <DataGrid<CostCenter>
            columns={columns}
            rows={rows}
            rowKey={(c) => String(c.cost_center_id)}
            // Clicar na linha SELECIONA o centro (carrega o plano de contas abaixo); a edição
            // continua abrindo só pelo botão de lápis (coluna "Ações").
            selectedId={selected ? String(selected.cost_center_id) : null}
            onRowClick={handleSelect}
            sortCol={sort.col}
            sortDir={sort.dir}
            onSort={handleSort}
            // Padrão do grid de /consulta: gestão de colunas, densidade compacta e cabeçalho fixo.
            gridId="tabela-centros-de-custo"
            enableColumnManagement
            defaultDensity="compact"
            maxBodyHeight="70vh"
            loading={loading}
            ariaLabel="Centros de custo cadastrados"
            emptyMessage="Nenhum centro de custo encontrado"
          />
        </div>

        <div className="flex items-center justify-between py-2 px-1">
          <span className="text-xs text-gray-500">
            {total} centros de custo · Página {page} de {totalPages}
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

        {/* Grid complementar: plano de contas lançável do centro de custo selecionado. */}
        <section ref={detailRef} className="mt-6 scroll-mt-4" aria-label="Plano de contas do centro de custo">
          <div className="mb-2 flex items-center gap-2">
            <Layers size={16} className="text-brand" />
            <h2 className="text-sm font-semibold text-gray-900">
              Plano de contas
              {selected && <span className="font-normal text-gray-500"> — {costCenterHeading(selected)}</span>}
            </h2>
          </div>

          {detailError && (
            <Alert variant="error" className="mb-4">
              <strong>Erro:</strong> {detailError}
            </Alert>
          )}

          <div className="card overflow-hidden mb-2">
            <DataGrid<ChartAccount>
              columns={DETAIL_COLUMNS}
              rows={detailRows}
              rowKey={(c) => String(c.chart_account_id)}
              // Read-only: as linhas do plano de contas não são clicáveis aqui.
              onRowClick={() => undefined}
              sortCol={detailSort.col}
              sortDir={detailSort.dir}
              onSort={handleDetailSort}
              gridId="tabela-centros-de-custo-plano"
              enableColumnManagement
              defaultDensity="compact"
              maxBodyHeight="40vh"
              loading={detailLoading}
              ariaLabel="Plano de contas do centro de custo selecionado"
              emptyMessage={
                selected
                  ? 'Nenhum plano de contas vinculado a este centro'
                  : 'Selecione um centro de custo para ver o plano de contas'
              }
            />
          </div>

          {selected && (
            <div className="flex items-center justify-between py-2 px-1">
              <span className="text-xs text-gray-500">
                {detailTotal} planos de contas · Página {detailPage} de {detailTotalPages}
              </span>
              <div className="flex items-center gap-2">
                <button onClick={() => setDetailPage(detailPage - 1)} disabled={detailPage <= 1 || detailLoading} className="btn">
                  ← Anterior
                </button>
                <button
                  onClick={() => setDetailPage(detailPage + 1)}
                  disabled={detailPage >= detailTotalPages || detailLoading}
                  className="btn"
                >
                  Próxima →
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      {/* Modal de criação/edição */}
      {form && (
        <dialog
          ref={formDialogRef}
          aria-label={form.mode === 'edit' ? 'Editar centro de custo' : 'Novo centro de custo'}
          onCancel={closeForm}
          className="fixed inset-0 m-auto h-fit max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-xl border-0 bg-white p-0 shadow-lg backdrop:bg-black/50"
        >
          <div className="p-6">
            <div className="mb-4 flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 text-brand">
                <Layers size={16} />
              </div>
              <h2 className="text-base font-semibold text-gray-900">
                {form.mode === 'edit' ? 'Editar centro de custo' : 'Novo centro de custo'}
              </h2>
            </div>
            <CostCenterForm
              key={form.costCenter?.cost_center_id ?? 'new'}
              mode={form.mode}
              defaultValues={form.costCenter}
              onSubmit={handleSubmit}
              onCancel={closeForm}
              submitError={formError}
              submitting={submitting}
            />
          </div>
        </dialog>
      )}

      {/* Confirmação de exclusão (hard delete, admin-only) */}
      {deleteTarget && (
        <dialog
          ref={deleteDialogRef}
          aria-label="Confirmar exclusão"
          onCancel={closeDelete}
          className="fixed inset-0 m-auto h-fit max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border-0 bg-white p-0 shadow-lg backdrop:bg-black/50"
        >
          <div className="p-6">
            <div className="mb-3 flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-status-error-bg text-status-error-fg">
                <Trash2 size={16} />
              </div>
              <h2 className="text-base font-semibold text-gray-900">Excluir centro de custo</h2>
            </div>
            <p className="mb-4 text-sm text-gray-600">
              Tem certeza que deseja excluir <strong className="text-gray-900">{deleteName}</strong>? Esta
              ação é permanente e não pode ser desfeita.
            </p>
            {deleteError && (
              <Alert variant="error" className="mb-4">
                {deleteError}
              </Alert>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={closeDelete} className="btn" disabled={deleting}>
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={deleting}
                className="btn bg-status-error-fg text-white hover:bg-status-error-fg/90"
              >
                <Trash2 size={14} /> {deleting ? 'Excluindo…' : 'Excluir'}
              </button>
            </div>
          </div>
        </dialog>
      )}
    </div>
  );
}
