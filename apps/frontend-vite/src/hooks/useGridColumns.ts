import { createElement, type ReactNode } from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { FinancialAccountControl, EmailControl } from '@sheild/shared';
import StatusBadge from '../components/StatusBadge';

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

const fmtCnpjOrCpf = (cnpj: string | null, cpf: string | null): string =>
  cpf != null && cpf !== '' ? fmtCpf(cpf) : fmtCnpj(cnpj);

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
  key: keyof T;
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
  className?: string;
}

/** Definição de todas as colunas do grid de /consulta, na ordem de exibição. */
export const CONSULTA_COLUMNS: ColumnDef<FinancialAccountControl>[] = [
  {
    key: 'invoice_number',
    header: 'Nº Documento',
    sortKey: 'invoice_number',
    hideOn: ['sm'],
    render: (r) => r.invoice_number ?? '—',
  },
  {
    key: 'issue_date',
    header: 'Emissão',
    sortKey: 'issue_date',
    hideOn: ['sm', 'md'],
    render: (r) => fmtDate(r.issue_date),
  },
  {
    key: 'supplier_name',
    header: 'Fornecedor',
    sortKey: 'supplier_name',
    truncate: true,
    render: (r) => r.supplier_name ?? '—',
  },
  {
    key: 'supplier_cnpj',
    header: 'CNPJ / CPF',
    sortKey: 'supplier_cnpj',
    hideOn: ['sm'],
    secondLine: true,
    secondLineLabel: 'CNPJ',
    render: (r) => fmtCnpjOrCpf(r.supplier_cnpj, r.supplier_cpf),
  },
  {
    key: 'document_type',
    header: 'Tipo Doc.',
    sortKey: 'document_type',
    hideOn: ['sm', 'md'],
    secondLine: true,
    secondLineLabel: 'Tipo',
    render: (r) => r.document_type ?? '—',
  },
  {
    key: 'payment_method',
    header: 'Pagamento',
    sortKey: 'payment_method',
    hideOn: ['sm', 'md'],
    secondLine: true,
    secondLineLabel: 'Pgto',
    render: (r) => r.payment_method ?? '—',
  },
  {
    key: 'due_date',
    header: 'Vencimento',
    sortKey: 'due_date',
    render: (r) => fmtDate(r.due_date),
  },
  {
    key: 'amount',
    header: 'Valor',
    sortKey: 'amount',
    align: 'right',
    render: (r) => fmtMoney(r.amount),
  },
  {
    key: 'due_status',
    header: 'Situação',
    sortKey: 'due_status',
    render: (r) => createElement(StatusBadge, { value: r.due_status }),
  },
  {
    key: 'extraction_source',
    header: 'Extração',
    sortKey: 'extraction_source',
    hideOn: ['sm', 'md'],
    render: (r) => createElement(StatusBadge, { value: r.extraction_source }),
  },
];

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
      hideOn: ['sm'],
      render: (r) => invoiceMap[r.message_id ?? ''] || '—',
    },
    {
      key: 'received_at',
      header: 'Recebido',
      hideOn: ['sm', 'md'],
      secondLine: true,
      secondLineLabel: 'Recebido',
      render: (r) => fmtDateTime(r.received_at),
    },
    {
      key: 'sender_email',
      header: 'Remetente',
      truncate: true,
      render: (r) => r.sender_name || r.sender_email || '—',
    },
    {
      key: 'subject',
      header: 'Assunto',
      truncate: true,
      render: (r) => r.subject ?? '—',
    },
    {
      key: 'keyword_matched',
      header: 'Tipo documento',
      hideOn: ['sm', 'md'],
      secondLine: true,
      secondLineLabel: 'Tipo documento',
      render: (r) => createElement(StatusBadge, { value: r.keyword_matched }),
    },
    {
      key: 'has_attachment',
      header: 'PDF',
      align: 'center',
      hideOn: ['sm', 'md'],
      render: (r) => (r.has_attachment ? '✓' : '—'),
    },
    {
      key: 'pdf_extracted',
      header: 'Extração',
      hideOn: ['sm', 'md'],
      render: (r) => (r.pdf_extracted ? createElement(StatusBadge, { value: 'extracted' }) : '—'),
    },
    {
      key: 'status',
      header: 'Status',
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
