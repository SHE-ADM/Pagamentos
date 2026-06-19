// pages/cobranca/CobrancaEnvios.tsx
// Grid de cobranca_envios_log — leitura paginada via cobrancaService, no mesmo
// padrão de Consulta.tsx (DataGrid headless + tokens do projeto).

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { fetchEnviosLog } from '../../services/cobrancaService';
import type { CobrancaEnvioLog } from '../../types/cobranca';
import { getErrorMessage } from '../../lib/getErrorMessage';
import Alert from '../../components/atoms/Alert';
import DataGrid from '../../components/organisms/DataGrid';
import { enviosColumns } from './cobrancaColumns';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 350;

export default function CobrancaEnvios() {
  const { session } = useAuth();
  const token = session?.access_token ?? '';

  const [rows, setRows] = useState<CobrancaEnvioLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounce da busca (fonte única, sem ref): 350ms após a última tecla, congela
  // `search` em `applied`. O cleanup cancela o timeout pendente — mesmo padrão de Consulta.
  useEffect(() => {
    if (search === applied) return;
    const t = setTimeout(() => {
      setApplied(search);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search, applied]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const { data, total: t } = await fetchEnviosLog({ token, page, search: applied || undefined });
      setRows(data);
      setTotal(t);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [token, page, applied]);

  useEffect(() => {
    // fetch-on-change — o effect é a ferramenta certa quando token/page/applied mudam;
    // sem lib de dados não há como evitar o setState síncrono (mesmo padrão de Consulta).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col h-full">
      <div className="h-0.5 bg-linear-to-r from-brand to-brand-dark" />
      <div className="px-6 py-2 border-b border-slate-200 bg-white">
        <h1 className="text-sm font-semibold text-slate-800">Log de Envios</h1>
        <p className="text-xs text-slate-500">
          Cobranças enviadas com sucesso
          {total > 0 && <span className="ml-1">— {total} registro{total === 1 ? '' : 's'}</span>}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-3">
        {error && (
          <Alert variant="error" className="mb-4">
            <strong>Erro:</strong> {error}
          </Alert>
        )}

        <div className="flex gap-2 flex-wrap mb-2">
          <input
            id="envios-search"
            name="envios-search"
            type="search"
            aria-label="Buscar por cliente ou título"
            placeholder="Buscar por cliente ou título…"
            className="input w-72 max-w-full"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="card mb-2">
          <DataGrid
            columns={enviosColumns}
            rows={rows}
            rowKey={(r) => String(r.id)}
            onRowClick={() => undefined}
            sortCol={null}
            sortDir={null}
            onSort={() => undefined}
            loading={loading}
            ariaLabel="Cobranças enviadas"
            emptyMessage={applied ? `Nenhum resultado para "${applied}".` : 'Nenhum envio registrado.'}
          />
        </div>

        <div className="flex items-center justify-between py-2 px-1 mb-4">
          <span className="text-xs text-slate-500">{total} registros</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              className="btn disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ← Anterior
            </button>
            <span className="badge bg-slate-100 text-slate-600">
              Página {page} de {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
              className="btn disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Próxima →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
