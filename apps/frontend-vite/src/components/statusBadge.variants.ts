// Lógica de variante/resolução do StatusBadge — separada do componente para
// não disparar o aviso react-refresh/only-export-components (Fast Refresh).
import { cva, type VariantProps } from 'class-variance-authority';
import { DOCUMENT_TYPES as SCHEMA_DOCUMENT_TYPES } from '@sheild/shared';

const BASE =
  'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium tracking-wide';

// As chaves de variante são consumidas por STATUS_VARIANT abaixo; as classes
// usam a paleta semântica `status-*` do tema (cada valor é string literal p/ o JIT).
/** Estilo do badge por variante — fonte única via CVA. */
export const badgeVariants = cva(BASE, {
  variants: {
    variant: {
      amber: 'bg-status-warning-bg text-status-warning-fg border border-status-warning-border', // pendente / atenção
      emerald: 'bg-status-success-bg text-status-success-fg border border-status-success-border', // sucesso / pago
      red: 'bg-status-error-bg text-status-error-fg border border-status-error-border', // erro / vencido
      redSolid: 'bg-status-error-solid text-white border border-status-error-solidBorder', // erro crítico (API indisponível)
      slate: 'bg-status-neutral-bg text-status-neutral-fg border border-status-neutral-border', // neutro / cancelado
      blue: 'bg-status-info-bg text-status-info-fg border border-status-info-border', // informativo / a vencer
      document: 'bg-status-neutral-bg text-status-neutral-fg border border-status-neutral-border', // tipos de documento
      source: 'bg-status-source-bg text-status-source-fg border border-status-source-border', // origem da extração
      neutral: 'bg-status-neutral-bg text-status-neutral-fg border border-status-neutral-border', // fallback não mapeado
    },
  },
  defaultVariants: { variant: 'neutral' },
});

/** Variante visual do badge — reutilizável por outros componentes. */
type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

// Valores de status/situação — recebem ponto colorido à esquerda.
const STATUS_VARIANT: Record<string, BadgeVariant> = {
  // financial_account_control.status (ciclo de vida do pagamento — migration 018)
  pendente: 'slate',
  'a vencer': 'blue',
  vencido: 'red',
  prorrogado: 'blue',
  baixado: 'blue',
  protestado: 'red',
  cartório: 'amber',
  pago: 'emerald',
  cancelado: 'slate',
  falha: 'red',
  // email_control.status (migration 022). Esquema simplificado (decisão de UI):
  // extraído + recebido = VERDE (sucesso); pendente + ignorado + duplicidade = CINZA.
  recebido: 'emerald',
  extraído: 'emerald',
  ignorado: 'slate',
  duplicidade: 'slate',
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

// Rótulos pt-BR exibidos no badge para a origem da extração — o valor cru do
// banco (snake_case técnico) não é amigável ao usuário. pdf_text e pdf_vision
// compartilham o rótulo: para o usuário ambos são um PDF anexado (a distinção
// texto/escaneado é interna ao pipeline).
const SOURCE_LABELS: Record<string, string> = {
  email_body: 'corpo email',
  pdf_text: 'pdf anexado',
  pdf_vision: 'pdf anexado',
};

/** Rótulo de exibição do valor (traduz extraction_source); fallback = valor original. */
export function badgeLabel(value: string): string {
  return SOURCE_LABELS[value.toLowerCase()] ?? value;
}

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
