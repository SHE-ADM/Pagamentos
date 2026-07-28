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
  Pencil,
  Trash2,
  Info,
  type LucideIcon,
} from 'lucide-react';
import {
  DOCUMENT_TYPES,
  PAYMENT_METHODS,
  ACCOUNT_STATUSES,
  STATUS_IDS,
  STATUS_ID_PAGO,
  STATUS_ID_VENCIDO,
  STATUS_ID_A_VENCER,
  STATUS_ID_CANCELADO,
  STATUS_NAME_BY_ID,
} from '@sheild/shared';
import type { FinancialAccountControl, FinancialAccountControlCreate } from '@sheild/shared';
import {
  getFinancialAccountControl,
  getFinancialStats,
  getFinancialAccountTotalValue,
  getFinancialAccountCount,
  setFinancialAccountFlag,
  setFinancialAccountStatus,
  setFinancialAccountStatusBulk,
  getAppUsers,
  type FinancialStats,
} from '../services/supabase';
import { startEmailRead, getEmailReadProgress, type ReadProgress } from '../services/emailReader';
import { EMAIL_READER_ENABLED } from '../lib/featureFlags';
import { updateConta, deleteConta } from '../services/contas';
import { useAuth } from '../contexts/AuthContext';
import { suspendIdleLogout, resumeIdleLogout } from '../hooks/useIdleLogout';
import { getErrorMessage } from '../lib/getErrorMessage';
import Alert from '../components/atoms/Alert';
import ExpandableText from '../components/ExpandableText';
import DataGrid from '../components/organisms/DataGrid';
import ContaForm from '../components/organisms/ContaForm';
import ContaAttachments from '../components/organisms/ContaAttachments';
import { uploadContaAttachments, type UploadOutcome } from '../services/contaAttachments';
import { getConsultaColumns, STATUS_OPTIONS, type ToggleFlag, type StatusChangeCallback } from '../hooks/useGridColumns';
import { useCompanyOptions } from '../hooks/useCompanyOptions';
import { fmtDate, fmtDateTime, fmtMoney, fmtCnpj, fmtCostCenter, fmtChartAccount, todayISO } from '../lib/format';
import { csvCell } from '../lib/csv';

// Fornecedor no card de detalhe: id (sk_supplier) concatenado ao nome com " - ".
const fmtSupplier = (r: FinancialAccountControl): string => {
  const name = r.supplier?.trade_name ?? r.supplier?.legal_name;
  return name ? `${r.sk_supplier} - ${name}` : String(r.sk_supplier);
};

const PAGE_SIZE = 50;

// Fixação inicial do grid de /consulta: as 3 colunas-chave de contexto à esquerda.
// Constante de módulo (ref estável) — evita recriar o objeto a cada render.
const CONSULTA_DEFAULT_PINNING = { left: ['invoice_number', 'issue_date', 'supplier_name'], right: [] };

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
  { header: 'status', get: (r) => r.status_dim?.status_name ?? '' },
  { header: 'supplier_name', get: (r) => r.supplier?.trade_name ?? r.supplier?.legal_name },
  { header: 'supplier_cnpj', get: (r) => r.supplier?.cnpj ?? r.supplier?.cpf },
  { header: 'document_type', get: (r) => r.document_type },
  { header: 'cost_center', get: (r) => fmtCostCenter(r) },
  { header: 'chart_account', get: (r) => fmtChartAccount(r) },
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
  // csvCell escapa aspas, remove quebras de linha internas e NEUTRALIZA injeção de
  // fórmula (= + - @) — conteúdo de e-mail hostil não vira fórmula no Excel/Sheets.
  const body = rows.map((r) => CSV_COLS.map((c) => csvCell(c.get(r))).join(';'));
  const blob = new Blob(['﻿' + [header, ...body].join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `financial_account_control_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// Rótulos de mês — mesmos do Dashboard (princípio de filtro por mês/ano reaproveitado).
const MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const MONTHS_FULL = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

interface ConsultaFilters {
  supplier: string;
  docType: string;
  // Situação filtrada por status_id (fonte única). undefined = sem filtro.
  statusId?: number;
  // Empresa pagadora (sk_company: 1=OTIMOTEX TECIDOS, 2=LEBIANCO, 3=OTIMOTEX FARDOS). undefined = todas.
  skCompany?: number;
  paymentMethod: string;
  // Coluna do filtro de período: vencimento (padrão) ou emissão.
  dateField: 'due_date' | 'issue_date';
  // Mês (0-indexed) / ano selecionados. Ambos null = escopo "Todas" (sem filtro de período).
  month: number | null;
  year: number | null;
  // Range explícito — usado só pelo card "A vencer em 7 dias" (sobre due_date).
  dateFrom: string;
  dateTo: string;
}

// Campos não-período zerados (vencimento como campo de data padrão).
const BASE_FILTERS = {
  supplier: '',
  docType: '',
  statusId: undefined as number | undefined,
  // Empresa: undefined = todas. Como os demais filtros, é ZERADO ao clicar num card de KPI
  // (que reseta a view) e no "Limpar" — ambos derivam daqui.
  skCompany: undefined as number | undefined,
  paymentMethod: '',
  dateField: 'due_date' as const,
  dateFrom: '',
  dateTo: '',
};

// Opções do filtro de situação — value = status_id (fonte única), label = nome da
// dimensão (mesmo estilo cru/minúsculo das demais selects de filtro: tipo/pagamento).
const STATUS_FILTER_OPTIONS = ACCOUNT_STATUSES.map((name) => ({
  id: STATUS_IDS[name],
  label: name,
}));

// Estado padrão de navegação: mês/ano corrente por vencimento (grid abre no mês atual).
// Função de MÓDULO — new Date() é impuro e não pode ser chamado no escopo de render
// (mesma razão de next7DaysRange).
function initialFilters(): ConsultaFilters {
  const d = new Date();
  return { ...BASE_FILTERS, month: d.getMonth(), year: d.getFullYear() };
}

// Base "todos os períodos" para os cards globais (sem filtro de mês/ano).
function allPeriodFilters(): ConsultaFilters {
  return { ...BASE_FILTERS, month: null, year: null };
}

// Espelha a trigger `trg_fac_payment_date` (migration 096) no update otimista: PREENCHE ao
// ENTRAR em pago (preservando data já existente, como a trigger faz) e LIMPA ao SAIR de pago;
// nas demais transições não toca no campo. Sem isso a linha ficaria "paga sem data" até o
// próximo refresh — invisível hoje (a coluna não é exibida), visível assim que for.
function nextPaymentDate(r: FinancialAccountControl, id: number): string | null {
  if (id === STATUS_ID_PAGO) return r.payment_date ?? todayISO();
  if (r.status_id === STATUS_ID_PAGO) return null;
  return r.payment_date;
}

// Update otimista da situação de uma linha: grava status_id (fonte única) e sincroniza o
// embed status_dim (nome exibido no badge/CSV/detalhe, resolvido da dimensão pelo id).
function applyStatusId(r: FinancialAccountControl, id: number): FinancialAccountControl {
  const name = STATUS_NAME_BY_ID[id] ?? String(id);
  return {
    ...r,
    status_id: id,
    status_dim: { status_name: name, status_short_name: name },
    payment_date: nextPaymentDate(r, id),
  };
}

// Situações EM ABERTO — únicas que a baixa automática pode converter para "pago"
// (preserva cancelado/baixado/protestado/cartório/prorrogado e o que já está pago).
const OPEN_STATUS_IDS: readonly number[] = [STATUS_IDS.pendente, STATUS_ID_VENCIDO, STATUS_ID_A_VENCER];

// Data local YYYY-MM-DD (não UTC) — evita "voltar um dia" perto da meia-noite. Função de
// MÓDULO: new Date() é impuro e não pode ser chamado no escopo de render (mesma razão de
// next7DaysRange/initialFilters).
function todayLocalISO(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// Regra de baixa automática (espelha o batch diário em Python `baixa-automatica`): conta
// com NF E Boleto marcados, vencimento <= hoje e ainda EM ABERTO é considerada paga.
function qualifiesForAutoPago(r: FinancialAccountControl): boolean {
  if (!r.has_invoice || !r.has_bank_slip) return false;
  if (!r.due_date || r.due_date > todayLocalISO()) return false;
  return OPEN_STATUS_IDS.includes(r.status_id);
}

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

// Sentinela: default de created_by/updated_by/status_changed_by quando não há usuário real
// resolvido (migrations 076/077). "Última edição por" / "Situação alterada por" apontando p/
// ele não representam uma edição de um usuário de verdade — então não são exibidos.
const SENTINEL_AUTHOR_EMAIL = 'teste@otimotex.com.br';
const SENTINEL_AUTHOR_ID = 'fe8d268d-2bc3-4418-8cae-65e426c3fb4e';

export default function Consulta() {
  // Só o GRUPO ADMINISTRADOR vê/executa o hard delete de conta (o backend também impõe
  // via requireAdminGroup — o gate de UI é cosmético). Ver "Hard delete" no CLAUDE.md.
  const { isAdminGroup } = useAuth();
  const [rows, setRows] = useState<FinancialAccountControl[]>([]);
  const [stats, setStats] = useState<Partial<FinancialStats>>({});
  // Soma de "Valor total" para o filtro aplicado (cards/filtros). null = sem dado ainda.
  const [filteredValue, setFilteredValue] = useState<number | null>(null);
  // Contagem de documentos NÃO cancelados para o filtro aplicado (rodapé). null = sem dado.
  const [filteredCount, setFilteredCount] = useState<number | null>(null);
  const [sel, setSel] = useState<FinancialAccountControl | null>(null);
  // Diretório id→e-mail (view app_user) para exibir o AUTOR no detalhe (migration 077).
  const [appUsers, setAppUsers] = useState<Record<string, string>>({});
  const userEmail = (id: string | null): string => (id ? (appUsers[id] ?? id) : '—');
  // Autor é o sentinela? Por UUID (robusto quando o diretório app_user ainda não carregou)
  // OU pelo e-mail resolvido.
  const isSentinelAuthor = (id: string | null): boolean =>
    id === SENTINEL_AUTHOR_ID || userEmail(id) === SENTINEL_AUTHOR_EMAIL;
  // Edição de conta (modal com ContaForm → PATCH /api/contas/:id).
  const [editing, setEditing] = useState<FinancialAccountControl | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  // Conta salva mas algum anexo falhou — nem erro (a conta foi gravada) nem sucesso limpo.
  const [editWarning, setEditWarning] = useState<string | null>(null);
  const editDialogRef = useRef<HTMLDialogElement>(null);
  // Hard delete (grupo Administrador): confirmação inline no detalhe. `confirmDelete` = id
  // da conta com exclusão armada; `deleting` bloqueia o duplo-clique; `deleteError` inline.
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState<ConsultaFilters>(initialFilters);
  const [applied, setApplied] = useState<ConsultaFilters>(initialFilters);
  // Referência do mês/ano corrente (base dos botões de ano quando o escopo é "Todas").
  // Inicializador de useState — fora do escopo de render puro.
  const [nowRef] = useState(() => {
    const d = new Date();
    return { month: d.getMonth(), year: d.getFullYear() };
  });
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
  // Opções do filtro de empresa (mesmo hook do ContaForm). Lista vazia → o select fica só
  // com "Empresa" (todas), que é justamente o estado sem filtro — não quebra a tela.
  const companyOptions = useCompanyOptions();

  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);

  // Recarrega os KPIs (independente da paginação do grid).
  const refreshStats = useCallback(async () => {
    const st = await getFinancialStats();
    setStats(st);
  }, []);

  // Busca uma página de contas e a aplica: `replace` (1ª página / reset de filtro/sort)
  // ou `append` (scroll infinito). `loadingMoreRef` evita disparos concorrentes no append.
  // `result.total` pode ser estimativa (totalIsEstimate) — tratada de forma transparente
  // pelo "hasMore" (rows.length < total), sem mudança visual no rodapé.
  const load = useCallback(
    async (pageNum: number, mode: 'replace' | 'append') => {
      if (mode === 'append') {
        if (loadingMoreRef.current) return;
        loadingMoreRef.current = true;
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const result = await getFinancialAccountControl({
          ...applied,
          page: pageNum,
          pageSize: PAGE_SIZE,
          sortCol: sort.col ?? undefined,
          sortDir: sort.dir ?? undefined,
        });
        setRows((prev) => (mode === 'append' ? [...prev, ...result.data] : result.data));
        setTotal(result.total);
        setPage(pageNum);
      } catch (e) {
        setError(getErrorMessage(e));
      } finally {
        if (mode === 'append') {
          loadingMoreRef.current = false;
          setLoadingMore(false);
        } else {
          setLoading(false);
        }
      }
    },
    [applied, sort],
  );

  // Próxima página (append) — chamado pelo grid (auto ao rolar) e pelo botão "Carregar mais".
  const loadMore = useCallback(() => {
    if (loadingMoreRef.current) return;
    void load(page + 1, 'append');
  }, [load, page]);

  // Reset: quando o filtro aplicado ou a ordenação mudam (e no mount), recomeça da
  // página 1 e recarrega os KPIs. load() seta `loading` no início — o effect é a
  // ferramenta certa para o fetch-on-change.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(1, 'replace');
    void refreshStats();
  }, [load, refreshStats]);

  // Diretório de usuários (id→e-mail) para o detalhe — busca única no mount. Falha é
  // silenciosa (o detalhe cai no fallback do UUID). void: fire-and-forget idiomático.
  useEffect(() => {
    void getAppUsers().then(setAppUsers).catch(() => undefined);
  }, []);

  // Debounce da busca por fornecedor (fonte única — sem ref): 350ms após a última tecla,
  // congela f.supplier em applied. O cleanup cancela o timeout pendente quando f.supplier
  // muda OU quando applied.supplier muda por outra via (Enter/Buscar, card, Limpar) —
  // eliminando a corrida em que um timeout antigo sobrescreveria o valor recém-aplicado.
  useEffect(() => {
    if (f.supplier === applied.supplier) return; // já sincronizado (inclui o 1º mount)
    const t = setTimeout(() => {
      // Busca por fornecedor é GLOBAL: ao ter texto, zera o período (mês/ano → "Todas")
      // para procurar em toda a base; ao limpar, mantém o período como está.
      const goGlobal = f.supplier !== '';
      setApplied((prev) => ({ ...prev, supplier: f.supplier, ...(goGlobal ? { month: null, year: null } : {}) }));
      if (goGlobal) setF((prev) => ({ ...prev, month: null, year: null }));
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [f.supplier, applied.supplier]);

  // "Valor total" e "Total de registros" (ambos SEM cancelado) refletem o filtro
  // aplicado (cards ou filtros manuais). Dependem só de `applied` — não re-somam ao
  // paginar/ordenar. O flag `cancelled` descarta respostas de filtros já trocados.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const [v, c] = await Promise.all([
          getFinancialAccountTotalValue(applied),
          getFinancialAccountCount(applied),
        ]);
        if (!cancelled) {
          setFilteredValue(v);
          setFilteredCount(c);
        }
      } catch {
        if (!cancelled) {
          setFilteredValue(null);
          setFilteredCount(null);
        }
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
    void setFinancialAccountFlag(row.id, field, value)
      .then(() => {
        // Baixa automática no ATO da edição: com NF + Boleto marcados e vencimento vencido,
        // a conta em aberto vira "pago". Best-effort — falha aqui NÃO reverte a flag já
        // gravada (o batch diário reconcilia o que escapar). Espelha `qualifiesForAutoPago`.
        const next = { ...row, [field]: value };
        if (!qualifiesForAutoPago(next)) return;
        void setFinancialAccountStatus(row.id, STATUS_ID_PAGO)
          .then(() => {
            setRows((prev) => prev.map((r) => (r.id === row.id ? applyStatusId(r, STATUS_ID_PAGO) : r)));
            setSel((s) => (s && s.id === row.id ? applyStatusId(s, STATUS_ID_PAGO) : s));
            void refreshStats();
          })
          .catch((e: unknown) => setError(getErrorMessage(e)));
      })
      .catch((e: unknown) => {
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, [field]: !value } : r)));
        setError(getErrorMessage(e));
      });
  }, [refreshStats]);

  // Altera a situação de uma conta no dropdown inline com update otimista (por status_id).
  // O pai (Consulta) atualiza `rows` após confirmação da API para manter consistência entre
  // a célula editada e o painel de detalhe lateral. Atualiza status_id E o embed status_dim
  // (nome exibido no badge/CSV/detalhe) — a fonte do nome é a dimensão `status`.
  const handleStatusChange = useCallback<StatusChangeCallback>(async (rowId, newStatusId) => {
    await setFinancialAccountStatus(rowId, newStatusId);
    setRows((prev) => prev.map((r) => (r.id === rowId ? applyStatusId(r, newStatusId) : r)));
    void refreshStats();
  }, [refreshStats]);

  const handleBulkStatusChange = useCallback(async (selected: FinancialAccountControl[], newStatusId: number) => {
    const ids = selected.map((r) => r.id);
    setError(null);
    try {
      await setFinancialAccountStatusBulk(ids, newStatusId);
      setRows((prev) => prev.map((r) => (ids.includes(r.id) ? applyStatusId(r, newStatusId) : r)));
      void refreshStats();
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }, [refreshStats]);

  // Salva a edição da conta via Next API (PATCH) e recarrega o grid + KPIs.
  // Devolve ao ContaForm os anexos que NÃO subiram (a fila que deve permanecer) — ver o
  // contrato de `onSubmit` no ContaForm.
  const handleEditSubmit = async (data: FinancialAccountControlCreate, files: File[]): Promise<File[] | void> => {
    if (!editing) return;
    setEditSubmitting(true);
    setEditError(null);
    setEditWarning(null);
    try {
      const updated = await updateConta(editing.id, data);

      // Anexos novos sobem só agora (mesmo caminho da inclusão: nada é enviado antes de a
      // gravação da conta ter dado certo).
      const outcome: UploadOutcome = files.length
        ? await uploadContaAttachments(updated.id, files)
        : { saved: [], failed: [] };
      const { saved, failed } = outcome;

      // A resposta do PATCH foi montada ANTES destes uploads: sem juntar `saved` aqui, os
      // anexos novos só apareceriam num refresh (o grid mescla in-place, sem refetch).
      const merged = { ...updated, attachments: [...(updated.attachments ?? []), ...saved] };

      // Atualiza a linha no lugar (preserva a posição de rolagem do scroll infinito).
      setRows((prev) => prev.map((r) => (r.id === merged.id ? merged : r)));
      setSel((s) => (s && s.id === merged.id ? merged : s));
      void refreshStats();

      if (failed.length) {
        // Modal FICA aberto: a conta foi salva, mas o usuário precisa ver o que faltou.
        // `setEditing(merged)` é essencial: sem ele a lista "Anexos da conta" do modal
        // continuaria sem os que ACABARAM de subir, e o usuário reanexaria tudo.
        setEditing(merged);
        setEditWarning(
          `Conta salva, mas ${failed.length} anexo(s) não foram enviados: ` +
            `${failed.map((f) => f.file.name).join(', ')}. Clique em salvar novamente para tentar só eles.`,
        );
        // Só os que falharam continuam na fila — reenviar os que já subiram os DUPLICARIA.
        return failed.map((f) => f.file);
      }

      setEditing(null);
    } catch (e) {
      // A conta não foi gravada: preserva a fila para o usuário corrigir e tentar de novo.
      setEditError(getErrorMessage(e));
      return files;
    } finally {
      setEditSubmitting(false);
    }
  };

  // Reflete no grid a remoção de um anexo feita pelo modal (sem refetch).
  const handleAttachmentsChanged = (attachments: FinancialAccountControl['attachments']) => {
    if (!editing) return;
    const id = editing.id;
    setEditing((c) => (c ? { ...c, attachments } : c));
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, attachments } : r)));
    setSel((s) => (s && s.id === id ? { ...s, attachments } : s));
  };

  // Hard delete FÍSICO da conta (grupo Administrador). Remove a linha, ajusta os totais
  // localmente e recarrega os KPIs de situação. Irreversível — só é chamado após a
  // confirmação inline. Recebe a conta (não só o id) para ajustar "Valor total"/"Total
  // de registros" com precisão (esses cards EXCLUEM cancelado; a trigger já mantém o
  // status, então basta olhar o status_id da conta removida).
  const handleDelete = async (conta: FinancialAccountControl) => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteConta(conta.id);
      setRows((prev) => prev.filter((r) => r.id !== conta.id));
      setTotal((t) => Math.max(0, t - 1));
      if (conta.status_id !== STATUS_ID_CANCELADO) {
        setFilteredCount((c) => (c == null ? c : Math.max(0, c - 1)));
        setFilteredValue((v) => (v == null ? v : v - (conta.amount ?? 0)));
      }
      setSel((s) => (s && s.id === conta.id ? null : s));
      setConfirmDelete(null);
      void refreshStats();
    } catch (e) {
      setDeleteError(getErrorMessage(e));
    } finally {
      setDeleting(false);
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

  const columns = useMemo(
    () => getConsultaColumns(handleToggleFlag, handleStatusChange),
    [handleToggleFlag, handleStatusChange],
  );

  // Linhas carregadas SEM cancelado (N do rodapé). O grid ainda exibe as canceladas
  // (visíveis), mas elas não entram na contagem — assim "N de M" fica consistente
  // (N ≤ M, ambos sem cancelado). A paginação (hasMore) segue usando `total` (com
  // cancelado) para carregar todas as linhas do grid.
  const loadedNonCancelled = useMemo(
    () => rows.filter((r) => r.status_id !== STATUS_ID_CANCELADO).length,
    [rows],
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
        if (ticks % GRID_REFRESH_EVERY === 0) {
          void load(1, 'replace'); // grid sobe ao vivo (recomeça da 1ª página)
          void refreshStats();
        }
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
      await load(1, 'replace');
      void refreshStats();
    }
  }, [load, refreshStats]);

  // Buscar: aplica o filtro atual. Busca é GLOBAL — zera o período (mês/ano → "Todas")
  // para procurar em toda a base (inclui o intervalo De/Até, que filtra por dateField).
  // React faz batch dos setState — gera um único load novo.
  const handleSearch = () => {
    const next = { ...f, month: null, year: null };
    setF(next);
    setApplied(next);
    setActiveCard(null);
    setPage(1);
  };
  // Limpar: volta ao estado padrão (mês/ano corrente por vencimento) e reseta a ordenação.
  const handleClear = () => {
    const init = initialFilters();
    setF(init);
    setApplied(init);
    setActiveCard(null);
    setSort({ col: null, dir: null });
    setPage(1);
  };

  // Período (campo/mês/ano/"Todas"): aplica imediatamente em f e applied, como o
  // dashboard — os filtros de texto/select continuam dependendo de "Buscar".
  // NÃO limpa o card ativo: navegar por mês mantém o card destacado (narrows aquele
  // mês), e clicar o card de novo continua sendo o caminho de volta ao mês atual.
  const applyPeriod = (patch: Partial<ConsultaFilters>) => {
    setF((x) => ({ ...x, ...patch }));
    setApplied((a) => ({ ...a, ...patch }));
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

  // Cards são GLOBAIS: ativar um mostra TODOS os períodos do status (month/year null);
  // desligar volta ao padrão mês a mês (mês/ano corrente).
  const handleCardFilter = (cardId: string, filterOverride: Partial<ConsultaFilters>) => {
    setSort({ col: null, dir: null });
    if (activeCard === cardId) {
      setActiveCard(null);
      const init = initialFilters();
      setF(init);
      setApplied(init);
    } else {
      setActiveCard(cardId);
      const next = { ...allPeriodFilters(), ...filterOverride };
      setF(next);
      setApplied(next);
    }
    setPage(1);
  };

  // Rótulo do campo de data ativo (compartilhado pelos botões de mês e pelo intervalo De/Até).
  const dateFieldLabel = f.dateField === 'due_date' ? 'Vencimento' : 'Emissão';

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
      onCardClick: () => handleCardFilter('pago', { statusId: STATUS_ID_PAGO }),
    },
    {
      icon: Clock,
      label: 'A vencer',
      value: stats.aVencer ?? 0,
      fmt: (v) => v,
      amount: stats.aVencerValue ?? null,
      muted: true,
      cardId: 'avencer',
      onCardClick: () => handleCardFilter('avencer', { statusId: STATUS_ID_A_VENCER }),
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
      onCardClick: () => handleCardFilter('vencidas', { statusId: STATUS_ID_VENCIDO }),
    },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Barra superior em gradiente (2px) — acento de marca */}
      <div className="h-0.5 bg-linear-to-r from-brand to-brand-dark" />
      <div className="px-6 py-1 border-b border-slate-200 bg-white flex items-center justify-between">
        <div>
          <h1 className="text-sm font-semibold text-slate-800">Consulta de movimentações</h1>
          <p className="text-xs text-slate-500 mt-0.5">Contas a pagar</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => exportCsv(rows)} className="btn" disabled={!rows.length}>
            <Download size={14} /> Exportar carregados ({rows.length})
          </button>
          {/* "Atualizar" dispara a leitura IMAP (Flask local) — oculto em produção. */}
          {EMAIL_READER_ENABLED && (
            <button
              onClick={handleRefresh}
              className="btn"
              disabled={reading || loading}
              title="Buscar e-mails dos últimos 7 dias e atualizar a consulta"
            >
              <RefreshCw size={14} className={reading || loading ? 'animate-spin' : ''} />
              Atualizar
            </button>
          )}
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

        {/* Período: tipo de data (vencimento/emissão) + mês + ano + "Todas" — mesmo
            princípio do Dashboard. O seletor "Tipo de data" fica AQUI, junto do período
            que ele controla (campo usado pelos botões de mês E pelo intervalo De/Até).
            Aplica imediatamente; o grid e o card "Valor total" seguem o período (cards de KPI ficam globais). */}
        <div className="flex items-center justify-start gap-3 flex-wrap mb-2">
          {/* Tipo de data: coluna usada pelos botões de mês E pelo intervalo De/Até.
              Aplica imediatamente (re-filtra a visão atual na nova coluna). */}
          <select
            id="consulta-date-field"
            name="consulta-date-field"
            aria-label="Tipo de data (vencimento ou emissão)"
            className="input h-7 w-32 py-0 text-xs"
            value={f.dateField}
            onChange={(e) => applyPeriod({ dateField: e.target.value as ConsultaFilters['dateField'] })}
          >
            <option value="due_date">Vencimento</option>
            <option value="issue_date">Emissão</option>
          </select>

          <div className="flex gap-0.5 flex-wrap" role="group" aria-label="Filtrar por mês">
            {MONTHS.map((m, i) => (
              <button
                key={m}
                onClick={() => applyPeriod({ month: i, year: f.year ?? nowRef.year, dateFrom: '', dateTo: '' })}
                aria-label={`Mês ${MONTHS_FULL[i]}`}
                aria-pressed={f.month === i}
                className={`text-xs px-2 py-0.5 rounded-sm transition-colors ${f.month === i ? 'bg-brand-light text-brand-dark font-semibold' : 'text-slate-500 hover:bg-slate-100'}`}
              >
                {m}
              </button>
            ))}
          </div>

          <div className="flex gap-1" role="group" aria-label="Filtrar por ano">
            {[(f.year ?? nowRef.year) - 1, f.year ?? nowRef.year, (f.year ?? nowRef.year) + 1].map((y) => (
              <button
                key={y}
                onClick={() => applyPeriod({ year: y, month: f.month ?? nowRef.month, dateFrom: '', dateTo: '' })}
                aria-pressed={f.year === y}
                className={`text-xs font-medium px-2.5 py-1 rounded-md border transition-colors ${f.year === y ? 'bg-brand-dark border-brand-dark text-white' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}
              >
                {y}
              </button>
            ))}
          </div>

          <button
            onClick={() => applyPeriod({ month: null, year: null, dateFrom: '', dateTo: '' })}
            aria-label="Todas as datas"
            aria-pressed={f.month === null}
            className={`text-xs font-medium px-2.5 py-1 rounded-md border transition-colors ${f.month === null ? 'bg-brand-dark border-brand-dark text-white' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}
          >
            Todas
          </button>
        </div>

        <div className="flex gap-2 flex-wrap mb-2">
          <div className="relative w-90 max-w-full">
            <input
              id="consulta-supplier"
              name="consulta-supplier"
              aria-label="Buscar por fornecedor, CNPJ, número do documento, valor, assunto, remetente, e-mail do fornecedor, centro de custo, plano de contas, grupo ou subgrupo"
              className="input w-full pr-8"
              placeholder="Fornecedor, Nº doc, valor, assunto, centro de custo, plano de contas…"
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
          {/* Empresa pagadora — logo após a busca (espelha a ordem do grid: Fornecedor →
              Empresa). Vazio = TODAS. Filtra o grid e os cards "Valor total"/"Total de
              registros"; os KPIs gerais são globais por design. */}
          <select
            id="consulta-company"
            name="consulta-company"
            aria-label="Filtrar por empresa"
            className="input w-36"
            value={f.skCompany == null ? '' : String(f.skCompany)}
            onChange={(e) => sf('skCompany', e.target.value ? Number(e.target.value) : undefined)}
          >
            <option value="">Empresa</option>
            {companyOptions.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <select id="consulta-doc-type" name="consulta-doc-type" aria-label="Filtrar por tipo de documento" className="input w-40" value={f.docType} onChange={(e) => sf('docType', e.target.value)}>
            <option value="">Tipo Documento</option>
            {DOCUMENT_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <select id="consulta-payment-method" name="consulta-payment-method" aria-label="Filtrar por tipo de pagamento" className="input w-36" value={f.paymentMethod} onChange={(e) => sf('paymentMethod', e.target.value)}>
            <option value="">Tipo Pagamento</option>
            {PAYMENT_METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <select
            id="consulta-status"
            name="consulta-status"
            aria-label="Filtrar por situação"
            className="input w-32"
            value={f.statusId == null ? '' : String(f.statusId)}
            onChange={(e) => sf('statusId', e.target.value ? Number(e.target.value) : undefined)}
          >
            <option value="">Situação</option>
            {STATUS_FILTER_OPTIONS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          {/* Intervalo De/Até — busca GLOBAL por range de data na coluna escolhida no
              seletor "Tipo de data" da barra de período (acima). Aplica via "Buscar" (ou Enter). */}
          <input
            id="consulta-date-from"
            name="consulta-date-from"
            aria-label={`${dateFieldLabel} — data inicial`}
            type="date"
            className="input w-36"
            value={f.dateFrom}
            max={f.dateTo || undefined}
            onChange={(e) => sf('dateFrom', e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSearch();
            }}
            title={`${dateFieldLabel} de`}
          />
          <input
            id="consulta-date-to"
            name="consulta-date-to"
            aria-label={`${dateFieldLabel} — data final`}
            type="date"
            className="input w-36"
            value={f.dateTo}
            min={f.dateFrom || undefined}
            onChange={(e) => sf('dateTo', e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSearch();
            }}
            title={`${dateFieldLabel} até`}
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
            // Conta cancelada: linha inteira em vermelho mais saturado (status-error-solid/15)
            // — tom distinto do vermelho pálido do badge "vencido" (status-error-bg).
            rowClassName={(r) => (r.status_id === STATUS_ID_CANCELADO ? 'bg-status-error-solid/15' : undefined)}
            sortCol={sort.col}
            sortDir={sort.dir}
            onSort={handleSort}
            gridId="consulta"
            enableColumnManagement
            enableSelection
            enableRowVirtualization
            hasMore={rows.length < total}
            loadingMore={loadingMore}
            onLoadMore={loadMore}
            defaultPinning={CONSULTA_DEFAULT_PINNING}
            defaultDensity="compact"
            onExportSelected={exportCsv}
            bulkStatusOptions={STATUS_OPTIONS}
            onBulkStatusChange={handleBulkStatusChange}
            maxBodyHeight="78vh"
            loading={loading}
            emptyMessage={loading ? 'Buscando registros…' : 'Nenhum registro encontrado — ajuste os filtros e clique em Buscar'}
            // Rodapé SEMPRE-visível abaixo das células: a informação adicional do registro,
            // destacada em fonte (Jakarta itálica) e cor (brand) distintas das células.
            renderRowFooter={(r) =>
              r.additional_info ? (
                <div className="flex items-start gap-1.5 px-3 py-1.5 font-jakarta text-xs italic text-slate-600 whitespace-pre-wrap">
                  <Info size={13} className="mt-0.5 shrink-0 text-slate-500" aria-hidden="true" />
                  <span>
                    <span className="font-semibold not-italic">Informação adicional:</span> {r.additional_info}
                  </span>
                </div>
              ) : null
            }
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
                            <div className="mb-3 flex flex-wrap items-center gap-2">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditError(null);
                                  setEditWarning(null);
                                  setEditing(r);
                                }}
                                className="btn btn-primary"
                                title="Editar esta conta"
                              >
                                <Pencil size={14} /> Editar conta
                              </button>

                              {/* Hard delete — só o grupo Administrador. Confirmação inline
                                  (irreversível). Os botões contêm o próprio clique (não alternar
                                  a linha do <tr>). */}
                              {isAdminGroup &&
                                (confirmDelete === r.id ? (
                                  <span className="flex items-center gap-2">
                                    <span className="text-xs font-medium text-status-error-fg">
                                      Excluir permanentemente?
                                    </span>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void handleDelete(r);
                                      }}
                                      disabled={deleting}
                                      className="inline-flex items-center gap-1 rounded-md bg-status-error-fg px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
                                    >
                                      <Trash2 size={14} /> {deleting ? 'Excluindo…' : 'Excluir'}
                                    </button>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setConfirmDelete(null);
                                        setDeleteError(null);
                                      }}
                                      disabled={deleting}
                                      className="btn"
                                    >
                                      Cancelar
                                    </button>
                                  </span>
                                ) : (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setDeleteError(null);
                                      setConfirmDelete(r.id);
                                    }}
                                    className="inline-flex items-center gap-1 rounded-md border border-status-error-border px-3 py-1.5 text-sm font-medium text-status-error-fg hover:bg-status-error-bg"
                                    title="Excluir permanentemente esta conta (grupo Administrador)"
                                  >
                                    <Trash2 size={14} /> Excluir conta
                                  </button>
                                ))}
                            </div>
                            {deleteError && confirmDelete === r.id && (
                              <p className="mb-3 text-xs text-status-error-fg">{deleteError}</p>
                            )}
                            {/* Anexos (N) — e-mail + enviados pelo usuário, no mesmo padrão.
                                Substituiu o botão único "Ver anexo" (era 1 arquivo só, o do
                                e-mail). Sem lixeira aqui: a remoção é feita pelo modal de
                                edição. Quem contém o clique para não alternar a linha do <tr>
                                são os próprios botões (AttachmentList/AttachmentViewer), como
                                fazem os botões acima — não um <div> wrapper com onClick, que
                                seria um elemento não-interativo com handler (S1082). */}
                            <div className="mb-3">
                              <ContaAttachments
                                accountId={r.id}
                                items={r.attachments}
                                legacySourceFile={r.source_file}
                                canRemove={false}
                              />
                            </div>
                            <dl className="grid grid-cols-2 rounded-lg overflow-hidden border border-slate-100">
                              {(
                                [
                                  ['ID', String(r.id)],
                                  ['Fornecedor', fmtSupplier(r)],
                                  // Empresa PAGADORA (company.trade_name via FK sk_company) —
                                  // logo APÓS o Fornecedor, espelhando a ordem do grid. São coisas
                                  // distintas: a conta pode ser da LEBIANCO e o fornecedor, OTIMOTEX.
                                  ['Empresa', r.company?.trade_name ?? '—'],
                                  ['Assunto', r.subject],
                                  ['Remetente', r.sender_email],
                                  ['CNPJ', fmtCnpj(r.supplier?.cnpj ?? null)],
                                  ['N° Documento', r.invoice_number],
                                  ['Competência', r.competence_date],
                                  ['Emissão', fmtDate(r.issue_date)],
                                  ['Vencimento', fmtDate(r.due_date)],
                                  ['Situação', r.status_dim?.status_name ?? '—'],
                                  ['Valor do documento', fmtMoney(r.amount)],
                                  ['Valor cobrado', fmtMoney(r.amount_charged)],
                                  ['Desconto / abatimentos', fmtMoney(r.discount)],
                                  ['Outras deduções', fmtMoney(r.other_deductions)],
                                  ['Mora / multa', fmtMoney(r.fine_interest)],
                                  ['Outros acréscimos', fmtMoney(r.other_additions)],
                                  ['Nosso número', r.nosso_numero || '—'],
                                  ['Centro de custo', fmtCostCenter(r)],
                                  ['Plano de contas', fmtChartAccount(r)],
                                  ['Forma de pag.', r.payment_method],
                                  ['Código de barras', r.barcode || '—'],
                                  ['Origem', r.source_file],
                                  ['Observações', r.processing_notes || '—'],
                                  ['Criado por', userEmail(r.created_by)],
                                  ...(isSentinelAuthor(r.updated_by)
                                    ? ([] as [string, string | null][])
                                    : ([['Última edição por', userEmail(r.updated_by)]] as [string, string | null][])),
                                  ...(isSentinelAuthor(r.status_changed_by)
                                    ? ([] as [string, string | null][])
                                    : ([[
                                        'Situação alterada por',
                                        `${userEmail(r.status_changed_by)} · ${fmtDateTime(r.status_changed_at)}`,
                                      ]] as [string, string | null][])),
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
                            {r.additional_info && (
                              <div className="mt-3 p-3 bg-white rounded-lg border border-slate-100">
                                <span className="badge bg-brand/10 text-brand mb-2">Informações adicionais</span>
                                <p className="text-xs text-slate-600 whitespace-pre-wrap">{r.additional_info}</p>
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
          <span className="text-xs text-slate-500">
            {loadedNonCancelled} de {filteredCount ?? loadedNonCancelled} registros
            {filteredValue != null && ` · Valor total: ${fmtMoney(filteredValue)}`}
          </span>
          {rows.length < total && (
            <button
              onClick={loadMore}
              disabled={loadingMore || loading}
              className="btn disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loadingMore ? 'Carregando…' : 'Carregar mais'}
            </button>
          )}
        </div>
      </div>


      {editing && (
        <dialog
          ref={editDialogRef}
          aria-label="Editar conta"
          onCancel={() => setEditing(null)}
          className="fixed inset-0 m-auto h-fit max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border-0 bg-white p-0 shadow-lg backdrop:bg-black/50"
        >
          <div className="p-4">
            <h2 className="mb-3 text-base font-semibold text-gray-900">Editar conta</h2>
            {editWarning && (
              <Alert variant="warning" className="mb-3">
                {editWarning}
              </Alert>
            )}
            <ContaForm
              mode="edit"
              defaultValues={editing}
              onSubmit={handleEditSubmit}
              onCancel={() => setEditing(null)}
              submitError={editError}
              submitting={editSubmitting}
              onAttachmentsChanged={handleAttachmentsChanged}
            />
          </div>
        </dialog>
      )}
    </div>
  );
}
