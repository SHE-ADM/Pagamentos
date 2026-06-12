// src/pages/Consulta.tsx
import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
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
  Inbox,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  type LucideIcon,
} from 'lucide-react';
import type { FinancialAccountControl } from '@sheild/shared';
import { getFinancialAccountControl, getFinancialStats, type FinancialStats } from '../services/supabase';
import { getErrorMessage } from '../lib/getErrorMessage';
import StatusBadge from '../components/StatusBadge';
import ExpandableText from '../components/ExpandableText';
import AttachmentViewer from '../components/AttachmentViewer';

const fmtDate = (d: string | null): string => (d ? new Date(d + 'T00:00:00').toLocaleDateString('pt-BR') : '—');
const fmtMoney = (v: number | null): string =>
  v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtCnpj = (c: string | null): string =>
  c?.length === 14 ? `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}` : c || '—';
const fmtCpf = (c: string | null): string =>
  c?.length === 11 ? `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}` : c || '—';
const fmtCnpjOrCpf = (cnpj: string | null, cpf: string | null): string =>
  cpf != null && cpf !== '' ? fmtCpf(cpf) : fmtCnpj(cnpj);

const PAGE_SIZE = 20;

const SORT_COLS: Record<string, string> = {
  'Nº Documento':   'invoice_number',
  'Emissão':        'issue_date',
  'Fornecedor':     'supplier_name',
  'CNPJ ou CPF':    'supplier_cnpj',
  'Tipo Documento': 'document_type',
  'Tipo Pagamento': 'payment_method',
  'Vencimento':     'due_date',
  'Valor':          'amount',
  'Situação':       'due_status',
  'Extração':       'extraction_source',
};

const CSV_COLS: (keyof FinancialAccountControl)[] = [
  'due_date',
  'due_status',
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
  'status',
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
  dueStatuses?: string[];
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
    { icon: DollarSign, label: 'Valor total', value: stats.totalValue ?? 0, fmt: fmtMoney },
    { icon: FileText, label: 'Total de registros', value: stats.totalRecords ?? 0, fmt: (v) => v },
    {
      icon: Clock,
      label: 'Pendentes',
      value: stats.pending ?? 0,
      fmt: (v) => v,
      cardId: 'pendentes',
      onCardClick: () => handleCardFilter('pendentes', { status: 'pendente' }),
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
      onCardClick: () => handleCardFilter('vencidas', { dueStatuses: ['vencido'] }),
    },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Barra superior em gradiente (2px) — acento de marca */}
      <div className="h-0.5 bg-gradient-to-r from-brand to-brand-dark" />
      <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-slate-800">Consulta de movimentações</h1>
          <p className="text-xs text-slate-400 mt-0.5">Contas a pagar — tabela financial_account_control</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => exportCsv(rows)} className="btn" disabled={!rows.length}>
            <Download size={14} /> Exportar página ({rows.length})
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

        <div className="flex gap-3 mb-5 flex-wrap">
          {cards.map(({ icon: Icon, label, value, fmt, danger, cardId, onCardClick }) => {
            const isActive = !!cardId && activeCard === cardId;
            const borderLeft = danger ? 'border-l-red-500' : 'border-l-brand';
            let cardBg = 'bg-white';
            if (isActive) {
              cardBg = danger ? 'bg-red-50 ring-1 ring-red-300/40' : 'bg-brand/5 ring-1 ring-brand/30';
            }
            const interactive = onCardClick ? 'cursor-pointer hover:shadow-md hover:scale-[1.01]' : '';
            const iconCls = danger ? 'bg-red-500/10 text-red-600' : 'bg-brand/10 text-brand';
            const valueCls = danger ? 'text-red-600' : 'text-slate-800';
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
          <span className="absolute left-4 top-2 text-[10px] uppercase tracking-widest text-slate-400">
            Filtros
          </span>
          <div className="flex gap-2 flex-wrap pt-4">
            <input
              className="input w-44"
              placeholder="Fornecedor, CNPJ ou Nº doc…"
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
            <select className="input w-40" value={f.docType} onChange={(e) => sf('docType', e.target.value)}>
              <option value="">Tipo Documento</option>
              {['darf','das','dae','dam / duam','gare','gnre','gps','gru','iss','iptu','ipva','itbi','pix','tributo','boleto','cte','nfe','nfse','recibo','seguro','outro'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <select className="input w-36" value={f.paymentMethod} onChange={(e) => sf('paymentMethod', e.target.value)}>
              <option value="">Tipo Pagamento</option>
              {['boleto','pix','ted','cartão','depósito','duplicata','bancário','carteira','vale','crédito','débito','dinheiro','transferência','cheque','outro'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <select className="input w-32" value={f.status} onChange={(e) => sf('status', e.target.value)}>
              <option value="">Situação</option>
              {['pendente', 'a vencer', 'vencido', 'prorrogado', 'baixado', 'protestado', 'cartório', 'pago', 'pago protesto', 'pago cartório', 'não pago', 'cancelado', 'falha'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <input
              type="date"
              className="input w-36"
              value={f.dateFrom}
              onChange={(e) => sf('dateFrom', e.target.value)}
              title="Vencimento de"
            />
            <input
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
          <table className="w-full">
            <thead>
              <tr>
                {Object.keys(SORT_COLS).map((h) => {
                  const col = SORT_COLS[h];
                  const isActive = sort.col === col;
                  let SortIcon = ArrowUpDown;
                  let ariaSortVal: 'ascending' | 'descending' | 'none' = 'none';
                  let titleVal = `Ordenar por ${h} crescente`;
                  if (isActive && sort.dir === 'asc') {
                    SortIcon = ArrowUp;
                    ariaSortVal = 'ascending';
                    titleVal = `Ordenar por ${h} descendente`;
                  } else if (isActive && sort.dir === 'desc') {
                    SortIcon = ArrowDown;
                    ariaSortVal = 'descending';
                    titleVal = `Remover ordenação de ${h}`;
                  }
                  const thBg = isActive ? 'bg-slate-100' : 'hover:bg-slate-100';
                  return (
                    <th
                      key={h}
                      onClick={() => handleSort(col)}
                      aria-sort={ariaSortVal}
                      title={titleVal}
                      className={`table-header sticky top-0 z-10 cursor-pointer select-none transition-colors ${thBg} ${h === 'Valor' ? 'text-right' : ''}`}
                    >
                      <span className="inline-flex items-center gap-1">
                        {h}
                        <SortIcon size={11} className={isActive ? 'text-brand' : 'text-slate-300'} />
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-12">
                    <div className="flex flex-col items-center justify-center text-center gap-3">
                      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-300">
                        <Inbox size={26} />
                      </div>
                      <p className="text-sm text-slate-400 max-w-xs">
                        {loading ? 'Buscando registros…' : 'Nenhum registro encontrado — ajuste os filtros e clique em Buscar'}
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr
                      className={`cursor-pointer transition-colors ${
                        sel?.id === r.id
                          ? 'bg-brand/5 border-l-2 border-brand'
                          : 'hover:bg-slate-50/60'
                      }`}
                      onClick={() => setSel(sel?.id === r.id ? null : r)}
                    >
                      <td className="table-cell text-xs font-mono text-slate-600 w-px whitespace-nowrap max-w-[25ch] truncate" title={r.invoice_number ?? ''}>{r.invoice_number || '—'}</td>
                      <td className="table-cell text-xs font-mono text-slate-600 whitespace-nowrap">{fmtDate(r.issue_date)}</td>
                      <td className="table-cell text-xs font-mono text-slate-600 w-px whitespace-nowrap max-w-[35ch] truncate" title={r.supplier_name ?? ''}>
                        {r.supplier_name || '—'}
                      </td>
                      <td className="table-cell text-xs font-mono text-slate-600">
                        {fmtCnpjOrCpf(r.supplier_cnpj, r.supplier_cpf)}
                      </td>
                      <td className="table-cell text-xs font-mono text-slate-600">{r.document_type || '—'}</td>
                      <td className="table-cell text-xs font-mono text-slate-600">{r.payment_method || '—'}</td>
                      <td className="table-cell text-xs font-mono text-slate-600 whitespace-nowrap">{fmtDate(r.due_date)}</td>
                      <td className="table-cell text-xs font-mono text-slate-600 text-right">{fmtMoney(r.amount)}</td>
                      <td className="table-cell">
                        <StatusBadge value={r.due_status} />
                      </td>
                      <td className="table-cell">
                        <StatusBadge value={r.extraction_source} />
                      </td>
                    </tr>

                    {sel?.id === r.id && (
                      <tr>
                        <td colSpan={10} className="p-0 border-b border-slate-100">
                          <div className="relative animate-fade-in-up bg-slate-50/60 border-l-2 border-brand p-4">
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
                                  ['CNPJ', fmtCnpj(r.supplier_cnpj)],
                                  ['N° Documento', r.invoice_number],
                                  ['Competência', r.competence_date],
                                  ['Emissão', fmtDate(r.issue_date)],
                                  ['Vencimento', fmtDate(r.due_date)],
                                  ['Situação', r.due_status],
                                  ['Valor do documento', fmtMoney(r.amount)],
                                  ['Valor cobrado', fmtMoney(r.amount_charged)],
                                  ['Desconto / abatimentos', fmtMoney(r.discount)],
                                  ['Outras deduções', fmtMoney(r.other_deductions)],
                                  ['Mora / multa', fmtMoney(r.fine_interest)],
                                  ['Outros acréscimos', fmtMoney(r.other_additions)],
                                  ['Nosso número', r.nosso_numero || '—'],
                                  ['Forma de pag.', r.payment_method],
                                  ['Código de barras', r.barcode || '—'],
                                  ['Extração', r.extraction_source],
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
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
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
