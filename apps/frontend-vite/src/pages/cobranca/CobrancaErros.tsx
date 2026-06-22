// pages/cobranca/CobrancaErros.tsx
// Grid de cobranca_erros_log com filtro por tipo de erro — mesmo padrão de Consulta.tsx.

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  fetchErrosLog,
  getResendHealth,
  type ResendHealth,
  type ResendProgress,
} from '../../services/cobrancaService';
import type { CobrancaErroLog, ErrorType } from '../../types/cobranca';
import { ERROR_TYPE_LABEL } from '../../types/cobranca';
import { getErrorMessage } from '../../lib/getErrorMessage';
import Alert from '../../components/atoms/Alert';
import DataGrid from '../../components/organisms/DataGrid';
import ResendErrosAction from '../../components/organisms/ResendErrosAction';
import { errosColumns } from './cobrancaColumns';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 350;
const ERROR_TYPES = Object.keys(ERROR_TYPE_LABEL) as ErrorType[];

export default function CobrancaErros() {
  const { session } = useAuth();
  const token = session?.access_token ?? '';

  const [rows, setRows] = useState<CobrancaErroLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [errorType, setErrorType] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Prontidão do reenvio (probe no mount) — desabilita o botão sem backend/SMTP.
  const [resendHealth, setResendHealth] = useState<ResendHealth>({ ready: false, reason: null });
  const [resendNotice, setResendNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getResendHealth().then((h) => {
      if (alive) setResendHealth(h);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Debounce da busca (mesmo padrão de Consulta): congela `search` em `applied` após 350ms.
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
      const { data, total: t } = await fetchErrosLog({
        token,
        page,
        search: applied || undefined,
        errorType: errorType || undefined,
      });
      setRows(data);
      setTotal(t);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [token, page, applied, errorType]);

  useEffect(() => {
    // fetch-on-change — mesmo padrão de Consulta (sem lib de dados; setState síncrono).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Ao concluir o reenvio: banner com o balanço + recarrega o grid (linhas enviadas
  // saem de cobranca_erros_log conforme o status real muda no próximo ciclo).
  const handleResendFinished = useCallback(
    (s: ResendProgress) => {
      setError(null);
      if (s.error_msg) {
        setError(s.error_msg);
        return;
      }
      const parts = [`${s.sent} enviado${s.sent === 1 ? '' : 's'}`];
      if (s.skipped) parts.push(`${s.skipped} já enviado${s.skipped === 1 ? '' : 's'}`);
      if (s.no_email) parts.push(`${s.no_email} sem e-mail`);
      if (s.error) parts.push(`${s.error} com falha`);
      setResendNotice(`Reenvio concluído: ${parts.join(', ')}.`);
      void load();
    },
    [load],
  );

  return (
    <div className="flex flex-col h-full">
      <div className="h-0.5 bg-linear-to-r from-brand to-brand-dark" />
      <div className="px-6 py-2 border-b border-slate-200 bg-white">
        <h1 className="text-sm font-semibold text-slate-800">Log de Falhas</h1>
        <p className="text-xs text-slate-500">
          Cobranças com erro no processamento
          {total > 0 && <span className="ml-1">— {total} registro{total === 1 ? '' : 's'}</span>}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-3">
        {error && (
          <Alert variant="error" className="mb-4">
            <strong>Erro:</strong> {error}
          </Alert>
        )}

        {resendNotice && (
          <Alert variant="success" className="mb-4">
            {resendNotice}
          </Alert>
        )}

        <div className="flex gap-2 flex-wrap mb-2">
          <input
            id="erros-search"
            name="erros-search"
            type="search"
            aria-label="Buscar por cliente ou título"
            placeholder="Buscar por cliente ou título…"
            className="input w-72 max-w-full"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            id="erros-type"
            name="erros-type"
            aria-label="Filtrar por tipo de erro"
            className="input w-48"
            value={errorType}
            onChange={(e) => {
              setErrorType(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Todos os tipos</option>
            {ERROR_TYPES.map((t) => (
              <option key={t} value={t}>
                {ERROR_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>

        <div className="card mb-2">
          <DataGrid
            columns={errosColumns}
            rows={rows}
            rowKey={(r) => String(r.id)}
            onRowClick={() => undefined}
            sortCol={null}
            sortDir={null}
            onSort={() => undefined}
            loading={loading}
            ariaLabel="Falhas de cobrança"
            emptyMessage={
              applied || errorType ? 'Nenhum erro encontrado com os filtros aplicados.' : 'Nenhuma falha registrada.'
            }
            gridId="cobranca-erros"
            enableColumnManagement
            enableSelection
            renderSelectionActions={(selected, clear) => (
              <ResendErrosAction
                ids={selected.map((r) => r.id)}
                ready={resendHealth.ready}
                reason={resendHealth.reason}
                clearSelection={clear}
                onFinished={handleResendFinished}
                onError={setError}
              />
            )}
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
