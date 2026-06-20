// pages/cobranca/cobrancaColumns.ts
// Definições de coluna dos grids de cobrança (envios/erros) no contrato do projeto
// (ColumnDef<T> de hooks/useGridColumns) — consumidas pelo DataGrid (organisms).
// Módulo de dados (.ts, sem componentes) — não dispara react-refresh/only-export-components.

import type { ColumnDef } from '../../hooks/useGridColumns';
import type { CobrancaEnvioLog, CobrancaErroLog } from '../../types/cobranca';
import { ERROR_TYPE_LABEL } from '../../types/cobranca';

const DASH = '—';

const fmtDate = (iso: string | null): string => {
  if (!iso) return DASH;
  const [y, m, d] = iso.split('T')[0].split('-');
  return `${d}/${m}/${y}`;
};

const fmtDateTime = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : DASH;

const fmtCurrency = (value: number | null): string =>
  value == null ? DASH : Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const enviosColumns: ColumnDef<CobrancaEnvioLog>[] = [
  { key: 'document_id', header: 'Título', size: 130, sortKey: 'document_id', render: (r) => r.document_id || DASH },
  { key: 'customer_name', header: 'Cliente', size: 220, truncate: true, sortKey: 'customer_name', render: (r) => r.customer_name || DASH },
  {
    key: 'primary_email',
    header: 'E-mail (To)',
    size: 210,
    truncate: true,
    hideOn: ['sm'],
    secondLine: true,
    secondLineLabel: 'E-mail',
    render: (r) => r.primary_email || DASH,
  },
  {
    key: 'cc_email',
    header: 'E-mail (Cc)',
    size: 210,
    truncate: true,
    hideOn: ['sm', 'md'],
    secondLine: true,
    secondLineLabel: 'Cc',
    render: (r) => r.cc_email || DASH,
  },
  { key: 'due_date', header: 'Vencimento', size: 110, hideOn: ['sm'], sortKey: 'due_date', render: (r) => fmtDate(r.due_date) },
  { key: 'bill_amount', header: 'Valor', size: 120, align: 'right', sortKey: 'bill_amount', render: (r) => fmtCurrency(r.bill_amount) },
  {
    key: 'email_subject',
    header: 'Assunto',
    size: 220,
    truncate: true,
    hideOn: ['sm', 'md'],
    secondLine: true,
    secondLineLabel: 'Assunto',
    render: (r) => r.email_subject || DASH,
  },
  { key: 'sent_at', header: 'Enviado em', size: 160, sortKey: 'sent_at', render: (r) => fmtDateTime(r.sent_at) },
];

export const errosColumns: ColumnDef<CobrancaErroLog>[] = [
  { key: 'document_id', header: 'Título', size: 130, render: (r) => r.document_id || DASH },
  { key: 'customer_name', header: 'Cliente', size: 200, truncate: true, render: (r) => r.customer_name || DASH },
  {
    key: 'primary_email',
    header: 'E-mail',
    size: 200,
    truncate: true,
    hideOn: ['sm'],
    secondLine: true,
    secondLineLabel: 'E-mail',
    render: (r) => r.primary_email || DASH,
  },
  { key: 'due_date', header: 'Vencimento', size: 110, hideOn: ['sm', 'md'], render: (r) => fmtDate(r.due_date) },
  { key: 'bill_amount', header: 'Valor', size: 120, align: 'right', hideOn: ['sm'], render: (r) => fmtCurrency(r.bill_amount) },
  { key: 'error_type', header: 'Tipo de erro', size: 150, render: (r) => ERROR_TYPE_LABEL[r.error_type] ?? r.error_type },
  { key: 'error_message', header: 'Motivo', size: 300, truncate: true, render: (r) => r.error_message || DASH },
  { key: 'occurred_at', header: 'Ocorreu em', size: 160, render: (r) => fmtDateTime(r.occurred_at) },
];
