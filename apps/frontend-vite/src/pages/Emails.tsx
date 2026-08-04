// src/pages/Emails.tsx
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { RefreshCw, Mail, FileCheck, AlertCircle, CopyMinus, Copy, Inbox, Ban, CalendarDays, X, Eye } from 'lucide-react';
import type { EmailControl, FinancialAccountControl } from '@sheild/shared';
import { getEmailControl, getEmailStats, getAccountsByMessageId, getInvoiceNumbersByMessageIds, markEmailReviewed, getCompanyEmail, type EmailStats } from '../services/supabase';
import { startEmailRead, getEmailReadProgress, type ReadProgress } from '../services/emailReader';
import { EMAIL_READER_ENABLED } from '../lib/featureFlags';
import { suspendIdleLogout, resumeIdleLogout } from '../hooks/useIdleLogout';
import { getEmailColumns } from '../hooks/useGridColumns';
import { getErrorMessage } from '../lib/getErrorMessage';
import { getStatusExplanation } from '../lib/getStatusExplanation';
import StatusBadge from '../components/StatusBadge';
import Alert from '../components/atoms/Alert';
import AttachmentViewer from '../components/AttachmentViewer';
import ExpandableText from '../components/ExpandableText';
import DataGrid from '../components/organisms/DataGrid';
import { fmtDateTime as fmt, fmtDate, fmtMoney, fmtSupplierName } from '../lib/format';

// Tempo decorrido em mm:ss para o banner de progresso.
const fmtElapsed = (s: number): string => {
  const sec = Math.max(0, Math.floor(s));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Cadência do poll de progresso e da atualização do grid durante o processamento.
const PROGRESS_POLL_MS = 1500;
const GRID_REFRESH_EVERY = 5; // a cada ~7,5s recarrega KPIs/tabela
const PROGRESS_MAX_ERRORS = 20; // ~30s sem contato com o backend → aborta o poll

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

// Tom de cor de cada card por status — ESPELHA o StatusBadge (célula "Status").
// Esquema (decisão de UI): Total=preto · Extraídos+Recebidos=verde · Falha=vermelho ·
// Pendente+Ignorados+Duplicidades=cinza. `fg` colore ícone + número; `activeRing` é o
// destaque (anel + fundo suave) quando o card está selecionado como filtro.
// Strings literais completas (JIT).
const CARD_TONE: Record<string, { fg: string; activeRing: string }> = {
  total:       { fg: 'text-gray-900',          activeRing: 'ring-1 ring-slate-300 bg-slate-50' },
  extraido:    { fg: 'text-status-success-fg', activeRing: 'ring-1 ring-status-success-border bg-status-success-bg' },
  recebido:    { fg: 'text-status-success-fg', activeRing: 'ring-1 ring-status-success-border bg-status-success-bg' },
  pendente:    { fg: 'text-status-neutral-fg', activeRing: 'ring-1 ring-status-neutral-border bg-status-neutral-bg' },
  falha:       { fg: 'text-status-error-fg',   activeRing: 'ring-1 ring-status-error-border bg-status-error-bg' },
  ignorado:    { fg: 'text-status-neutral-fg', activeRing: 'ring-1 ring-status-neutral-border bg-status-neutral-bg' },
  duplicidade: { fg: 'text-status-neutral-fg', activeRing: 'ring-1 ring-status-neutral-border bg-status-neutral-bg' },
};

export default function Emails() {
  const [rows, setRows] = useState<EmailControl[]>([]);
  const [stats, setStats] = useState<Partial<EmailStats>>({});
  // E-mail da caixa (company.email, sk_company=1) — subtítulo do cabeçalho.
  const [mailbox, setMailbox] = useState<string | null>(null);
  const [sel, setSel] = useState<EmailControl | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [readMode, setReadMode] = useState<'novos' | 'geral' | null>(null);
  const [readMsg, setReadMsg] = useState<string | null>(null);
  const [progress, setProgress] = useState<ReadProgress | null>(null);
  const [accounts, setAccounts] = useState<FinancialAccountControl[]>([]);
  const [filters, setFilters] = useState<EmailFilters>({ ...EMPTY_FILTERS });
  const [activeCard, setActiveCard] = useState<string | null>(null);
  const [readDays, setReadDays] = useState<number>(7);
  const [viewing, setViewing] = useState<string | null>(null);
  const [invoiceMap, setInvoiceMap] = useState<Record<string, string>>({});
  // Valor digitado na busca por remetente (formulário) — separado de filters.sender
  // (valor aplicado que alimenta o load). Commitado por debounce/Enter/Buscar.
  const [senderInput, setSenderInput] = useState('');

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
    // load() é fetch-on-change (seta `loading` no início) — o effect é a ferramenta certa
    // para buscar quando os filtros mudam. Regra do React Compiler conservadora aqui.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Debounce da busca por remetente: 350ms após a última tecla, commita senderInput em
  // filters.sender (que dispara o load). O cleanup cancela o timeout pendente quando
  // senderInput muda OU quando filters.sender muda por outra via (Enter/Buscar, card,
  // leitura) — sem refetch por caractere e sem corrida de valor obsoleto.
  useEffect(() => {
    if (senderInput === filters.sender) return; // sincronizado (inclui o 1º mount)
    const t = setTimeout(() => setFilters((f) => ({ ...f, sender: senderInput })), 350);
    return () => clearTimeout(t);
  }, [senderInput, filters.sender]);

  // Popula o mapa de nº documento para todas as linhas da página atual. O estado só é
  // escrito no callback assíncrono (não no corpo do effect) — sem cascata de render. Sem
  // ids, mantém o último mapa (linhas vazias não o consultam). Guarda `active` evita
  // gravar resposta obsoleta após troca de `rows`.
  useEffect(() => {
    const ids = rows.map((r) => r.message_id).filter((id): id is string => Boolean(id));
    if (!ids.length) return;
    let active = true;
    getInvoiceNumbersByMessageIds(ids)
      .then((m) => { if (active) setInvoiceMap(m); })
      .catch(() => { if (active) setInvoiceMap({}); });
    return () => { active = false; };
  }, [rows]);

  // Carrega a(s) conta(s) ligada(s) ao e-mail selecionado. Sem seleção, o painel está
  // fechado (não lê `accounts`), então não precisa limpar de forma síncrona. Guarda
  // `active` descarta resposta de uma seleção já trocada.
  useEffect(() => {
    if (!sel?.message_id) return;
    let active = true;
    getAccountsByMessageId(sel.message_id)
      .then((a) => { if (active) setAccounts(a); })
      .catch(() => { if (active) setAccounts([]); });
    return () => { active = false; };
  }, [sel]);

  // E-mail da caixa (company.email, sk_company=1) — carregado uma vez para o subtítulo.
  useEffect(() => {
    let active = true;
    getCompanyEmail()
      .then((e) => { if (active) setMailbox(e); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  // Acompanha o job de leitura (poll de GET /progress) até concluir/falhar.
  // Reutilizado por handleRead E pela reconexão no carregamento (efeito abaixo):
  // o job roda em background no Flask, então se o usuário ATUALIZAR a aba no meio do
  // processamento o estado da UI se perdia e o botão parecia "pronto" enquanto o
  // backend seguia registrando e-mails (total subindo a cada refresh). `trackingRef`
  // garante um único loop de poll mesmo se o efeito de reconexão reavaliar.
  const trackingRef = useRef(false);

  const trackJob = useCallback(async (mode: 'novos' | 'geral' | null) => {
    if (trackingRef.current) return; // já acompanhando — evita poll duplicado
    trackingRef.current = true;
    try {
      let final: ReadProgress | null = null;
      let ticks = 0;
      let errors = 0;
      let polling = true;
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
        if (ticks % GRID_REFRESH_EVERY === 0) void load(); // KPIs/tabela sobem ao vivo
        if (!p.running) { final = p; polling = false; }
      }

      if (final?.error) {
        setError(final.error);
      } else if (final?.summary) {
        const s = final.summary;
        let criterio: string;
        if (mode === 'novos') criterio = 'não lidos';
        else if (mode === 'geral') criterio = readDays === 0 ? 'todos os e-mails' : `últimos ${readDays} dias`;
        else criterio = 'processamento retomado';
        const abortAviso = s.api_aborted
          ? ' ⚠️ Processamento interrompido por limite da API — rode novamente para continuar.'
          : '';
        setReadMsg(
          `Busca concluída (${criterio}) — ${s.found} no servidor · ` +
            `${s.processed} financeiro(s) extraído(s) · ${s.skipped_keyword} ignorado(s) · ` +
            `${s.skipped_dup} duplicado(s).${abortAviso}`,
        );
      }
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      trackingRef.current = false;
      resumeIdleLogout();
      setReading(false);
      setReadMode(null);
      setProgress(null);
      await load();
    }
  }, [load, readDays]);

  // Dispara a leitura IMAP (job em background no Flask) e acompanha a progressão.
  // mode='novos' → IMAP UNSEEN · mode='geral' → IMAP SINCE N dias / ALL.
  const handleRead = async (mode: 'novos' | 'geral') => {
    setError(null);
    setReadMsg(null);
    setProgress(null);
    setReading(true);
    setReadMode(mode);
    // Suspende o logout por inatividade enquanto processa.
    suspendIdleLogout();

    // Alinha a janela da tabela ao período buscado (readDays=0 → todos).
    if (mode === 'geral') {
      setActiveCard(null);
      setSenderInput('');
      setFilters({ status: '', sender: '', days: readDays });
    }

    try {
      const days = mode === 'novos' ? 0 : readDays;
      const all = mode === 'geral' && readDays === 0;
      await startEmailRead({ days, all });
    } catch (e) {
      setError(getErrorMessage(e));
      resumeIdleLogout();
      setReading(false);
      setReadMode(null);
      return;
    }
    await trackJob(mode);
  };

  // Reconexão: se houver um job rodando no backend (ex.: a aba foi atualizada no
  // meio do processamento), retoma o banner + poll em vez de parecer "pronto".
  // trackJob é idempotente (trackingRef), então não inicia um segundo loop.
  useEffect(() => {
    if (!EMAIL_READER_ENABLED) return; // sem Flask (produção): não tenta reconectar ao job
    let cancelled = false;
    getEmailReadProgress()
      .then((p) => {
        if (cancelled || !p.running || trackingRef.current) return;
        suspendIdleLogout();
        setReading(true);
        setReadMode('geral');
        setProgress(p);
        void trackJob(null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [trackJob]);

  const setF = <K extends keyof EmailFilters>(k: K, v: EmailFilters[K]) =>
    setFilters((f) => ({ ...f, [k]: v }));

  // Submit da busca por remetente (Enter/Buscar): commita senderInput em filters.sender.
  // Novo objeto filters → load recompõe → recarrega (é o "submit").
  const handleSearch = () => setFilters((f) => ({ ...f, sender: senderInput }));

  // Ciclo de toggle: clique no mesmo card limpa o filtro; clique diferente aplica.
  // days: 0 mostra todos os períodos, alinhando com os totais dos KPIs (all-time).
  const handleCardFilter = (cardId: string, filterOverride: Partial<EmailFilters>) => {
    setSenderInput(''); // mantém o input em sincronia (cards resetam filters.sender)
    if (activeCard === cardId) {
      setActiveCard(null);
      setFilters({ ...EMPTY_FILTERS });
    } else {
      setActiveCard(cardId);
      setFilters({ ...EMPTY_FILTERS, days: 0, ...filterOverride });
    }
  };

  // Rótulos extraídos para evitar ternários aninhados no JSX (SonarLint S3358/S4624).
  const processingLabel =
    progress && progress.total > 0 ? `Processando ${progress.done}/${progress.total}` : 'Processando…';
  const labelNovos = readMode === 'novos' ? processingLabel : 'Busca Novos';
  const labelGeralBtn = readMode === 'geral' ? processingLabel : 'Executar';

  // Banner de progresso: fase legível + barra (determinada quando há total).
  const hasTotal = progress != null && progress.total > 0;
  const phaseLabel = hasTotal ? 'Processando e-mails' : 'Conectando ao servidor de e-mails…';
  const pct = hasTotal ? Math.round((progress.done / progress.total) * 100) : 0;
  const doneLabel = hasTotal ? ` — ${progress.done}/${progress.total} (${pct}%)` : '';
  // Barra extraída para fora do JSX (SonarLint S3358 — sem ternário inline no JSX).
  // width dinâmico via style inline: não há classe Tailwind para um % computado em runtime.
  const progressBar = hasTotal ? (
    <div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} />
  ) : (
    <div className="h-full w-1/3 animate-pulse bg-brand" />
  );

  // Colunas do grid resolvidas com o mapa de nº documento (message_id → nº).
  const emailColumns = useMemo(() => getEmailColumns(invoiceMap), [invoiceMap]);

  return (
    <div className="flex flex-col h-full">
      <div className="h-0.5 bg-linear-to-r from-brand to-brand-dark" />
      <div className="px-6 py-2 border-b border-slate-200 bg-white flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-slate-800">Recebimento de e-mails</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            {mailbox ?? import.meta.env.VITE_IMAP_USER ?? 'Caixa IMAP'}
          </p>
        </div>
        <div className="flex gap-2">
          {/* Disparo manual da leitura IMAP — depende do Flask local; oculto em produção
              (sem backend Flask). A leitura automática (agendada) segue rodando. */}
          {EMAIL_READER_ENABLED && (
            <>
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
            </>
          )}
          <button onClick={load} className="btn" disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Carregando…' : 'Atualizar'}
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
            <div className="flex items-center gap-3">
              <RefreshCw size={16} className="animate-spin shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {phaseLabel}
                    {doneLabel}
                  </span>
                  <span className="font-mono text-xs">{fmtElapsed(progress?.elapsed ?? 0)}</span>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                  {progressBar}
                </div>
                <div className="mt-1.5 text-xs">
                  Extraídos {progress?.processed ?? 0} · Ignorados {progress?.skipped_keyword ?? 0} ·
                  Duplicados {progress?.skipped_dup ?? 0} · os números atualizam sozinhos — não feche esta aba.
                </div>
              </div>
            </div>
          </Alert>
        )}

        {readMsg && (
          <Alert variant="success" className="mb-4">
            {readMsg}
          </Alert>
        )}

        <div className="grid grid-cols-7 gap-3 mb-3">
          {[
            {
              icon: Mail,
              label: 'Total de e-mails',
              value: stats.total ?? 0,
              sub: 'na caixa de entradas',
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
              icon: Copy,
              label: 'Duplicidades',
              value: stats.duplicidade ?? 0,
              sub: 'conta já registrada',
              cardId: 'duplicidade',
              filter: { status: 'duplicidade' },
            },
            {
              icon: Ban,
              label: 'Ignorados',
              value: stats.ignorado ?? 0,
              sub: 'não-financeiro',
              cardId: 'ignorado',
              filter: { status: 'ignorado' },
            },
            {
              icon: AlertCircle,
              label: 'Falha',
              value: stats.falha ?? 0,
              sub: 'sem conta — revisão',
              cardId: 'falha',
              filter: { status: 'falha' },
            },
          ].map(({ icon: Icon, label, value, sub, cardId, filter }) => {
            const tone = CARD_TONE[cardId] ?? CARD_TONE.total;
            const isActive = activeCard === cardId;
            // Ícone e número sempre na cor do status (relaciona com a célula Status);
            // a label fica cinza e só assume a cor quando o card está ativo (filtro).
            const cardRing = isActive ? tone.activeRing : '';
            const labelCls = isActive ? tone.fg : 'text-gray-500';
            return (
              <button
                key={label}
                type="button"
                onClick={() => handleCardFilter(cardId, filter)}
                className={`metric-card w-full text-left cursor-pointer select-none transition-all hover:shadow-md hover:scale-[1.01] ${cardRing}`}
              >
                <div className={`flex items-center gap-1.5 text-xs mb-0.5 ${labelCls}`}>
                  <Icon size={12} className={tone.fg} />
                  {label}
                </div>
                <div className={`text-xl font-semibold ${tone.fg}`}>{value}</div>
                <div className="text-xs text-gray-500">{sub}</div>
              </button>
            );
          })}
        </div>

        <div className="flex gap-2 mb-3">
          <div className="relative w-90 max-w-full">
            <input
              id="emails-search"
              name="emails-search"
              aria-label="Buscar por remetente, assunto ou número do documento"
              className="input w-full pr-8"
              placeholder="Remetente, assunto ou Nº doc…"
              value={senderInput}
              onChange={(e) => setSenderInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearch();
              }}
            />
            {senderInput && (
              <button
                type="button"
                aria-label="Limpar busca"
                onClick={() => setSenderInput('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-600"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <select id="emails-status" name="emails-status" aria-label="Filtrar por status" className="input w-40" value={filters.status} onChange={(e) => setF('status', e.target.value)}>
            <option value="">Todos os status</option>
            {['extraído', 'recebido', 'pendente', 'falha', 'ignorado', 'duplicidade'].map((s) => (
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
          <button onClick={handleSearch} className="btn btn-primary">
            Buscar
          </button>
        </div>

        <div className="card overflow-hidden mb-4">
          <DataGrid
            columns={emailColumns}
            rows={rows}
            rowKey={(r) => String(r.id)}
            selectedId={sel ? String(sel.id) : null}
            onRowClick={(r) => {
              const opening = sel?.id !== r.id;
              setSel(opening ? r : null);
              // Abrir o card de detalhes de um e-mail 'falha' = revisado.
              if (opening && r.status === 'falha' && !r.reviewed_at) {
                void markEmailReviewed(r.id)
                  .then((reviewedAt) =>
                    setRows((prev) =>
                      prev.map((x) => (x.id === r.id ? { ...x, reviewed_at: reviewedAt } : x))))
                  .catch(() => undefined);
              }
            }}
            sortCol={null}
            sortDir={null}
            onSort={() => undefined}
            gridId="emails"
            enableColumnManagement
            maxBodyHeight="72vh"
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
                              className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-200/60 hover:text-zinc-600 transition-colors"
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
                                  <dt className="w-28 shrink-0 text-zinc-500 text-xs">{k}</dt>
                                  <dd className="text-zinc-600 text-xs break-all">{v ?? '—'}</dd>
                                </div>
                              ))}
                            </dl>
                            <div className="mt-3">
                              <p className="text-xs text-zinc-500 mb-2 uppercase tracking-wide">
                                Conta(s) registrada(s) — financial_account_control
                              </p>
                              {accounts.length === 0 ? (
                                <p className="text-xs text-zinc-500">Nenhuma conta gerada a partir deste e-mail.</p>
                              ) : (
                                <div className="space-y-1.5">
                                  {accounts.map((a) => (
                                    <div
                                      key={a.id}
                                      className="flex items-center justify-between gap-3 p-2 bg-white rounded-lg border border-zinc-100 text-xs"
                                    >
                                      <span
                                        className="truncate text-zinc-600 flex-1"
                                        title={fmtSupplierName(a.supplier)}
                                      >
                                        {fmtSupplierName(a.supplier)}
                                      </span>
                                      <span className="font-mono text-zinc-500 whitespace-nowrap">{fmtDate(a.due_date)}</span>
                                      <span className="font-mono font-medium text-zinc-600 whitespace-nowrap">
                                        {fmtMoney(a.amount)}
                                      </span>
                                      <StatusBadge value={a.status_dim?.status_name} />
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
