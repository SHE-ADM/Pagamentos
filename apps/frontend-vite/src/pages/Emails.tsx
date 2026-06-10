// src/pages/Emails.tsx
import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Mail, FileCheck, AlertCircle, CopyMinus, Inbox, CheckCircle2 } from 'lucide-react';
import type { EmailControl, FinancialEmail } from '@sheild/shared';
import { getEmailControl, getEmailStats, getAccountsByMessageId, type EmailStats } from '../services/supabase';
import { triggerEmailRead } from '../services/emailReader';
import { getErrorMessage } from '../lib/getErrorMessage';
import StatusBadge from '../components/StatusBadge';

const fmt = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
const fmtDate = (d: string | null): string => (d ? new Date(d + 'T00:00:00').toLocaleDateString('pt-BR') : '—');
const fmtMoney = (v: number | null): string =>
  v != null ? Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—';

interface EmailFilters {
  status: string;
  sender: string;
  days: number;
}

export default function Emails() {
  const [rows, setRows] = useState<EmailControl[]>([]);
  const [stats, setStats] = useState<Partial<EmailStats>>({});
  const [sel, setSel] = useState<EmailControl | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [readMsg, setReadMsg] = useState<string | null>(null);
  const [readElapsed, setReadElapsed] = useState(0);
  const [accounts, setAccounts] = useState<FinancialEmail[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [filters, setFilters] = useState<EmailFilters>({ status: '', sender: '', days: 30 });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, st] = await Promise.all([getEmailControl(filters), getEmailStats()]);
      setRows(data);
      setStats(st);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  // Carrega a(s) conta(s) registrada(s) ligada(s) ao e-mail selecionado.
  useEffect(() => {
    if (!sel?.message_id) {
      setAccounts([]);
      return;
    }
    getAccountsByMessageId(sel.message_id)
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, [sel]);

  // Dispara a leitura IMAP no backend.
  // Como o processamento pode levar vários minutos, faz polling automático
  // da tabela a cada 20 s enquanto aguarda a resposta do Flask.
  const handleRead = async () => {
    setReading(true);
    setError(null);
    setReadMsg(null);
    setReadElapsed(0);

    const start = Date.now();

    // Atualiza o contador de tempo e recarrega a tabela a cada 20 s
    pollRef.current = setInterval(() => {
      setReadElapsed(Math.floor((Date.now() - start) / 1000));
      load();
    }, 20_000);

    try {
      // days: 0 → critério IMAP "UNSEEN" (apenas não lidos).
      // filters.days controla só o período exibido na tabela — não o IMAP.
      const s = await triggerEmailRead({ days: 0 });
      setReadMsg(
        `Busca concluída — ${s.found} e-mail(s) no servidor, ` +
          `${s.processed} novo(s) processado(s), ${s.skipped_dup} duplicado(s).`,
      );
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      setReading(false);
      setReadElapsed(0);
      await load();
    }
  };

  const setF = <K extends keyof EmailFilters>(k: K, v: EmailFilters[K]) =>
    setFilters((f) => ({ ...f, [k]: v }));

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-gray-200 bg-white flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-gray-900">Recebimento de e-mails</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Monitoramento da caixa IMAP — registros em email_control
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleRead} className="btn btn-primary" disabled={reading || loading}>
            <Inbox size={14} className={reading ? 'animate-pulse' : ''} />
            {reading
              ? `Processando${readElapsed > 0 ? ` (${readElapsed}s)` : '…'}`
              : 'Buscar e-mails novos'}
          </button>
          <button onClick={load} className="btn" disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Carregando…' : 'Atualizar'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex gap-2">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            <span>
              <strong>Erro:</strong> {error}
            </span>
          </div>
        )}

        {readMsg && (
          <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700 flex gap-2">
            <CheckCircle2 size={16} className="flex-shrink-0 mt-0.5" />
            <span>{readMsg}</span>
          </div>
        )}

        <div className="grid grid-cols-4 gap-3 mb-5">
          {[
            { icon: Mail, label: 'Total processados', value: stats.total ?? 0, sub: 'no email_control' },
            { icon: FileCheck, label: 'PDFs extraídos', value: stats.extracted ?? 0, sub: 'com sucesso' },
            { icon: AlertCircle, label: 'Sem anexo PDF', value: stats.semPdf ?? 0, sub: 'revisão manual' },
            {
              icon: CopyMinus,
              label: 'Só recebidos',
              value: (stats.total ?? 0) - (stats.extracted ?? 0) - (stats.semPdf ?? 0),
              sub: 'aguardando',
            },
          ].map(({ icon: Icon, label, value, sub }) => (
            <div key={label} className="metric-card">
              <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-1">
                <Icon size={13} />
                {label}
              </div>
              <div className="text-2xl font-semibold text-gray-900">{value}</div>
              <div className="text-xs text-gray-400">{sub}</div>
            </div>
          ))}
        </div>

        <div className="flex gap-2 mb-4">
          <input
            className="input max-w-xs"
            placeholder="Remetente ou assunto…"
            value={filters.sender}
            onChange={(e) => setF('sender', e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
          />
          <select className="input w-40" value={filters.status} onChange={(e) => setF('status', e.target.value)}>
            <option value="">Todos os status</option>
            {['extracted', 'downloaded', 'received', 'error', 'ignored'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            className="input w-36"
            value={filters.days}
            onChange={(e) => setF('days', +e.target.value)}
          >
            <option value={7}>7 dias</option>
            <option value={30}>30 dias</option>
            <option value={90}>90 dias</option>
            <option value={0}>Todos</option>
          </select>
          <button onClick={load} className="btn btn-primary">
            Buscar
          </button>
        </div>

        <div className="card overflow-hidden mb-4">
          <table className="w-full">
            <thead>
              <tr>
                {['Recebido', 'Remetente', 'Assunto', 'Keyword', 'PDF', 'Extração', 'Status'].map((h) => (
                  <th key={h} className="table-header">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="table-cell text-center text-gray-400 py-8">
                    {loading ? 'Carregando registros…' : 'Nenhum e-mail encontrado com os filtros aplicados'}
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr
                    key={r.id}
                    className={`cursor-pointer hover:bg-gray-50 ${sel?.id === r.id ? 'bg-brand-light/40' : ''}`}
                    onClick={() => setSel(sel?.id === r.id ? null : r)}
                  >
                    <td className="table-cell text-xs text-gray-500 whitespace-nowrap">{fmt(r.received_at)}</td>
                    <td className="table-cell text-xs max-w-[140px] truncate" title={r.sender_email ?? ''}>
                      {r.sender_name || r.sender_email}
                    </td>
                    <td className="table-cell text-xs max-w-[200px] truncate" title={r.subject ?? ''}>
                      {r.subject}
                    </td>
                    <td className="table-cell">
                      <StatusBadge value={r.keyword_matched} />
                    </td>
                    <td className="table-cell text-center">
                      {r.has_attachment ? '✓' : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="table-cell">
                      {r.pdf_extracted ? (
                        <StatusBadge value="extracted" />
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="table-cell">
                      <StatusBadge value={r.status} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {sel && (
          <div className="card p-4">
            <p className="text-xs font-semibold text-gray-500 mb-3 uppercase tracking-wide">
              Detalhes do e-mail selecionado
            </p>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
              {(
                [
                  ['Message-ID', sel.message_id],
                  ['Remetente', `${sel.sender_name} <${sel.sender_email}>`],
                  ['Assunto', sel.subject],
                  ['Recebido em', fmt(sel.received_at)],
                  ['Palavra-chave', sel.keyword_matched],
                  ['Anexos PDF', sel.attachment_names || '—'],
                  ['CSV gerado', sel.extraction_csv || '—'],
                  ['Observações', sel.notes || '—'],
                ] as [string, string | null][]
              ).map(([k, v]) => (
                <div key={k} className="flex gap-3">
                  <dt className="w-28 flex-shrink-0 text-gray-400 text-xs">{k}</dt>
                  <dd className="text-gray-700 text-xs break-all">{v}</dd>
                </div>
              ))}
            </dl>

            <div className="mt-4">
              <p className="text-[10px] text-gray-400 mb-2 uppercase tracking-wide">
                Conta(s) registrada(s) — financial_emails
              </p>
              {accounts.length === 0 ? (
                <p className="text-xs text-gray-400">Nenhuma conta gerada a partir deste e-mail.</p>
              ) : (
                <div className="space-y-1.5">
                  {accounts.map((a) => (
                    <div
                      key={a.id}
                      className="flex items-center justify-between gap-3 p-2 bg-gray-50 rounded-lg text-xs"
                    >
                      <span className="truncate text-gray-700 flex-1" title={a.supplier_name ?? ''}>
                        {a.supplier_name || '—'}
                      </span>
                      <span className="font-mono text-gray-500 whitespace-nowrap">{fmtDate(a.due_date)}</span>
                      <span className="font-mono font-medium text-gray-700 whitespace-nowrap">
                        {fmtMoney(a.amount)}
                      </span>
                      <StatusBadge value={a.due_status} />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {sel.body_preview && (
              <div className="mt-3 p-3 bg-gray-50 rounded-lg">
                <p className="text-[10px] text-gray-400 mb-1 uppercase tracking-wide">Preview do corpo</p>
                <p className="text-xs text-gray-600 leading-relaxed">{sel.body_preview}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
