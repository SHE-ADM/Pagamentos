// src/pages/Consulta.tsx
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  RefreshCw,
  Download,
  AlertCircle,
  TrendingUp,
  Clock,
  DollarSign,
  FileText,
  Search,
  X,
  Eye,
  type LucideIcon,
} from 'lucide-react';
import type { FinancialAccountControl } from '@sheild/shared';
import {
  getFinancialAccountControl,
  getFinancialStats,
  getFinancialAccountTotalValue,
  setFinancialAccountFlag,
  type FinancialStats,
} from '../services/supabase';
import { startEmailRead, getEmailReadProgress, type ReadProgress } from '../services/emailReader';
import { suspendIdleLogout, resumeIdleLogout } from '../hooks/useIdleLogout';
import { getErrorMessage } from '../lib/getErrorMessage';
import Alert from '../components/atoms/Alert';
import ExpandableText from '../components/ExpandableText';
import AttachmentViewer from '../components/AttachmentViewer';
import DataGrid from '../components/organisms/DataGrid';
import { getConsultaColumns, type ToggleFlag } from '../hooks/useGridColumns';
import { badgeLabel } from '../components/statusBadge.variants';

const fmtDate = (d: string | null): string => (d ? new Date(d + 'T00:00:00').toLocaleDateString('pt-BR') : '—');
const fmtMoney = (v: number | null): string =>
  v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtCnpj = (c: string | null): string =>
  c?.length === 14 ? `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}` : c || '—';

const PAGE_SIZE = 20;

// "Atualizar" em /consulta dispara a leitura IMAP dos últimos 7 dias (mesmo motor
// de /emails) — assim o usuário traz e-mails novos sem sair da consulta.
const REFRESH_DAYS = 7;
const PROGRESS_POLL_MS = 1500;
const GRID_REFRESH_EVERY = 5; // a cada ~7,5s recarrega o grid durante o processamento
const PROGRESS_MAX_ERRORS = 20; // ~30s sem contato com o backend → aborta o poll
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const CSV_COLS: (keyof FinancialAccountControl)[] = [
  'due_date',
  'status',
  'supplier_name',
  'supplier_cnpj',
  'document_type',
  'amount',
  'amount_charged',
  'discount',
  'other_deductions',
  'fine_interest',
  'other_additions',
  'payment_method',
  'nosso_numero',
  'extraction_source',
  'invoice_number',
  'barcode',
  'description',
  'email_body_excerpt',
  'processing_notes',
];

function exportCsv(rows: FinancialAccountControl[]) {
  const header = CSV_COLS.join(';');
  const body = rows.map((r) =>
    CSV_COLS.map((c) => `"${(r[c] ?? '').toString().replace(/"/g, '""')}"`).join(';'),
  );
  const blob = new Blob(['﻿' + [header, ...body].join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `financial_account_control_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

interface ConsultaFilters {
  supplier: string;
  docType: string;
  status: string;
  paymentMethod: string;
  dateFrom: string;
  dateTo: string;
}

const EMPTY_FILTERS: ConsultaFilters = {
  supplier: '',
  docType: '',
  status: '',
  paymentMethod: '',
  dateFrom: '',
  dateTo: '',
};

interface MetricCard {
  icon: LucideIcon;
  label: string;
  value: number;
  fmt: (v: number) => string | number;
  danger?: boolean;
  cardId?: string;
  onCardClick?: () => void;
}

export default function Consulta() {
  const [rows, setRows] = useState<FinancialAccountControl[]>([]);
  const [stats, setStats] = useState<Partial<FinancialStats>>({});
  // Soma de "Valor total" para o filtro aplicado (cards/filtros). null = sem dado ainda.
  const [filteredValue, setFilteredValue] = useState<number | null>(null);
  const [sel, setSel] = useState<FinancialAccountControl | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState<ConsultaFilters>({ ...EMPTY_FILTERS });
  const [applied, setApplied] = useState<ConsultaFilters>({ ...EMPTY_FILTERS });
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [activeCard, setActiveCard] = useState<string | null>(null);
  const [sort, setSort] = useState<{ col: string | null; dir: 'asc' | 'desc' | null }>({ col: null, dir: null });
  // Leitura IMAP disparada pelo botão "Atualizar" (busca dos últimos 7 dias).
  const [reading, setReading] = useState(false);
  const [progress, setProgress] = useState<ReadProgress | null>(null);
  const readingRef = useRef(false);
  const supplierDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sf = <K extends keyof ConsultaFilters>(k: K, v: ConsultaFilters[K]) =>
    setF((x) => ({ ...x, [k]: v }));

  // load depends on applied (snapshot do filtro no momento do Buscar) e page.
  // useEffect dispara automaticamente quando qualquer dos dois muda.
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [result, st] = await Promise.all([
        getFinancialAccountControl({
          ...applied,
          page,
          pageSize: PAGE_SIZE,
          sortCol: sort.col ?? undefined,
          sortDir: sort.dir ?? undefined,
        }),
        getFinancialStats(),
      ]);
      setRows(result.data);
      setTotal(result.total);
      setStats(st);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [applied, page, sort]);

  useEffect(() => {
    void load();
  }, [load]);

  // "Valor total" reflete o filtro aplicado (cards ou filtros manuais). Depende
  // só de `applied` — não re-soma ao paginar/ordenar. O flag `cancelled` descarta
  // respostas de filtros já trocados (evita sobrescrever com valor obsoleto).
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const v = await getFinancialAccountTotalValue(applied);
        if (!cancelled) setFilteredValue(v);
      } catch {
        if (!cancelled) setFilteredValue(null);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [applied]);

  // Marca/desmarca uma flag de curadoria ("Tem NF" / "Tem Boleto") com update
  // otimista no estado local + persistência via REST; reverte se a gravação falhar.
  const handleToggleFlag = useCallback<ToggleFlag>((row, field, value) => {
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, [field]: value } : r)));
    void setFinancialAccountFlag(row.id, field, value).catch((e: unknown) => {
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, [field]: !value } : r)));
      setError(getErrorMessage(e));
    });
  }, []);

  const columns = useMemo(() => getConsultaColumns(handleToggleFlag), [handleToggleFlag]);

  // "Atualizar": dispara a leitura IMAP dos últimos 7 dias (job em background no
  // Flask) e acompanha o progresso por poll, recarregando o grid ao vivo e no fim —
  // permite trazer e-mails novos sem abrir a página /emails. Suspende o logout por
  // inatividade durante o processamento (pode levar minutos).
  const handleRefresh = useCallback(async () => {
    if (readingRef.current) return; // já há uma leitura em andamento
    readingRef.current = true;
    setReading(true);
    setError(null);
    setProgress(null);
    suspendIdleLogout();

    try {
      await startEmailRead({ days: REFRESH_DAYS });
    } catch (e) {
      setError(getErrorMessage(e));
      readingRef.current = false;
      setReading(false);
      resumeIdleLogout();
      return;
    }

    try {
      let ticks = 0;
      let errors = 0;
      let polling = true;
      let final: ReadProgress | null = null;
      while (polling) {
        await sleep(PROGRESS_POLL_MS);
        let p: ReadProgress;
        try {
          p = await getEmailReadProgress();
          errors = 0;
        } catch {
          errors += 1;
          if (errors >= PROGRESS_MAX_ERRORS) throw new Error('Perdi contato com o backend durante o processamento.');
          continue;
        }
        setProgress(p);
        ticks += 1;
        if (ticks % GRID_REFRESH_EVERY === 0) void load(); // grid sobe ao vivo
        if (!p.running) {
          final = p;
          polling = false;
        }
      }
      if (final?.error) setError(final.error);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      readingRef.current = false;
      setReading(false);
      setProgress(null);
      resumeIdleLogout();
      await load();
    }
  }, [load]);

  // Buscar: congela filtro atual em applied e volta para pagina 1.
  // React 18 faz batch dos dois setState — gera um unico load novo.
  const handleSearch = () => {
    setApplied({ ...f });
    setActiveCard(null);
    setPage(1);
  };
  // Limpar: reseta filtros do form e a busca aplicada, voltando para pagina 1.
  const handleClear = () => {
    setF({ ...EMPTY_FILTERS });
    setApplied({ ...EMPTY_FILTERS });
    setActiveCard(null);
    setSort({ col: null, dir: null });
    setPage(1);
  };

  // Ciclo: nenhuma → asc → desc → nenhuma (volta ao padrão issue_date.desc).
  const handleSort = (col: string) => {
    setSort((prev) => {
      if (prev.col !== col) return { col, dir: 'asc' };
      if (prev.dir === 'asc') return { col, dir: 'desc' };
      return { col: null, dir: null };
    });
    setPage(1);
  };
  const goPage = (n: number) => setPage(n);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleCardFilter = (cardId: string, filterOverride: Partial<ConsultaFilters>) => {
    setSort({ col: null, dir: null });
    if (activeCard === cardId) {
      setActiveCard(null);
      setF({ ...EMPTY_FILTERS });
      setApplied({ ...EMPTY_FILTERS });
    } else {
      setActiveCard(cardId);
      const next = { ...EMPTY_FILTERS, ...filterOverride };
      setF(next);
      setApplied(next);
    }
    setPage(1);
  };

  const vencidasCount = stats.vencidas ?? 0;
  const cards: MetricCard[] = [
    { icon: DollarSign, label: 'Valor total', value: filteredValue ?? stats.totalValue ?? 0, fmt: fmtMoney },
    { icon: FileText, label: 'Total de registros', value: stats.totalRecords ?? 0, fmt: (v) => v },
    {
      icon: Clock,
      label: 'A vencer',
      value: stats.aVencer ?? 0,
      fmt: (v) => v,
      cardId: 'avencer',
      onCardClick: () => handleCardFilter('avencer', { status: 'a vencer' }),
    },
    {
      icon: TrendingUp,
      label: 'A vencer em 7 dias',
      value: stats.vencendo ?? 0,
      fmt: (v) => v,
      cardId: 'avencer7',
      onCardClick: () => {
        const t = new Date().toISOString().slice(0, 10);
        const t7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
        handleCardFilter('avencer7', { dateFrom: t, dateTo: t7 });
      },
    },
    {
      icon: AlertCircle,
      label: 'Vencidas',
      value: vencidasCount,
      fmt: (v) => v,
      danger: vencidasCount > 0,
      cardId: 'vencidas',
      onCardClick: () => handleCardFilter('vencidas', { status: 'vencido' }),
    },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Barra superior em gradiente (2px) — acento de marca */}
      <div className="h-0.5 bg-gradient-to-r from-brand to-brand-dark" />
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-slate-800">Consulta de movimentações</h1>
          <p className="text-xs text-slate-400 mt-0.5">Controle de contas a pagar</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => exportCsv(rows)} className="btn" disabled={!rows.length}>
            <Download size={14} /> Exportar página ({rows.length})
          </button>
          <button
            onClick={handleRefresh}
            className="btn"
            disabled={reading || loading}
            title="Buscar e-mails dos últimos 7 dias e atualizar a consulta"
          >
            <RefreshCw size={14} className={reading || loading ? 'animate-spin' : ''} />
            Atualizar
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <Alert variant="error" className="mb-4">
            <strong>Erro:</strong> {error}
          </Alert>
        )}

        {reading && (
          <Alert variant="info" className="mb-4">
            Buscando e-mails dos últimos 7 dias…
            {progress && progress.total > 0 ? ` (${progress.done}/${progress.total})` : ''}
          </Alert>
        )}

        <div className="flex gap-3 mb-5 flex-wrap">
          {cards.map(({ icon: Icon, label, value, fmt, danger, cardId, onCardClick }) => {
            const isActive = !!cardId && activeCard === cardId;
            const borderLeft = danger ? 'border-l-status-error-solid' : 'border-l-brand';
            let cardBg = 'bg-white';
            if (isActive) {
              cardBg = danger ? 'bg-status-error-bg ring-1 ring-status-error-border/40' : 'bg-brand/5 ring-1 ring-brand/30';
            }
            const interactive = onCardClick ? 'cursor-pointer hover:shadow-md hover:scale-[1.01]' : '';
            const iconCls = danger ? 'bg-status-error-solid/10 text-status-error-fg' : 'bg-brand/10 text-brand';
            const valueCls = danger ? 'text-status-error-fg' : 'text-slate-800';
            return (
              <div
                key={label}
                role={onCardClick ? 'button' : undefined}
                tabIndex={onCardClick ? 0 : undefined}
                onClick={onCardClick}
                onKeyDown={onCardClick ? (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') onCardClick(); } : undefined}
                className={`flex-1 min-w-[160px] flex items-center gap-3 rounded-xl shadow-sm border border-slate-100 border-l-4 px-4 py-3 animate-fade-in-up transition-all ${borderLeft} ${cardBg} ${interactive}`}
              >
                <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full ${iconCls}`}>
                  <Icon size={18} />
                </div>
                <div className="min-w-0">
                  <div className={`text-2xl font-bold leading-tight ${valueCls}`}>
                    {fmt(value)}
                  </div>
                  <div className="text-xs text-slate-500 truncate">{label}</div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="relative bg-white rounded-xl shadow-sm border border-slate-100 p-4 mb-4">
          <span className="absolute left-4 top-2 text-xs uppercase tracking-widest text-slate-400">
            Filtros
          </span>
          <div className="flex gap-2 flex-wrap pt-4">
            <div className="relative w-[22.5rem] max-w-full">
              <input
                id="consulta-supplier"
                name="consulta-supplier"
                aria-label="Buscar por fornecedor, CNPJ, número do documento, assunto, remetente ou e-mail do fornecedor"
                className="input w-full pr-8"
                placeholder="Fornecedor, CNPJ, Nº doc, assunto, remetente ou e-mail…"
                value={f.supplier}
                onChange={(e) => {
                  const val = e.target.value;
                  sf('supplier', val);
                  if (supplierDebounce.current) clearTimeout(supplierDebounce.current);
                  supplierDebounce.current = setTimeout(() => {
                    setApplied((prev) => ({ ...prev, supplier: val }));
                    setPage(1);
                  }, 350);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (supplierDebounce.current) clearTimeout(supplierDebounce.current);
                    handleSearch();
                  }
                }}
              />
              {f.supplier && (
                <button
                  type="button"
                  aria-label="Limpar busca"
                  onClick={() => {
                    if (supplierDebounce.current) clearTimeout(supplierDebounce.current);
                    sf('supplier', '');
                    setApplied((prev) => ({ ...prev, supplier: '' }));
                    setPage(1);
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <select id="consulta-doc-type" name="consulta-doc-type" aria-label="Filtrar por tipo de documento" className="input w-40" value={f.docType} onChange={(e) => sf('docType', e.target.value)}>
              <option value="">Tipo Documento</option>
              {['darf','das','dae','dam / duam','gare','gnre','gps','gru','iss','iptu','ipva','itbi','pix','tributo','boleto','cte','nfe','nfse','recibo','seguro','outro'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <select id="consulta-payment-method" name="consulta-payment-method" aria-label="Filtrar por tipo de pagamento" className="input w-36" value={f.paymentMethod} onChange={(e) => sf('paymentMethod', e.target.value)}>
              <option value="">Tipo Pagamento</option>
              {['boleto','pix','ted','cartão','depósito','duplicata','bancário','carteira','vale','crédito','débito','dinheiro','transferência','cheque','outro'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <select id="consulta-status" name="consulta-status" aria-label="Filtrar por situação" className="input w-32" value={f.status} onChange={(e) => sf('status', e.target.value)}>
              <option value="">Situação</option>
              {['pendente', 'a vencer', 'vencido', 'prorrogado', 'baixado', 'protestado', 'cartório', 'pago', 'cancelado', 'falha'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <input
              id="consulta-date-from"
              name="consulta-date-from"
              aria-label="Vencimento inicial"
              type="date"
              className="input w-36"
              value={f.dateFrom}
              onChange={(e) => sf('dateFrom', e.target.value)}
              title="Vencimento de"
            />
            <input
              id="consulta-date-to"
              name="consulta-date-to"
              aria-label="Vencimento final"
              type="date"
              className="input w-36"
              value={f.dateTo}
              onChange={(e) => sf('dateTo', e.target.value)}
              title="Vencimento até"
            />
            <button onClick={handleSearch} className="btn btn-primary w-24">
              <Search size={14} /> Buscar
            </button>
            <button onClick={handleClear} className="btn w-24 justify-center">
              Limpar
            </button>
          </div>
        </div>

        <div className="card mb-2">
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(r) => String(r.id)}
            selectedId={sel ? String(sel.id) : null}
            onRowClick={(r) => setSel(sel?.id === r.id ? null : r)}
            sortCol={sort.col}
            sortDir={sort.dir}
            onSort={handleSort}
            gridId="consulta"
            enableColumnManagement
            enableSelection
            onExportSelected={exportCsv}
            maxBodyHeight="62vh"
            loading={loading}
            emptyMessage={loading ? 'Buscando registros…' : 'Nenhum registro encontrado — ajuste os filtros e clique em Buscar'}
            renderDetail={(r) => (
                          <div className="relative bg-slate-50/60 border-l-2 border-brand p-4">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setSel(null);
                              }}
                              className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full text-slate-400 hover:bg-slate-200/60 hover:text-slate-600 transition-colors"
                              title="Fechar"
                            >
                              <X size={15} />
                            </button>
                            <p className="text-xs font-semibold text-slate-500 mb-3 uppercase tracking-wide pr-8">
                              Detalhes — {r.supplier_name || 'registro'} · {fmtDate(r.due_date)}
                            </p>
                            {r.source_file && (
                              <div className="mb-3">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setViewing(r.source_file);
                                  }}
                                  className="btn btn-primary"
                                  title="Ver o PDF anexado"
                                >
                                  <Eye size={14} /> Ver anexo
                                </button>
                              </div>
                            )}
                            <dl className="grid grid-cols-2 rounded-lg overflow-hidden border border-slate-100">
                              {(
                                [
                                  ['Fornecedor', r.supplier_name],
                                  ['Assunto', r.subject],
                                  ['Remetente', r.sender_email],
                                  ['CNPJ', fmtCnpj(r.supplier_cnpj)],
                                  ['N° Documento', r.invoice_number],
                                  ['Competência', r.competence_date],
                                  ['Emissão', fmtDate(r.issue_date)],
                                  ['Vencimento', fmtDate(r.due_date)],
                                  ['Situação', r.status],
                                  ['Valor do documento', fmtMoney(r.amount)],
                                  ['Valor cobrado', fmtMoney(r.amount_charged)],
                                  ['Desconto / abatimentos', fmtMoney(r.discount)],
                                  ['Outras deduções', fmtMoney(r.other_deductions)],
                                  ['Mora / multa', fmtMoney(r.fine_interest)],
                                  ['Outros acréscimos', fmtMoney(r.other_additions)],
                                  ['Nosso número', r.nosso_numero || '—'],
                                  ['Forma de pag.', r.payment_method],
                                  ['Código de barras', r.barcode || '—'],
                                  ['Extração', r.extraction_source ? badgeLabel(r.extraction_source) : null],
                                  ['Origem', r.source_file],
                                  ['Observações', r.processing_notes || '—'],
                                ] as [string, string | null][]
                              ).map(([k, v], i) => (
                                <div
                                  key={k}
                                  className={`flex gap-3 px-3 py-1.5 ${
                                    Math.floor(i / 2) % 2 === 0 ? 'bg-slate-50/30' : 'bg-white'
                                  }`}
                                >
                                  <dt className="w-36 flex-shrink-0 text-slate-400 text-xs">{k}</dt>
                                  <dd className="text-slate-700 text-xs break-all">{v ?? '—'}</dd>
                                </div>
                              ))}
                            </dl>
                            {r.description && (
                              <div className="mt-3 p-3 bg-white rounded-lg border border-slate-100">
                                <span className="badge bg-brand/10 text-brand mb-2">Descrição</span>
                                <p className="text-xs text-slate-600">{r.description}</p>
                              </div>
                            )}
                            {r.email_body_excerpt && (
                              <div className="mt-3 p-3 bg-white rounded-lg border border-slate-100">
                                <span className="badge bg-brand/10 text-brand mb-2">Mensagem do e-mail</span>
                                <ExpandableText text={r.email_body_excerpt} />
                              </div>
                            )}
                          </div>
            )}
          />
        </div>

        <div className="flex items-center justify-between py-2 px-1 mb-4">
          <span className="text-xs text-slate-500">{total} registros</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => goPage(page - 1)}
              disabled={page <= 1 || loading}
              className="btn disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ← Anterior
            </button>
            <span className="badge bg-slate-100 text-slate-600">
              Página {page} de {totalPages}
            </span>
            <button
              onClick={() => goPage(page + 1)}
              disabled={page >= totalPages || loading}
              className="btn disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Próxima →
            </button>
          </div>
        </div>
      </div>

      {viewing && <AttachmentViewer sourceFile={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
