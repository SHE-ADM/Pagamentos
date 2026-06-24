// src/pages/Erros.tsx
import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, AlertTriangle, XCircle, Info } from 'lucide-react';
import type { ProcessingError } from '@sheild/shared';
import { getProcessingErrors, getProcessingErrorStats, type ProcessingErrorStats } from '../services/supabase';
import { getErrorMessage } from '../lib/getErrorMessage';
import { cn } from '../lib/cn';
import StatusBadge from '../components/StatusBadge';
import Alert from '../components/atoms/Alert';

const fmtDt = (d: string | null): string => (d ? new Date(d).toLocaleString('pt-BR') : '—');

// erro_api primeiro — falha de API (crédito/auth/limite) é o erro mais crítico.
const ERROR_TYPES = [
  'erro_api',
  'sem_valor',
  'sem_fornecedor',
  'extracao_falhou',
  'db_erro',
  'processamento_erro',
  'pdf_protegido',
];

// Linha inteira destacada em vermelho quando o erro for de API — diferencia
// visualmente de uma falha de extração comum.
function rowClass(r: ProcessingError, selectedId: number | undefined): string {
  const selected = selectedId === r.id;
  if (r.error_type === 'erro_api') {
    return cn(
      'cursor-pointer bg-status-error-bg hover:bg-status-error-border',
      selected && 'ring-1 ring-inset ring-status-error-border',
    );
  }
  return cn('cursor-pointer hover:bg-gray-50', selected && 'bg-brand-light/40');
}

const PAGE_SIZE = 25;

interface ErrosFilters {
  errorType: string;
  sender: string;
  dateFrom: string;
  dateTo: string;
}

const EMPTY_FILTERS: ErrosFilters = { errorType: '', sender: '', dateFrom: '', dateTo: '' };

export default function Erros() {
  const [rows, setRows] = useState<ProcessingError[]>([]);
  const [stats, setStats] = useState<ProcessingErrorStats>({ total: 0, counts: {} });
  const [sel, setSel] = useState<ProcessingError | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState<ErrosFilters>({ ...EMPTY_FILTERS });
  const [applied, setApplied] = useState<ErrosFilters>({ ...EMPTY_FILTERS });
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const sf = <K extends keyof ErrosFilters>(k: K, v: ErrosFilters[K]) => setF((x) => ({ ...x, [k]: v }));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [result, st] = await Promise.all([
        getProcessingErrors({ ...applied, page, pageSize: PAGE_SIZE }),
        getProcessingErrorStats(),
      ]);
      setRows(result.data);
      setTotal(result.total);
      setStats(st);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [applied, page]);

  useEffect(() => {
    // load() é fetch-on-change (seta `loading` no início) — o effect é a ferramenta certa
    // para buscar quando applied/page mudam. Regra do React Compiler conservadora aqui.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const handleSearch = () => {
    setApplied({ ...f });
    setPage(1);
  };
  const goPage = (n: number) => setPage(n);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-gray-200 bg-white flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-gray-900">Log de erros de processamento</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            E-mails com falhas
          </p>
        </div>
        <button onClick={load} className="btn" disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          {loading ? 'Carregando…' : 'Atualizar'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <Alert variant="error" className="mb-4">
            <strong>Erro:</strong> {error}
          </Alert>
        )}

        <div className="grid grid-cols-6 gap-3 mb-5">
          {[
            { label: 'Total de erros', value: stats.total, icon: XCircle, cls: 'text-red-500' },
            { label: 'Erro de API', value: stats.counts.erro_api ?? 0, icon: XCircle, cls: 'text-red-600' },
            { label: 'Sem valor', value: stats.counts.sem_valor ?? 0, icon: AlertTriangle, cls: 'text-amber-600' },
            {
              label: 'Sem fornecedor',
              value: stats.counts.sem_fornecedor ?? 0,
              icon: AlertTriangle,
              cls: 'text-orange-600',
            },
            {
              label: 'Extração falhou',
              value: stats.counts.extracao_falhou ?? 0,
              icon: XCircle,
              cls: 'text-red-500',
            },
            {
              label: 'DB / processo',
              value: (stats.counts.db_erro ?? 0) + (stats.counts.processamento_erro ?? 0),
              icon: Info,
              cls: 'text-purple-500',
            },
          ].map(({ label, value, icon: Icon, cls }) => (
            <div key={label} className="metric-card">
              <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-1">
                <Icon size={13} className={cls} />
                {label}
              </div>
              <div className="text-xl font-semibold text-gray-900">{value}</div>
            </div>
          ))}
        </div>

        <div className="flex gap-2 mb-4 flex-wrap">
          <select id="erros-type" name="erros-type" aria-label="Filtrar por tipo de erro" className="input w-44" value={f.errorType} onChange={(e) => sf('errorType', e.target.value)}>
            <option value="">Todos os tipos</option>
            {ERROR_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            id="erros-sender"
            name="erros-sender"
            aria-label="Filtrar por remetente"
            className="input w-44"
            placeholder="Remetente…"
            value={f.sender}
            onChange={(e) => sf('sender', e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          />
          <input
            id="erros-date-from"
            name="erros-date-from"
            aria-label="Data inicial"
            type="date"
            className="input w-36"
            value={f.dateFrom}
            onChange={(e) => sf('dateFrom', e.target.value)}
            title="Data de"
          />
          <input
            id="erros-date-to"
            name="erros-date-to"
            aria-label="Data final"
            type="date"
            className="input w-36"
            value={f.dateTo}
            onChange={(e) => sf('dateTo', e.target.value)}
            title="Data até"
          />
          <button onClick={handleSearch} className="btn btn-primary">
            Buscar
          </button>
        </div>

        <div className="card overflow-hidden mb-2">
          <table className="w-full">
            <thead>
              <tr>
                {['Data/hora', 'Tipo', 'Remetente', 'Assunto', 'Arquivo', 'Mensagem de erro'].map((h) => (
                  <th key={h} className="table-header">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="table-cell text-center text-gray-500 py-8">
                    {loading ? 'Buscando registros…' : 'Nenhum erro encontrado — boas notícias!'}
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr
                    key={r.id}
                    className={rowClass(r, sel?.id)}
                    onClick={() => setSel(sel?.id === r.id ? null : r)}
                  >
                    <td className="table-cell text-xs whitespace-nowrap font-mono">{fmtDt(r.logged_at)}</td>
                    <td className="table-cell">
                      <StatusBadge value={r.error_type} />
                    </td>
                    <td className="table-cell text-xs max-w-[140px] truncate" title={r.sender_email ?? ''}>
                      {r.sender_email || '—'}
                    </td>
                    <td className="table-cell text-xs max-w-[180px] truncate" title={r.subject ?? ''}>
                      {r.subject || '—'}
                    </td>
                    <td
                      className="table-cell text-xs font-mono text-gray-500 max-w-[120px] truncate"
                      title={r.source_file ?? ''}
                    >
                      {r.source_file || '—'}
                    </td>
                    <td
                      className="table-cell text-xs max-w-[200px] truncate text-status-error-fg"
                      title={r.error_message ?? ''}
                    >
                      {r.error_message || '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between py-2 px-1 mb-4">
          <span className="text-xs text-gray-500">
            {total} registros · Página {page} de {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <button onClick={() => goPage(page - 1)} disabled={page <= 1 || loading} className="btn">
              ← Anterior
            </button>
            <button onClick={() => goPage(page + 1)} disabled={page >= totalPages || loading} className="btn">
              Próxima →
            </button>
          </div>
        </div>

        {sel && (
          <div className="card p-4">
            <p className="text-xs font-semibold text-gray-500 mb-3 uppercase tracking-wide">
              Detalhes · {fmtDt(sel.logged_at)}
            </p>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-2 mb-4">
              {(
                [
                  ['Tipo de erro', sel.error_type],
                  ['Data/hora', fmtDt(sel.logged_at)],
                  ['Remetente', sel.sender_name ? `${sel.sender_name} <${sel.sender_email}>` : sel.sender_email],
                  ['Assunto', sel.subject],
                  ['Recebido em', fmtDt(sel.received_at)],
                  ['Arquivo', sel.source_file],
                  ['Message-ID', sel.gmail_message_id],
                  ['Mensagem', sel.error_message],
                ] as [string, string | null][]
              ).map(([k, v]) => (
                <div key={k} className="flex gap-3">
                  <dt className="w-36 shrink-0 text-gray-500 text-xs">{k}</dt>
                  <dd className="text-gray-700 text-xs break-all">{v ?? '—'}</dd>
                </div>
              ))}
            </dl>
            {sel.raw_payload != null && (
              <div className="mt-2">
                <p className="text-xs text-gray-500 mb-1 uppercase tracking-wide">Payload bruto</p>
                <pre className="text-xs bg-gray-50 rounded-lg p-3 overflow-x-auto text-gray-600 whitespace-pre-wrap">
                  {JSON.stringify(sel.raw_payload, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
