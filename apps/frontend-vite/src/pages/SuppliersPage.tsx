// src/pages/SuppliersPage.tsx
// Página "Cadastro de fornecedores" — lista paginada + busca, criar e editar
// sobre o CRUD da Next API (services/suppliers.ts). A exclusão não é exposta na UI.
// A escrita não passa pelo REST direto do Supabase porque `supplier` tem RLS
// só-leitura para authenticated; a Next API grava com service_role.
import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Plus, Building2 } from 'lucide-react';
import type { Supplier, SupplierCreateInput } from '@sheild/shared';
import { listSuppliers, createSupplier, updateSupplier } from '../services/suppliers';
import { getSupplierColumns } from '../hooks/useGridColumns';
import { getErrorMessage } from '../lib/getErrorMessage';
import DataGrid from '../components/organisms/DataGrid';
import SupplierForm from '../components/organisms/SupplierForm';
import Alert from '../components/atoms/Alert';

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 350;

type FormState = { mode: 'create' | 'edit'; supplier?: Supplier } | null;

export default function SuppliersPage() {
  const [rows, setRows] = useState<Supplier[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Busca: valor do input (form) vs. aplicado (dispara o fetch) — debounce 350ms.
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  // Modal de criação/edição
  const [form, setForm] = useState<FormState>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const formDialogRef = useRef<HTMLDialogElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listSuppliers({ page, limit: PAGE_SIZE, search: search || undefined });
      setRows(result.data);
      setTotal(result.total);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    // fetch-on-change (seta loading no início) — o effect é a ferramenta correta.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

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

  const openCreate = () => {
    setFormError(null);
    setForm({ mode: 'create' });
  };
  const openEdit = (supplier: Supplier) => {
    setFormError(null);
    setForm({ mode: 'edit', supplier });
  };
  const closeForm = () => setForm(null);

  const handleSubmit = async (data: SupplierCreateInput) => {
    if (!form) return;
    setSubmitting(true);
    setFormError(null);
    try {
      if (form.mode === 'create') {
        await createSupplier(data);
        setNotice('Fornecedor cadastrado com sucesso.');
      } else if (form.supplier) {
        await updateSupplier(form.supplier.sk_supplier, data);
        setNotice('Fornecedor atualizado com sucesso.');
      }
      setForm(null);
      await load();
    } catch (e) {
      setFormError(getErrorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const columns = getSupplierColumns(openEdit);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-gray-200 bg-white flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-gray-900">Cadastro de fornecedores</h1>
          <p className="text-xs text-gray-500 mt-0.5">Gestão de fornecedores — tabela supplier</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="btn" disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Carregando…' : 'Atualizar'}
          </button>
          <button onClick={openCreate} className="btn btn-primary">
            <Plus size={14} /> Novo fornecedor
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
          <input
            id="suppliers-search"
            name="suppliers-search"
            aria-label="Buscar fornecedor por nome, CNPJ, CPF ou e-mail"
            className="input w-72"
            placeholder="Buscar por nome, CNPJ, CPF ou e-mail…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>

        <div className="card overflow-hidden mb-2">
          <DataGrid<Supplier>
            columns={columns}
            rows={rows}
            rowKey={(s) => String(s.sk_supplier)}
            onRowClick={openEdit}
            sortCol={null}
            sortDir={null}
            onSort={() => undefined}
            loading={loading}
            ariaLabel="Fornecedores cadastrados"
            emptyMessage="Nenhum fornecedor encontrado"
          />
        </div>

        <div className="flex items-center justify-between py-2 px-1">
          <span className="text-xs text-gray-500">
            {total} fornecedores · Página {page} de {totalPages}
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

      {/* Modal de criação/edição */}
      {form && (
        <dialog
          ref={formDialogRef}
          aria-label={form.mode === 'edit' ? 'Editar fornecedor' : 'Novo fornecedor'}
          onCancel={closeForm}
          className="fixed inset-0 m-auto h-fit max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border-0 bg-white p-0 shadow-lg backdrop:bg-black/50"
        >
          <div className="p-6">
            <div className="mb-4 flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 text-brand">
                <Building2 size={16} />
              </div>
              <h2 className="text-base font-semibold text-gray-900">
                {form.mode === 'edit' ? 'Editar fornecedor' : 'Novo fornecedor'}
              </h2>
            </div>
            <SupplierForm
              key={form.supplier?.sk_supplier ?? 'new'}
              mode={form.mode}
              defaultValues={form.supplier}
              onSubmit={handleSubmit}
              onCancel={closeForm}
              submitError={formError}
              submitting={submitting}
            />
          </div>
        </dialog>
      )}
    </div>
  );
}
