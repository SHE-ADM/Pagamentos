// Lógica de variante/resolução do StatusBadge — separada do componente para
// não disparar o aviso react-refresh/only-export-components (Fast Refresh).
import { cva, type VariantProps } from 'class-variance-authority';

const BASE =
  'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium tracking-wide';

/** Estilo do badge por variante — fonte única via CVA (cada classe é literal p/ o JIT). */
export const badgeVariants = cva(BASE, {
  variants: {
    variant: {
      amber: 'bg-amber-50 text-amber-700 border border-amber-200', // pendente / atenção
      emerald: 'bg-emerald-50 text-emerald-700 border border-emerald-200', // sucesso / pago
      red: 'bg-red-50 text-red-600 border border-red-200', // erro / vencido
      slate: 'bg-slate-100 text-slate-500 border border-slate-200', // neutro / cancelado
      blue: 'bg-blue-50 text-blue-600 border border-blue-200', // informativo / a vencer
      document: 'bg-slate-50 text-slate-600 border border-slate-200', // tipos de documento
      source: 'bg-teal-50 text-teal-700 border border-teal-200', // origem da extração
      neutral: 'bg-slate-50 text-slate-600 border border-slate-200', // fallback não mapeado
    },
  },
  defaultVariants: { variant: 'neutral' },
});

/** Variante visual do badge — reutilizável por outros componentes. */
export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

// Valores de status/situação — recebem ponto colorido à esquerda.
const STATUS_VARIANT: Record<string, BadgeVariant> = {
  // financial_emails.status
  pending: 'amber',
  paid: 'emerald',
  error: 'red',
  cancelled: 'slate',
  // due_status (migration 004)
  'A Vencer': 'blue',
  Vencido: 'red',
  // email_control.status
  extracted: 'emerald',
  downloaded: 'blue',
  received: 'slate',
  ignored: 'slate',
  // email_processing_errors.error_type
  sem_valor: 'amber',
  sem_fornecedor: 'amber',
  pdf_protegido: 'amber',
  extracao_falhou: 'red',
  db_erro: 'red',
  processamento_erro: 'red',
};

// Tipos de documento (document_type / payment_method) — slate + ícone de documento.
// Comparados em lowercase para cobrir subtipos de tributo em caixa alta (DARF, GPS...).
const DOCUMENT_TYPES = new Set([
  'boleto', 'pix', 'nfe', 'nfse', 'cte', 'fatura', 'recibo', 'contrato',
  'tributo', 'seguro', 'duplicata', 'outro',
  'darf', 'gps', 'das', 'gru', 'dae', 'gnre', 'ipva', 'iptu', 'iss', 'itbi',
  'gare', 'dam', 'duam',
]);

// Origem da extração (extraction_source) — teal + ícone de origem.
const SOURCE_TYPES = new Set(['email_body', 'pdf_text', 'pdf_vision']);

/** Tipo de prefixo do badge — controla o ornamento (ponto vs. ícone). */
export type BadgeKind = 'status' | 'document' | 'source';

export interface ResolvedBadge {
  variant: BadgeVariant;
  kind: BadgeKind;
}

/** Resolve a variante e o tipo de prefixo a partir do valor; null = desconhecido. */
export function resolveBadge(value: string): ResolvedBadge | null {
  const status = STATUS_VARIANT[value];
  if (status) return { variant: status, kind: 'status' };

  const norm = value.toLowerCase();
  if (SOURCE_TYPES.has(norm)) return { variant: 'source', kind: 'source' };
  if (DOCUMENT_TYPES.has(norm)) return { variant: 'document', kind: 'document' };
  return null;
}
