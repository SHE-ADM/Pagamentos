import { createElement, type ReactNode, type MouseEvent } from 'react';
import { CheckCircle2, Pencil } from 'lucide-react';
import type {
  FinancialAccountControl,
  EmailControl,
  Supplier,
  CostCenter,
  Bank,
  FinancialAccount,
  ChartAccount,
  ChartAccountGroup,
  ChartAccountSubgroup,
} from '@sheild/shared';
import StatusBadge from '../components/StatusBadge';
import CheckToggle from '../components/atoms/CheckToggle';
import StatusSelectCell, { type StatusOption } from '../components/atoms/StatusSelectCell';
import type { FinancialAccountFlag } from '../services/supabase';

// Opções do dropdown inline de status — ordem de ciclo de vida, definida aqui como
// constante de módulo para evitar qualquer dependência de fetch ou timing de estado.
// Os labels usam capitalização padrão; 'cartório' preserva o acento do valor no banco.
export const STATUS_OPTIONS: readonly StatusOption[] = [
  { value: 'pendente',    label: 'Pendente' },
  { value: 'a vencer',   label: 'A Vencer' },
  { value: 'vencido',    label: 'Vencido' },
  { value: 'prorrogado', label: 'Prorrogado' },
  { value: 'baixado',    label: 'Baixado' },
  { value: 'protestado', label: 'Protestado' },
  { value: 'cartório',   label: 'Cartório' },
  { value: 'pago',       label: 'Pago' },
  { value: 'cancelado',  label: 'Cancelado' },
  { value: 'falha',      label: 'Falha' },
];

/** Callback acionado ao marcar/desmarcar um checkbox de flag na célula do grid. */
export type ToggleFlag = (
  row: FinancialAccountControl,
  field: FinancialAccountFlag,
  value: boolean,
) => void;

/** Callback acionado ao alterar o status de uma conta no dropdown inline. */
export type StatusChangeCallback = (rowId: number, newStatus: string) => Promise<void>;

// Formatters — cópia das implementações de Consulta.tsx. A consolidação num
// módulo único (src/lib) é follow-up de quando Consulta.tsx for migrado ao hook.
const fmtDate = (d: string | null): string =>
  d ? new Date(d + 'T00:00:00').toLocaleDateString('pt-BR') : '—';

const fmtMoney = (v: number | null): string =>
  v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const fmtCnpj = (c: string | null): string =>
  c?.length === 14
    ? `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`
    : c || '—';

const fmtCpf = (c: string | null): string =>
  c?.length === 11 ? `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}` : c || '—';

// Classificação contábil (embeds cost_center / chart_account — código + descrição).
// id 0 = "não informado" (sentinela) → exibe '—' (o plano id 0 tem código literal '0').
const fmtCostCenter = (r: FinancialAccountControl): string =>
  r.cost_center_id
    ? [r.cost_center?.cost_center_code, r.cost_center?.cost_center_description].filter(Boolean).join(' — ') || `#${r.cost_center_id}`
    : '—';

const fmtChartAccount = (r: FinancialAccountControl): string =>
  r.chart_account_id
    ? [r.chart_account?.account_code, r.chart_account?.account_description].filter(Boolean).join(' — ') || `#${r.chart_account_id}`
    : '—';

// Data + hora (coluna "Recebido" do grid de /emails — cópia do `fmt` de Emails.tsx).
const fmtDateTime = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

/** Metadata de uma coluna do grid — fonte única para cabeçalho, render e responsividade. */
export interface ColumnDef<T> {
  // Identidade da coluna (React key + id de preferências de layout). Geralmente um
  // campo de T, mas aceita string sintética para colunas derivadas de JOIN
  // (ex.: 'supplier_name'/'supplier_cnpj' vêm do recurso embutido `supplier`,
  // não são mais colunas próprias — migrations 040/041). `(string & {})` preserva
  // o autocomplete das chaves reais sem travar as sintéticas.
  key: keyof T | (string & {});
  header: string;
  /** Campo enviado ao Supabase para ordenação (mapeia ao SORT_COLS de Consulta). */
  sortKey?: string;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Breakpoints em que a coluna some da linha principal (sm=mobile, md=tablet). */
  hideOn?: Array<'sm' | 'md'>;
  /** Se true, ao ficar oculta a coluna desce para a linha de detalhe (segunda linha). */
  secondLine?: boolean;
  /** Rótulo exibido ao lado do valor na linha secundária. */
  secondLineLabel?: string;
  /** Trunca texto longo na célula (com `title`) — evita estourar a largura no mobile. */
  truncate?: boolean;
  /** Quebra o texto em várias linhas (word-wrap) em vez de truncar — colunas largas. */
  wrap?: boolean;
  className?: string;
  /** Largura inicial (px) da coluna no layout gerenciável (resize/pin). Default 160. */
  size?: number;
  /** Largura mínima (px) no resize — evita comprimir números/datas a ponto de ilegíveis. */
  minSize?: number;
}

/**
 * Definição de todas as colunas do grid de /consulta, na ordem de exibição.
 * É uma **factory** (não constante) porque as colunas "Tem NF", "Tem Boleto" e
 * "Situação" renderizam células interativas que escrevem no banco — precisam dos
 * callbacks fornecidos pela página (que fazem o update otimista + persistência REST).
 */
export function getConsultaColumns(
  onToggleFlag: ToggleFlag,
  onStatusChange: StatusChangeCallback,
): ColumnDef<FinancialAccountControl>[] {
  return [
  {
    key: 'invoice_number',
    header: 'Nº Documento',
    size: 130,
    minSize: 110,
    sortKey: 'invoice_number',
    hideOn: ['sm'],
    render: (r) => r.invoice_number ?? '—',
  },
  {
    key: 'issue_date',
    header: 'Emissão',
    size: 100,
    minSize: 90,
    sortKey: 'issue_date',
    hideOn: ['sm', 'md'],
    render: (r) => fmtDate(r.issue_date),
  },
  {
    // Fornecedor vem do JOIN com `supplier` (migrations 040/041); não é coluna própria
    // de financial_account_control, então não é ordenável server-side. Texto longo
    // QUEBRA em várias linhas (wrap) em vez de truncar — coluna mais estreita.
    key: 'supplier_name',
    header: 'Fornecedor',
    size: 170,
    minSize: 130,
    wrap: true,
    render: (r) => r.supplier?.trade_name ?? r.supplier?.legal_name ?? '—',
  },
  {
    key: 'document_type',
    header: 'Tipo Documento',
    size: 100,
    minSize: 90,
    sortKey: 'document_type',
    hideOn: ['sm', 'md'],
    secondLine: true,
    secondLineLabel: 'Tipo',
    render: (r) => r.document_type ?? '—',
  },
  {
    key: 'payment_method',
    header: 'Tipo Pagamento',
    size: 110,
    minSize: 90,
    sortKey: 'payment_method',
    hideOn: ['sm', 'md'],
    secondLine: true,
    secondLineLabel: 'Pgto',
    render: (r) => r.payment_method ?? '—',
  },
  {
    // Classificação contábil — vem dos embeds (JOIN); não é ordenável server-side.
    // Texto longo QUEBRA em várias linhas (wrap) em vez de truncar.
    key: 'cost_center',
    header: 'Centro de custo',
    size: 140,
    minSize: 120,
    hideOn: ['sm', 'md'],
    secondLine: true,
    secondLineLabel: 'C. Custo',
    wrap: true,
    render: fmtCostCenter,
  },
  {
    key: 'chart_account',
    header: 'Plano de contas',
    size: 180,
    minSize: 120,
    hideOn: ['sm', 'md'],
    secondLine: true,
    secondLineLabel: 'Plano',
    wrap: true,
    render: fmtChartAccount,
  },
  {
    key: 'due_date',
    header: 'Vencimento',
    size: 110,
    minSize: 90,
    sortKey: 'due_date',
    render: (r) => fmtDate(r.due_date),
  },
  {
    key: 'amount',
    header: 'Valor',
    size: 120,
    minSize: 90,
    sortKey: 'amount',
    align: 'right',
    render: (r) => fmtMoney(r.amount),
  },
  {
    key: 'has_invoice',
    header: 'NF',
    size: 56,
    minSize: 48,
    align: 'center',
    render: (r) =>
      createElement(CheckToggle, {
        checked: r.has_invoice,
        ariaLabel: `Tem NF — ${r.supplier?.trade_name ?? r.supplier?.legal_name ?? 'registro'}`,
        onToggle: (v: boolean) => onToggleFlag(r, 'has_invoice', v),
      }),
  },
  {
    key: 'has_bank_slip',
    header: 'BOL',
    size: 56,
    minSize: 48,
    align: 'center',
    render: (r) =>
      createElement(CheckToggle, {
        checked: r.has_bank_slip,
        ariaLabel: `Tem Boleto — ${r.supplier?.trade_name ?? r.supplier?.legal_name ?? 'registro'}`,
        onToggle: (v: boolean) => onToggleFlag(r, 'has_bank_slip', v),
      }),
  },
  {
    key: 'status',
    header: 'Situação',
    size: 148,
    minSize: 120,
    // Ordenação de "Situação" é ALFABÉTICA pelo nome (equivale a ORDER BY status_name na
    // dimensão `status`). Decisão de negócio: o ciclo de vida não é estritamente linear —
    // de "a vencer" pode-se ir direto para "cancelado", "falha" etc. —, então a ordem por
    // `status_id` não representa uma sequência real e a alfabética é mais previsível.
    // sortKey usa `status` (coluna de texto da financial_account_control); `status_name`
    // só existe na dimensão `status` e não é uma coluna ordenável deste endpoint.
    sortKey: 'status',
    render: (r) =>
      createElement(StatusSelectCell, {
        rowId: r.id,
        value: r.status ?? 'pendente',
        options: STATUS_OPTIONS,
        onSave: onStatusChange,
      }),
  },
  {
    key: 'extraction_source',
    header: 'Extração',
    size: 120,
    minSize: 100,
    sortKey: 'extraction_source',
    hideOn: ['sm', 'md'],
    render: (r) => createElement(StatusBadge, { value: r.extraction_source }),
  },
  ];
}

/**
 * Colunas do grid de /emails. É uma **factory** (não constante) porque o "Nº
 * Documento" não vem da linha `EmailControl`: é resolvido por `message_id` no
 * `invoiceMap` (estado carregado pela página). As colunas não têm `sortKey` — o
 * grid de e-mails não ordena por cabeçalho (mantém o comportamento atual).
 */
export function getEmailColumns(invoiceMap: Record<string, string>): ColumnDef<EmailControl>[] {
  return [
    {
      key: 'message_id',
      header: 'Nº Documento',
      size: 150,
      hideOn: ['sm'],
      render: (r) => invoiceMap[r.message_id ?? ''] || '—',
    },
    {
      key: 'received_at',
      header: 'Recebido',
      size: 160,
      hideOn: ['sm', 'md'],
      secondLine: true,
      secondLineLabel: 'Recebido',
      render: (r) => fmtDateTime(r.received_at),
    },
    {
      key: 'sender_email',
      header: 'Remetente',
      size: 220,
      truncate: true,
      render: (r) => r.sender_name || r.sender_email || '—',
    },
    {
      key: 'subject',
      header: 'Assunto',
      size: 300,
      truncate: true,
      render: (r) => r.subject ?? '—',
    },
    {
      key: 'keyword_matched',
      header: 'Tipo documento',
      size: 150,
      hideOn: ['sm', 'md'],
      secondLine: true,
      secondLineLabel: 'Tipo documento',
      render: (r) => createElement(StatusBadge, { value: r.keyword_matched }),
    },
    {
      key: 'has_attachment',
      header: 'PDF',
      size: 64,
      align: 'center',
      hideOn: ['sm', 'md'],
      render: (r) => (r.has_attachment ? '✓' : '—'),
    },
    {
      key: 'pdf_extracted',
      header: 'Extração',
      size: 120,
      hideOn: ['sm', 'md'],
      render: (r) => (r.pdf_extracted ? createElement(StatusBadge, { value: 'extracted' }) : '—'),
    },
    {
      key: 'status',
      header: 'Status',
      size: 150,
      // E-mail 'falha' já revisado (card de detalhes aberto) ganha um check verde
      // ao lado do badge — sinaliza visualmente o que o usuário já triou.
      render: (r) => {
        const badge = createElement(StatusBadge, { value: r.status });
        if (r.status !== 'falha' || !r.reviewed_at) return badge;
        return createElement(
          'span',
          {
            className: 'inline-flex items-center gap-1',
            title: `Revisado em ${fmtDateTime(r.reviewed_at)}`,
          },
          badge,
          createElement(CheckCircle2, {
            size: 14,
            className: 'text-status-success-fg shrink-0',
            'aria-label': 'Revisado',
          }),
        );
      },
    },
  ];
}

/** Callback acionado pelos botões de ação (editar/excluir) da linha de fornecedor. */
type SupplierRowAction = (supplier: Supplier) => void;

// Botão de ação na célula — para o clique (stopPropagation) não disparar o clique da
// linha (que abre a edição). Cada um leva aria-label descritivo com o nome do fornecedor.
function actionButton(
  icon: typeof Pencil,
  label: string,
  className: string,
  onClick: () => void,
): ReactNode {
  return createElement(
    'button',
    {
      type: 'button',
      'aria-label': label,
      title: label,
      className,
      onClick: (e: MouseEvent) => {
        e.stopPropagation();
        onClick();
      },
    },
    createElement(icon, { size: 15 }),
  );
}

const supplierLabel = (s: Supplier): string => s.trade_name ?? s.legal_name ?? `#${s.sk_supplier}`;

/** Callbacks de ação (editar/excluir) da linha de centro de custo. */
type CostCenterRowAction = (costCenter: CostCenter) => void;

const costCenterLabel = (c: CostCenter): string =>
  c.cost_center_code ?? c.cost_center_description ?? `#${c.cost_center_id}`;

// Classe do botão de ação dos grids de cadastro (fonte única).
const EDIT_BTN_CLS =
  'inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-brand transition-colors';

// Célula "Ações" padrão dos CRUDs de cadastro: apenas editar (a exclusão foi removida da UI).
function editCell<T>(row: T, label: string, onEdit: (r: T) => void): ReactNode {
  return actionButton(Pencil, `Editar ${label}`, EDIT_BTN_CLS, () => onEdit(row));
}

/**
 * Colunas do grid de /tabelas/centros-de-custo. É uma **factory** porque a coluna
 * "Ações" renderiza o botão de editar, que depende do callback da página.
 */
export function getCostCenterColumns(onEdit: CostCenterRowAction): ColumnDef<CostCenter>[] {
  return [
    {
      key: 'cost_center_code',
      header: 'Código',
      size: 160,
      truncate: true,
      render: (c) => c.cost_center_code ?? '—',
    },
    {
      key: 'cost_center_description',
      header: 'Descrição',
      size: 360,
      wrap: true,
      render: (c) => c.cost_center_description ?? '—',
    },
    {
      key: '__actions__',
      header: 'Ações',
      size: 72,
      align: 'center',
      render: (c) => editCell(c, costCenterLabel(c), onEdit),
    },
  ];
}

/**
 * Colunas do grid de /fornecedores. É uma **factory** porque a coluna "Ações"
 * renderiza o botão de editar, que depende do callback da página.
 */
export function getSupplierColumns(onEdit: SupplierRowAction): ColumnDef<Supplier>[] {
  return [
    {
      key: 'legal_name',
      header: 'Razão social',
      size: 240,
      truncate: true,
      render: (s) => s.legal_name ?? '—',
    },
    {
      key: 'trade_name',
      header: 'Nome fantasia',
      size: 200,
      truncate: true,
      render: (s) => s.trade_name ?? '—',
    },
    {
      key: 'cnpj',
      header: 'CNPJ',
      size: 170,
      hideOn: ['sm'],
      secondLine: true,
      secondLineLabel: 'CNPJ',
      render: (s) => fmtCnpj(s.cnpj),
    },
    {
      key: 'cpf',
      header: 'CPF',
      size: 140,
      hideOn: ['sm', 'md'],
      secondLine: true,
      secondLineLabel: 'CPF',
      render: (s) => (s.cpf ? fmtCpf(s.cpf) : '—'),
    },
    {
      key: 'email',
      header: 'E-mail',
      size: 220,
      hideOn: ['sm', 'md'],
      truncate: true,
      render: (s) => s.email ?? '—',
    },
    {
      key: '__actions__',
      header: 'Ações',
      size: 72,
      align: 'center',
      render: (s) =>
        actionButton(
          Pencil,
          `Editar ${supplierLabel(s)}`,
          'inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-brand transition-colors',
          () => onEdit(s),
        ),
    },
  ];
}

// ── Cadastros do grupo Tabelas (bancos, contas, plano/grupos/subgrupos) ──────────
// Cada factory recebe o callback de editar da página (célula "Ações" só-edição).

const ACTIONS_COL_SIZE = 72;

/** Junta código + descrição de um embed ("código — descrição"), com fallbacks. */
const joinCodeDesc = (code?: string | null, desc?: string | null): string =>
  [code, desc].filter(Boolean).join(' — ') || '—';

type RowAction<T> = (row: T) => void;

export function getBankColumns(onEdit: RowAction<Bank>): ColumnDef<Bank>[] {
  const label = (b: Bank): string => b.bank_code ?? b.bank_name ?? `#${b.bank_id}`;
  return [
    { key: 'bank_code', header: 'Código', size: 120, render: (b) => b.bank_code ?? '—' },
    { key: 'bank_name', header: 'Nome', size: 360, wrap: true, render: (b) => b.bank_name ?? '—' },
    {
      key: '__actions__',
      header: 'Ações',
      size: ACTIONS_COL_SIZE,
      align: 'center',
      render: (b) => editCell(b, label(b), onEdit),
    },
  ];
}

/**
 * Colunas de /tabelas/contas (financial_account). `statusLabel` resolve o nome da
 * situação (status_id → status_name) a partir do lookup carregado pela página.
 */
export function getFinancialAccountColumns(
  statusLabel: (statusId: number) => string,
  onEdit: RowAction<FinancialAccount>,
): ColumnDef<FinancialAccount>[] {
  const label = (a: FinancialAccount): string => a.account_description ?? `#${a.financial_account_id}`;
  return [
    { key: 'account_description', header: 'Descrição', size: 240, wrap: true, render: (a) => a.account_description ?? '—' },
    {
      key: 'bank',
      header: 'Banco',
      size: 220,
      wrap: true,
      render: (a) => joinCodeDesc(a.bank?.bank_code, a.bank?.bank_name),
    },
    { key: 'currency_code', header: 'Moeda', size: 90, render: (a) => a.currency_code ?? '—' },
    { key: 'balance_amount', header: 'Saldo', size: 120, align: 'right', render: (a) => fmtMoney(a.balance_amount) },
    { key: 'payment_type_id', header: 'Tipo pgto', size: 100, align: 'right', render: (a) => String(a.payment_type_id) },
    { key: 'status_id', header: 'Situação', size: 130, render: (a) => statusLabel(a.status_id) },
    {
      key: '__actions__',
      header: 'Ações',
      size: ACTIONS_COL_SIZE,
      align: 'center',
      render: (a) => editCell(a, label(a), onEdit),
    },
  ];
}

export function getChartAccountColumns(onEdit: RowAction<ChartAccount>): ColumnDef<ChartAccount>[] {
  const label = (c: ChartAccount): string => c.account_code ?? c.account_description ?? `#${c.chart_account_id}`;
  return [
    { key: 'account_code', header: 'Código', size: 130, render: (c) => c.account_code ?? '—' },
    { key: 'account_description', header: 'Descrição', size: 260, wrap: true, render: (c) => c.account_description ?? '—' },
    {
      key: 'subgroup',
      header: 'Subgrupo',
      size: 200,
      wrap: true,
      hideOn: ['sm', 'md'],
      render: (c) => joinCodeDesc(c.subgroup?.subgroup_code, c.subgroup?.subgroup_description),
    },
    {
      key: 'cost_center',
      header: 'Centro de custo',
      size: 180,
      wrap: true,
      hideOn: ['sm', 'md'],
      render: (c) => (c.cost_center_id ? joinCodeDesc(c.cost_center?.cost_center_code, c.cost_center?.cost_center_description) : '—'),
    },
    { key: 'account_level', header: 'Nível', size: 70, align: 'right', hideOn: ['sm'], render: (c) => String(c.account_level) },
    { key: 'is_postable', header: 'Lançável', size: 90, align: 'center', render: (c) => (c.is_postable ? '✓' : '—') },
    {
      key: '__actions__',
      header: 'Ações',
      size: ACTIONS_COL_SIZE,
      align: 'center',
      render: (c) => editCell(c, label(c), onEdit),
    },
  ];
}

export function getChartAccountGroupColumns(
  onEdit: RowAction<ChartAccountGroup>,
): ColumnDef<ChartAccountGroup>[] {
  const label = (g: ChartAccountGroup): string => g.group_code ?? g.group_description ?? `#${g.chart_account_group_id}`;
  return [
    { key: 'group_code', header: 'Código', size: 120, render: (g) => g.group_code ?? '—' },
    { key: 'group_description', header: 'Descrição', size: 320, wrap: true, render: (g) => g.group_description ?? '—' },
    { key: 'group_type', header: 'Tipo', size: 80, align: 'center', render: (g) => g.group_type ?? '—' },
    {
      key: '__actions__',
      header: 'Ações',
      size: ACTIONS_COL_SIZE,
      align: 'center',
      render: (g) => editCell(g, label(g), onEdit),
    },
  ];
}

export function getChartAccountSubgroupColumns(
  onEdit: RowAction<ChartAccountSubgroup>,
): ColumnDef<ChartAccountSubgroup>[] {
  const label = (s: ChartAccountSubgroup): string =>
    s.subgroup_code ?? s.subgroup_description ?? `#${s.chart_account_subgroup_id}`;
  return [
    { key: 'subgroup_code', header: 'Código', size: 130, render: (s) => s.subgroup_code ?? '—' },
    { key: 'subgroup_description', header: 'Descrição', size: 280, wrap: true, render: (s) => s.subgroup_description ?? '—' },
    {
      key: 'group',
      header: 'Grupo',
      size: 220,
      wrap: true,
      render: (s) => joinCodeDesc(s.group?.group_code, s.group?.group_description),
    },
    {
      key: '__actions__',
      header: 'Ações',
      size: ACTIONS_COL_SIZE,
      align: 'center',
      render: (s) => editCell(s, label(s), onEdit),
    },
  ];
}
