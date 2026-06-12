// Lógica de variante/resolução do StatusBadge — separada do componente para
// não disparar o aviso react-refresh/only-export-components (Fast Refresh).
import { cva, type VariantProps } from 'class-variance-authority';
import { DOCUMENT_TYPES as SCHEMA_DOCUMENT_TYPES } from '@sheild/shared';

const BASE =
  'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium tracking-wide';

/** Estilo do badge por variante — fonte única via CVA (cada classe é literal p/ o JIT). */
export const badgeVariants = cva(BASE, {
  variants: {
    variant: {
      amber: 'bg-amber-50 text-amber-700 border border-amber-200', // pendente / atenção
      emerald: 'bg-emerald-50 text-emerald-700 border border-emerald-200', // sucesso / pago
      red: 'bg-red-50 text-red-600 border border-red-200', // erro / vencido
      redSolid: 'bg-red-600 text-white border border-red-700', // erro crítico (API indisponível)
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
type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

// Valores de status/situação — recebem ponto colorido à esquerda.
const STATUS_VARIANT: Record<string, BadgeVariant> = {
  // financial_account_control.status (ciclo de vida do pagamento — migration 018)
  pendente: 'amber',
  'a vencer': 'blue',
  vencido: 'red',
  prorrogado: 'blue',
  baixado: 'blue',
  protestado: 'red',
  cartório: 'amber',
  pago: 'emerald',
  'pago protesto': 'emerald',
  'pago cartório': 'emerald',
  'não pago': 'red',
  cancelado: 'slate',
  falha: 'red',
  // email_control.status (migration 019) — 'baixado' e 'falha' já mapeados acima
  recebido: 'slate',
  extraído: 'emerald',
  ignorado: 'slate',
  // email_processing_errors.error_type
  sem_valor: 'amber',
  sem_fornecedor: 'amber',
  pdf_protegido: 'amber',
  extracao_falhou: 'red',
  db_erro: 'red',
  processamento_erro: 'red',
  // erro_api: falha de API (crédito/auth/limite) — vermelho sólido para
  // destacar de uma falha de extração comum (vermelho suave).
  erro_api: 'redSolid',
};

// Tipos de documento — derivados do schema @sheild/shared (fonte única de verdade).
// Comparados em lowercase para cobrir subtipos em caixa alta (DARF, GPS…).
const DOCUMENT_TYPES = new Set<string>(SCHEMA_DOCUMENT_TYPES);

// Origem da extração (extraction_source) — teal + ícone de origem.
const SOURCE_TYPES = new Set(['email_body', 'pdf_text', 'pdf_vision']);

/** Tipo de prefixo do badge — controla o ornamento (ponto vs. ícone). */
export type BadgeKind = 'status' | 'document' | 'source';

interface ResolvedBadge {
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
