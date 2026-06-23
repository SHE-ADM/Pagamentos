// src/pages/Consulta.tsx
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  RefreshCw,
  Download,
  AlertCircle,
  TrendingUp,
  Clock,
  FileText,
  CheckCircle2,
  Search,
  X,
  Eye,
  Pencil,
  type LucideIcon,
} from 'lucide-react';
import type { FinancialAccountControl, FinancialAccountControlCreate } from '@sheild/shared';
import {
  getFinancialAccountControl,
  getFinancialStats,
  getFinancialAccountTotalValue,
  setFinancialAccountFlag,
  setFinancialAccountStatus,
  setFinancialAccountStatusBulk,
  type FinancialStats,
} from '../services/supabase';
import { startEmailRead, getEmailReadProgress, type ReadProgress } from '../services/emailReader';
import { updateConta } from '../services/contas';
import { suspendIdleLogout, resumeIdleLogout } from '../hooks/useIdleLogout';
import { getErrorMessage } from '../lib/getErrorMessage';
import Alert from '../components/atoms/Alert';
import ExpandableText from '../components/ExpandableText';
import AttachmentViewer from '../components/AttachmentViewer';
import DataGrid from '../components/organisms/DataGrid';
import ContaForm from '../components/organisms/ContaForm';
import { getConsultaColumns, STATUS_OPTIONS, type ToggleFlag, type StatusChangeCallback } from '../hooks/useGridColumns';

const fmtDate = (d: string | null): string => (d ? new Date(d + 'T00:00:00').toLocaleDateString('pt-BR') : '—');
const fmtMoney = (v: number | null): string =>
  v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtCnpj = (c: string | null): string =>
  c?.length === 14 ? `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}` : c || '—';

const PAGE_SIZE = 20;

// Intervalo [hoje, hoje+7d] em YYYY-MM-DD. Função de MÓDULO (fora do componente) para
// não disparar a regra de pureza do React Compiler — Date.now/new Date são impuros e não
// podem ser chamados no escopo de render do componente.
function next7DaysRange(): { dateFrom: string; dateTo: string } {
  return {
    dateFrom: new Date().toISOString().slice(0, 10),
    dateTo: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
  };
}

// "Atualizar" em /consulta dispara a leitura IMAP dos últimos 7 dias (mesmo motor
// de /emails) — assim o usuário traz e-mails novos sem sair da consulta.
const REFRESH_DAYS = 7;
const PROGRESS_POLL_MS = 1500;
const GRID_REFRESH_EVERY = 5; // a cada ~7,5s recarrega o grid durante o processamento
const PROGRESS_MAX_ERRORS = 20; // ~30s sem contato com o backend → aborta o poll
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Colunas do CSV: cada uma define o cabeçalho e como extrair o valor da linha.
// supplier_name/supplier_cnpj vêm do JOIN com `supplier` (não são mais colunas
// da conta — migrations 040/041); as demais saem direto do registro.
type CsvCol = { header: string; get: (r: FinancialAccountControl) => string | number | null | undefined };

const CSV_COLS: CsvCol[] = [
  { header: 'due_date', get: (r) => r.due_date },
  { header: 'status', get: (r) => r.status },
  { header: 'supplier_name', get: (r) => r.supplier?.trade_name ?? r.supplier?.legal_name },
  { header: 'supplier_cnpj', get: (r) => r.supplier?.cnpj ?? r.supplier?.cpf },
  { header: 'document_type', get: (r) => r.document_type },
  { header: 'amount', get: (r) => r.amount },
  { header: 'amount_charged', get: (r) => r.amount_charged },
  { header: 'discount', get: (r) => r.discount },
  { header: 'other_deductions', get: (r) => r.other_deductions },
  { header: 'fine_interest', get: (r) => r.fine_interest },
  { header: 'other_additions', get: (r) => r.other_additions },
  { header: 'payment_method', get: (r) => r.payment_method },
  { header: 'nosso_numero', get: (r) => r.nosso_numero },
  { header: 'invoice_number', get: (r) => r.invoice_number },
  { header: 'barcode', get: (r) => r.barcode },
  { header: 'description', get: (r) => r.description },
  { header: 'email_body_excerpt', get: (r) => r.email_body_excerpt },
  { header: 'processing_notes', get: (r) => r.processing_notes },
];

function exportCsv(rows: FinancialAccountControl[]) {
  const header = CSV_COLS.map((c) => c.header).join(';');
  const body = rows.map((r) =>
    CSV_COLS.map((c) => `"${(c.get(r) ?? '').toString().replace(/"/g, '""')}"`).join(';'),
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
  /** Valor monetário exibido abaixo do número principal (null = não exibir). */
  amount?: number | null;
  danger?: boolean;
  success?: boolean;
  /** Tom atenuado — valor/count em cinza médio (text-slate-600), diferenciando do total em preto forte. */
  muted?: boolean;
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
  // Edição de conta (modal com ContaForm → PATCH /api/contas/:id).
  const [editing, setEditing] = useState<FinancialAccountControl | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const editDialogRef = useRef<HTMLDialogElement>(null);
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
      // `result.total` pode ser estimativa quando o PostgREST não devolve contagem exata
      // (result.totalIsEstimate=true). A paginação a trata de forma transparente: a
      // estimativa projeta "há mais páginas" e habilita/desabilita "Próxima" corretamente,
      // sem leitura do flag aqui nem mudança visual no footer.
      setTotal(result.total);
      setStats(st);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [applied, page, sort]);

  useEffect(() => {
    // load() é fetch-on-change (seta `loading` no início) — o effect é a ferramenta certa
    // para buscar quando applied/page/sort mudam. A regra do React Compiler é conservadora
    // aqui; sem uma lib de dados (react-query) não há como evitar o setState síncrono.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Debounce da busca por fornecedor (fonte única — sem ref): 350ms após a última tecla,
  // congela f.supplier em applied. O cleanup cancela o timeout pendente quando f.supplier
  // muda OU quando applied.supplier muda por outra via (Enter/Buscar, card, Limpar) —
  // eliminando a corrida em que um timeout antigo sobrescreveria o valor recém-aplicado.
  useEffect(() => {
    if (f.supplier === applied.supplier) return; // já sincronizado (inclui o 1º mount)
    const t = setTimeout(() => {
      setApplied((prev) => ({ ...prev, supplier: f.supplier }));
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [f.supplier, applied.supplier]);

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

  const refreshStats = useCallback(async () => {
    const st = await getFinancialStats();
    setStats(st);
  }, []);

  // Altera o status de uma conta no dropdown inline com update otimista.
  // O pai (Consulta) atualiza `rows` após confirmação da API para manter consistência
  // entre a célula editada e o painel de detalhe lateral.
  const handleStatusChange = useCallback<StatusChangeCallback>(async (rowId, newStatus) => {
    await setFinancialAccountStatus(rowId, newStatus);
    setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, status: newStatus as FinancialAccountControl['status'] } : r)));
    void refreshStats();
  }, [refreshStats]);

  const handleBulkStatusChange = useCallback(async (selected: FinancialAccountControl[], newStatus: string) => {
    const ids = selected.map((r) => r.id);
    await setFinancialAccountStatusBulk(ids, newStatus);
    setRows((prev) =>
      prev.map((r) => (ids.includes(r.id) ? { ...r, status: newStatus as FinancialAccountControl['status'] } : r)),
    );
    void refreshStats();
  }, [refreshStats]);

  // Salva a edição da conta via Next API (PATCH) e recarrega o grid + KPIs.
  const handleEditSubmit = async (data: FinancialAccountControlCreate) => {
    if (!editing) return;
    setEditSubmitting(true);
    setEditError(null);
    try {
      await updateConta(editing.id, data);
      setEditing(null);
      await load();
      void refreshStats();
    } catch (e) {
      setEditError(getErrorMessage(e));
    } finally {
      setEditSubmitting(false);
    }
  };

  // Abre/fecha o <dialog> nativo de edição (foco/trap/Esc; try/catch p/ jsdom).
  useEffect(() => {
    const el = editDialogRef.current;
    if (!el) return;
    try {
      if (editing) el.showModal();
      else el.close();
    } catch {
      /* showModal indisponível (jsdom) */
    }
  }, [editing]);

  // Abre o modal de edição a partir do botão de ação no grid.
  const handleEditRow = useCallback((r: FinancialAccountControl) => {
    setEditError(null);
    setEditing(r);
  }, []);

  const columns = useMemo(
    () => getConsultaColumns(handleToggleFlag, handleStatusChange, handleEditRow),
    [handleToggleFlag, handleStatusChange, handleEditRow],
  );

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

  // Ciclo: nenhuma → asc → desc → nenhuma (volta ao padrão created_at.desc).
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
    {
      icon: FileText,
      label: 'Total de registros',
      value: stats.totalRecords ?? 0,
      fmt: (v) => v,
      amount: filteredValue ?? stats.totalValue ?? null,
    },
    {
      icon: CheckCircle2,
      label: 'Pagos',
      value: stats.pago ?? 0,
      fmt: (v) => v,
      amount: stats.pagoValue ?? null,
      success: true,
      cardId: 'pago',
      onCardClick: () => handleCardFilter('pago', { status: 'pago' }),
    },
    {
      icon: Clock,
      label: 'A vencer',
      value: stats.aVencer ?? 0,
      fmt: (v) => v,
      amount: stats.aVencerValue ?? null,
      muted: true,
      cardId: 'avencer',
      onCardClick: () => handleCardFilter('avencer', { status: 'a vencer' }),
    },
    {
      icon: TrendingUp,
      label: 'A vencer em 7 dias',
      value: stats.vencendo ?? 0,
      fmt: (v) => v,
      amount: stats.vencendoValue ?? null,
      muted: true,
      cardId: 'avencer7',
      onCardClick: () => handleCardFilter('avencer7', next7DaysRange()),
    },
    {
      icon: AlertCircle,
      label: 'Vencidas',
      value: vencidasCount,
      fmt: (v) => v,
      amount: stats.vencidasValue ?? null,
      danger: vencidasCount > 0,
      cardId: 'vencidas',
      onCardClick: () => handleCardFilter('vencidas', { status: 'vencido' }),
    },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Barra superior em gradiente (2px) — acento de marca */}
      <div className="h-0.5 bg-linear-to-r from-brand to-brand-dark" />
      <div className="px-6 py-1 border-b border-slate-200 bg-white flex items-center justify-between">
        <h1 className="text-sm font-semibold text-slate-800">Consulta de movimentações</h1>
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

      <div className="flex-1 overflow-y-auto px-6 py-3">
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

        <div className="flex gap-2 mb-2 flex-wrap">
          {cards.map(({ icon: Icon, label, value, fmt, amount, danger, success, muted, cardId, onCardClick }) => {
            const isActive = !!cardId && activeCard === cardId;
            const borderLeft = danger ? 'border-l-status-error-solid' : success ? 'border-l-status-success-fg' : 'border-l-brand';
            let cardBg = 'bg-white';
            if (isActive) {
              cardBg = danger
                ? 'bg-status-error-bg ring-1 ring-status-error-border/40'
                : success
                  ? 'bg-status-success-bg ring-1 ring-status-success-border/40'
                  : 'bg-brand/5 ring-1 ring-brand/30';
            }
            const interactive = onCardClick ? 'cursor-pointer hover:shadow-md hover:scale-[1.01]' : '';
            const iconCls = danger ? 'bg-status-error-solid/10 text-status-error-fg' : success ? 'bg-status-success-bg text-status-success-fg' : 'bg-brand/10 text-brand';
            const valueCls = danger ? 'text-status-error-fg' : success ? 'text-status-success-fg' : muted ? 'text-slate-500' : 'text-slate-800';
            return (
              <div
                key={label}
                role={onCardClick ? 'button' : undefined}
                tabIndex={onCardClick ? 0 : undefined}
                onClick={onCardClick}
                onKeyDown={onCardClick ? (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') onCardClick(); } : undefined}
                className={`flex-1 min-w-[140px] flex items-center gap-2 rounded-lg p-2 border-l-2 shadow-xs hover:shadow-sm transition-shadow animate-fade-in-up ${borderLeft} ${cardBg} ${interactive}`}
              >
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${iconCls}`}>
                  <Icon size={14} />
                </div>
                <div className="min-w-0">
                  {amount != null && (
                    <div className={`text-xl font-semibold leading-tight truncate ${valueCls}`}>
                      {fmtMoney(amount)}
                    </div>
                  )}
                  <div className={`text-lg leading-tight ${valueCls}`}>
                    {fmt(value)}
                    <span className="text-xs font-normal text-slate-500 ml-1">conta(s)</span>
                  </div>
                  <div className="text-xs text-slate-500 truncate">{label}</div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex gap-2 flex-wrap mb-2">
          <div className="relative w-90 max-w-full">
            <input
              id="consulta-supplier"
              name="consulta-supplier"
              aria-label="Buscar por fornecedor, CNPJ, número do documento, assunto, remetente ou e-mail do fornecedor"
              className="input w-full pr-8"
              placeholder="Fornecedor, CNPJ, Nº doc, assunto, remetente ou e-mail…"
              value={f.supplier}
              onChange={(e) => sf('supplier', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearch();
              }}
            />
            {f.supplier && (
              <button
                type="button"
                aria-label="Limpar busca"
                onClick={() => sf('supplier', '')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-600"
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
            bulkStatusOptions={STATUS_OPTIONS}
            onBulkStatusChange={handleBulkStatusChange}
            maxBodyHeight="74vh"
            loading={loading}
            emptyMessage={loading ? 'Buscando registros…' : 'Nenhum registro encontrado — ajuste os filtros e clique em Buscar'}
            renderDetail={(r) => (
                          <div className="relative bg-slate-50/60 border-l-2 border-brand p-4">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setSel(null);
                              }}
                              className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full text-slate-500 hover:bg-slate-200/60 hover:text-slate-600 transition-colors"
                              title="Fechar"
                            >
                              <X size={15} />
                            </button>
                            <p className="text-xs font-semibold text-slate-500 mb-3 uppercase tracking-wide pr-8">
                              Detalhes — {(r.supplier?.trade_name ?? r.supplier?.legal_name) || 'registro'} · {fmtDate(r.due_date)}
                            </p>
                            <div className="mb-3 flex gap-2">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditError(null);
                                  setEditing(r);
                                }}
                                className="btn btn-primary"
                                title="Editar esta conta"
                              >
                                <Pencil size={14} /> Editar conta
                              </button>
                              {r.source_file && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setViewing(r.source_file);
                                  }}
                                  className="btn"
                                  title="Ver o PDF anexado"
                                >
                                  <Eye size={14} /> Ver anexo
                                </button>
                              )}
                            </div>
                            <dl className="grid grid-cols-2 rounded-lg overflow-hidden border border-slate-100">
                              {(
                                [
                                  ['ID', String(r.id)],
                                  ['Fornecedor', r.supplier?.trade_name ?? r.supplier?.legal_name],
                                  ['Assunto', r.subject],
                                  ['Remetente', r.sender_email],
                                  ['CNPJ', fmtCnpj(r.supplier?.cnpj ?? null)],
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
                                  <dt className="w-36 shrink-0 text-slate-500 text-xs">{k}</dt>
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

      {editing && (
        <dialog
          ref={editDialogRef}
          aria-label="Editar conta"
          onCancel={() => setEditing(null)}
          className="fixed inset-0 m-auto h-fit max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border-0 bg-white p-0 shadow-lg backdrop:bg-black/50"
        >
          <div className="p-6">
            <h2 className="mb-4 text-base font-semibold text-gray-900">Editar conta</h2>
            <ContaForm
              mode="edit"
              defaultValues={editing}
              onSubmit={handleEditSubmit}
              onCancel={() => setEditing(null)}
              submitError={editError}
              submitting={editSubmitting}
            />
          </div>
        </dialog>
      )}
    </div>
  );
}
