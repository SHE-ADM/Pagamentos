// src/pages/Emails.tsx
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { RefreshCw, Mail, FileCheck, AlertCircle, CopyMinus, Inbox, Ban, CalendarDays, X, Eye } from 'lucide-react';
import type { EmailControl, FinancialAccountControl } from '@sheild/shared';
import { getEmailControl, getEmailStats, getAccountsByMessageId, getInvoiceNumbersByMessageIds, type EmailStats } from '../services/supabase';
import { triggerEmailRead } from '../services/emailReader';
import { suspendIdleLogout, resumeIdleLogout } from '../hooks/useIdleLogout';
import { getEmailColumns } from '../hooks/useGridColumns';
import { getErrorMessage } from '../lib/getErrorMessage';
import { getStatusExplanation } from '../lib/getStatusExplanation';
import StatusBadge from '../components/StatusBadge';
import Alert from '../components/atoms/Alert';
import AttachmentViewer from '../components/AttachmentViewer';
import ExpandableText from '../components/ExpandableText';
import DataGrid from '../components/organisms/DataGrid';

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
  v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

interface EmailFilters {
  status: string;
  sender: string;
  days: number;
  hasAttachment?: boolean;
  pdfExtracted?: boolean;
}

const EMPTY_FILTERS: EmailFilters = { status: '', sender: '', days: 7 };

// Teto de linhas da tabela: janela ampla (all-time, days=0) carrega mais para a
// Busca Geral exibir tudo; janela curta (com filtro de data) mantém o teto menor.
const TABLE_LIMIT_DEFAULT = 200;
const TABLE_LIMIT_ALL_TIME = 1000;

export default function Emails() {
  const [rows, setRows] = useState<EmailControl[]>([]);
  const [stats, setStats] = useState<Partial<EmailStats>>({});
  const [sel, setSel] = useState<EmailControl | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [readMode, setReadMode] = useState<'novos' | 'geral' | null>(null);
  const [readMsg, setReadMsg] = useState<string | null>(null);
  const [readElapsed, setReadElapsed] = useState(0);
  const [accounts, setAccounts] = useState<FinancialAccountControl[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [filters, setFilters] = useState<EmailFilters>({ ...EMPTY_FILTERS });
  const [activeCard, setActiveCard] = useState<string | null>(null);
  const [readDays, setReadDays] = useState<number>(7);
  const [viewing, setViewing] = useState<string | null>(null);
  const [invoiceMap, setInvoiceMap] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const limit = filters.days ? TABLE_LIMIT_DEFAULT : TABLE_LIMIT_ALL_TIME;
      const [data, st] = await Promise.all([
        getEmailControl({ ...filters, limit }),
        getEmailStats(),
      ]);
      setRows(data);
      setStats(st);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  // Popula o mapa de nº documento para todas as linhas da página atual.
  useEffect(() => {
    const ids = rows.map((r) => r.message_id).filter((id): id is string => Boolean(id));
    if (!ids.length) { setInvoiceMap({}); return; }
    getInvoiceNumbersByMessageIds(ids)
      .then(setInvoiceMap)
      .catch(() => setInvoiceMap({}));
  }, [rows]);

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
  // mode='novos' → IMAP UNSEEN (apenas não lidos)
  // mode='geral' → IMAP SINCE N dias (usa o filtro de período da tabela)
  const handleRead = async (mode: 'novos' | 'geral') => {
    setReading(true);
    setReadMode(mode);
    setError(null);
    setReadMsg(null);
    setReadElapsed(0);
    // Suspende o logout por inatividade enquanto processa — o usuário pode ficar
    // ocioso durante vários minutos de extração sem ser deslogado.
    suspendIdleLogout();

    // Alinha a janela da tabela ao período buscado, senão a tabela continuaria no
    // filtro padrão de 7 dias e pareceria "trazer poucos e-mails" mesmo após uma
    // busca ampla. readDays=0 (Busca Geral) → days=0 → tabela sem filtro de data
    // (todos os períodos). 7/15/30 → mesma janela da busca.
    if (mode === 'geral') {
      setActiveCard(null);
      setFilters({ status: '', sender: '', days: readDays });
    }

    const start = Date.now();
    pollRef.current = setInterval(() => {
      setReadElapsed(Math.floor((Date.now() - start) / 1000));
      void load();
    }, 20_000);

    try {
      const days = mode === 'novos' ? 0 : readDays;
      const all = mode === 'geral' && readDays === 0;
      const s = await triggerEmailRead({ days, all });
      let criterio = 'não lidos';
      if (mode === 'geral') {
        criterio = readDays === 0 ? 'todos os e-mails' : `últimos ${readDays} dias`;
      }
      const abortAviso = s.api_aborted
        ? ' ⚠️ Processamento interrompido por limite da API — rode novamente para continuar.'
        : '';
      setReadMsg(
        `Busca concluída (${criterio}) — ${s.found} no servidor · ` +
          `${s.processed} financeiro(s) extraído(s) · ${s.skipped_keyword} ignorado(s) · ` +
          `${s.skipped_dup} duplicado(s).${abortAviso}`,
      );
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      resumeIdleLogout();
      setReading(false);
      setReadMode(null);
      setReadElapsed(0);
      await load();
    }
  };

  const setF = <K extends keyof EmailFilters>(k: K, v: EmailFilters[K]) =>
    setFilters((f) => ({ ...f, [k]: v }));

  // Ciclo de toggle: clique no mesmo card limpa o filtro; clique diferente aplica.
  // days: 0 mostra todos os períodos, alinhando com os totais dos KPIs (all-time).
  const handleCardFilter = (cardId: string, filterOverride: Partial<EmailFilters>) => {
    if (activeCard === cardId) {
      setActiveCard(null);
      setFilters({ ...EMPTY_FILTERS });
    } else {
      setActiveCard(cardId);
      setFilters({ ...EMPTY_FILTERS, days: 0, ...filterOverride });
    }
  };

  // Rótulos extraídos para evitar ternários aninhados no JSX (SonarLint S3358/S4624).
  const processingLabel = readElapsed > 0 ? `Processando (${readElapsed}s)` : 'Processando…';
  const labelNovos = readMode === 'novos' ? processingLabel : 'Busca Novos';
  const labelGeralBtn = readMode === 'geral' ? processingLabel : 'Executar';

  // Colunas do grid resolvidas com o mapa de nº documento (message_id → nº).
  const emailColumns = useMemo(() => getEmailColumns(invoiceMap), [invoiceMap]);

  return (
    <div className="flex flex-col h-full">
      <div className="h-0.5 bg-gradient-to-r from-brand to-brand-dark" />
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-slate-800">Recebimento de e-mails</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            {import.meta.env.VITE_IMAP_USER ?? 'Caixa IMAP'}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => handleRead('novos')} className="btn btn-primary" disabled={reading || loading}>
            <Inbox size={14} className={readMode === 'novos' ? 'animate-pulse' : ''} />
            {labelNovos}
          </button>
          <div className="flex mx-2">
            <select
              id="emails-read-days"
              name="emails-read-days"
              aria-label="Período da Busca Geral"
              className="input rounded-r-none border-r-0 w-44 text-sm"
              value={readDays}
              onChange={(e) => setReadDays(+e.target.value)}
              disabled={reading || loading}
            >
              <option value={7}>Busca Geral (7d)</option>
              <option value={15}>Busca Geral (15d)</option>
              <option value={30}>Busca Geral (30d)</option>
              <option value={0}>Busca Geral</option>
            </select>
            <button
              onClick={() => handleRead('geral')}
              className="btn rounded-l-none"
              disabled={reading || loading}
            >
              <CalendarDays size={14} className={readMode === 'geral' ? 'animate-pulse' : ''} />
              {labelGeralBtn}
            </button>
          </div>
          <button onClick={load} className="btn" disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Carregando…' : 'Atualizar'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <Alert variant="error" className="mb-4">
            <strong>Erro:</strong> {error}
          </Alert>
        )}

        {readMsg && (
          <Alert variant="success" className="mb-4">
            {readMsg}
          </Alert>
        )}

        <div className="grid grid-cols-6 gap-3 mb-5">
          {[
            {
              icon: Mail,
              label: 'Total de e-mails',
              value: stats.total ?? 0,
              sub: 'na caixa (email_control)',
              cardId: 'total',
              filter: {},
            },
            {
              icon: FileCheck,
              label: 'Extraídos',
              value: stats.extraido ?? 0,
              sub: 'conta via PDF',
              cardId: 'extraido',
              filter: { status: 'extraído' },
            },
            {
              icon: Inbox,
              label: 'Recebidos',
              value: stats.recebido ?? 0,
              sub: 'conta via corpo',
              cardId: 'recebido',
              filter: { status: 'recebido' },
            },
            {
              icon: CopyMinus,
              label: 'Pendente',
              value: stats.pendente ?? 0,
              sub: 'PDF salvo, sem extração',
              cardId: 'pendente',
              filter: { status: 'pendente' },
            },
            {
              icon: AlertCircle,
              label: 'Falha',
              value: stats.falha ?? 0,
              sub: 'sem conta — revisão',
              cardId: 'falha',
              filter: { status: 'falha' },
            },
            {
              icon: Ban,
              label: 'Ignorados',
              value: stats.ignorado ?? 0,
              sub: 'não-financeiro',
              cardId: 'ignorado',
              filter: { status: 'ignorado' },
            },
          ].map(({ icon: Icon, label, value, sub, cardId, filter }) => {
            const isActive = activeCard === cardId;
            const cardRing = isActive ? 'ring-1 ring-brand/30 bg-brand/5' : '';
            const labelCls = isActive ? 'text-brand' : 'text-gray-500';
            const valueCls = isActive ? 'text-brand' : 'text-gray-900';
            return (
              <button
                key={label}
                type="button"
                onClick={() => handleCardFilter(cardId, filter)}
                className={`metric-card w-full text-left cursor-pointer select-none transition-all hover:shadow-md hover:scale-[1.01] ${cardRing}`}
              >
                <div className={`flex items-center gap-1.5 text-xs mb-1 ${labelCls}`}>
                  <Icon size={13} />
                  {label}
                </div>
                <div className={`text-2xl font-semibold ${valueCls}`}>{value}</div>
                <div className="text-xs text-gray-400">{sub}</div>
              </button>
            );
          })}
        </div>

        <div className="flex gap-2 mb-4">
          <div className="relative w-[22.5rem] max-w-full">
            <input
              id="emails-search"
              name="emails-search"
              aria-label="Buscar por remetente, assunto ou número do documento"
              className="input w-full pr-8"
              placeholder="Remetente, assunto ou Nº doc…"
              value={filters.sender}
              onChange={(e) => setF('sender', e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load()}
            />
            {filters.sender && (
              <button
                type="button"
                aria-label="Limpar busca"
                onClick={() => setF('sender', '')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <select id="emails-status" name="emails-status" aria-label="Filtrar por status" className="input w-40" value={filters.status} onChange={(e) => setF('status', e.target.value)}>
            <option value="">Todos os status</option>
            {['extraído', 'recebido', 'pendente', 'falha', 'ignorado'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            id="emails-days"
            name="emails-days"
            aria-label="Filtrar por período"
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
          <DataGrid
            columns={emailColumns}
            rows={rows}
            rowKey={(r) => String(r.id)}
            selectedId={sel ? String(sel.id) : null}
            onRowClick={(r) => setSel(sel?.id === r.id ? null : r)}
            sortCol={null}
            sortDir={null}
            onSort={() => undefined}
            loading={loading}
            emptyMessage={loading ? 'Buscando registros…' : 'Nenhum e-mail encontrado com os filtros aplicados'}
            ariaLabel="Recebimento de e-mails"
            variant="silver"
            renderDetail={(r) => {
                          const explanation = getStatusExplanation(r);
                          return (
                          <div className="relative bg-zinc-50/60 border-l-2 border-brand p-4">
                            <button
                              onClick={(e) => { e.stopPropagation(); setSel(null); }}
                              className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-200/60 hover:text-zinc-600 transition-colors"
                              title="Fechar"
                            >
                              <X size={15} />
                            </button>
                            <p className="text-xs font-semibold text-zinc-500 mb-3 uppercase tracking-wide pr-8">
                              Detalhes — {r.sender_name || r.sender_email} · {fmt(r.received_at)}
                            </p>
                            {explanation && (
                              <Alert variant={explanation.variant} className="mb-3 text-xs">
                                <strong>{explanation.title}</strong> {explanation.message}
                              </Alert>
                            )}
                            {r.has_attachment && r.attachment_names && (
                              <div className="mb-3 flex flex-wrap gap-2">
                                {r.attachment_names.split(',').map((f) => f.trim()).filter(Boolean).map((f) => (
                                  <button
                                    key={f}
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); setViewing(f); }}
                                    className="btn btn-primary"
                                    title={`Ver anexo: ${f}`}
                                  >
                                    <Eye size={14} /> {f}
                                  </button>
                                ))}
                              </div>
                            )}
                            <dl className="grid grid-cols-2 rounded-lg overflow-hidden border border-zinc-100">
                              {(
                                [
                                  ['Message-ID', r.message_id],
                                  ['Remetente', `${r.sender_name} <${r.sender_email}>`],
                                  ['Assunto', r.subject],
                                  ['Recebido em', fmt(r.received_at)],
                                  ['Palavra-chave', r.keyword_matched],
                                  ['Anexos PDF', r.attachment_names || '—'],
                                  ['CSV gerado', r.extraction_csv || '—'],
                                  ['Observações', r.notes || '—'],
                                ] as [string, string | null][]
                              ).map(([k, v], i) => (
                                <div
                                  key={k}
                                  className={`flex gap-3 px-3 py-1.5 ${
                                    Math.floor(i / 2) % 2 === 0 ? 'bg-zinc-50/40' : 'bg-white'
                                  }`}
                                >
                                  <dt className="w-28 flex-shrink-0 text-zinc-400 text-xs">{k}</dt>
                                  <dd className="text-zinc-600 text-xs break-all">{v ?? '—'}</dd>
                                </div>
                              ))}
                            </dl>
                            <div className="mt-3">
                              <p className="text-xs text-zinc-400 mb-2 uppercase tracking-wide">
                                Conta(s) registrada(s) — financial_account_control
                              </p>
                              {accounts.length === 0 ? (
                                <p className="text-xs text-zinc-400">Nenhuma conta gerada a partir deste e-mail.</p>
                              ) : (
                                <div className="space-y-1.5">
                                  {accounts.map((a) => (
                                    <div
                                      key={a.id}
                                      className="flex items-center justify-between gap-3 p-2 bg-white rounded-lg border border-zinc-100 text-xs"
                                    >
                                      <span className="truncate text-zinc-600 flex-1" title={a.supplier_name ?? ''}>
                                        {a.supplier_name || '—'}
                                      </span>
                                      <span className="font-mono text-zinc-400 whitespace-nowrap">{fmtDate(a.due_date)}</span>
                                      <span className="font-mono font-medium text-zinc-600 whitespace-nowrap">
                                        {fmtMoney(a.amount)}
                                      </span>
                                      <StatusBadge value={a.due_status} />
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                            {(accounts[0]?.email_body_excerpt ?? r.body_preview) && (
                              <div className="mt-3 p-3 bg-white rounded-lg border border-zinc-100">
                                <span className="badge bg-brand/10 text-brand mb-2">Corpo do e-mail</span>
                                <ExpandableText text={accounts[0]?.email_body_excerpt ?? r.body_preview} />
                              </div>
                            )}
                          </div>
                          );
            }}
          />
        </div>

      </div>
      {viewing && <AttachmentViewer sourceFile={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
