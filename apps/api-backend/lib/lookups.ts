// lib/lookups.ts
// Lookups de classificação contábil (centro de custo / plano de contas) sobre o
// Supabase (service_role, ignora RLS). São cadastros pré-existentes só-leitura,
// consumidos pelos react-select do formulário de contas. Service simples (sem
// Repository dedicado): a leitura é trivial e não há escrita.

import { type CostCenter, type ChartAccount } from '@sheild/shared';
import { getSupabaseAdmin } from './supabase-admin';

const COST_CENTER_TABLE = 'financial_cost_center';
const CHART_ACCOUNT_TABLE = 'financial_chart_of_account';
const DEFAULT_LIMIT = 500; // cadastros pequenos (dezenas/centenas) — cabe num fetch.
const MAX_LIMIT = 1000;

export class LookupServiceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'LookupServiceError';
    this.status = status;
  }
}

interface LookupListParams {
  search?: string;
  limit?: number;
  /** Filtra planos de contas pelo centro de custo (cascata). Só usado pelo chartAccountService. */
  costCenterId?: number;
}

// Sanitiza o termo para o filtro `or` do PostgREST (chars de controle da sintaxe).
function sanitizeTerm(term: string): string {
  return term.replace(/[%,()]/g, ' ').trim();
}

function clampLimit(limit?: number): number {
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit ?? DEFAULT_LIMIT)));
}

export const costCenterService = {
  /**
   * Lista centros de custo (apenas os com descrição — descarta o placeholder
   * sem código/descrição). Busca textual opcional por código/descrição.
   * @throws {LookupServiceError} 500 em falha do banco.
   */
  async list(params: LookupListParams = {}): Promise<CostCenter[]> {
    let query = getSupabaseAdmin()
      .from(COST_CENTER_TABLE)
      .select('cost_center_id,cost_center_code,cost_center_description')
      .not('cost_center_description', 'is', null);

    const term = params.search?.trim() ? sanitizeTerm(params.search) : '';
    if (term) {
      query = query.or(`cost_center_code.ilike.%${term}%,cost_center_description.ilike.%${term}%`);
    }

    const { data, error } = await query.order('cost_center_description', { ascending: true }).limit(clampLimit(params.limit));
    if (error) throw new LookupServiceError(error.message, 500);
    return (data ?? []) as CostCenter[];
  },
};

export const chartAccountService = {
  /**
   * Lista contas do plano de contas elegíveis a lançamento (is_postable = true),
   * SEMPRE filtradas pelo centro de custo (cascata): `cost_center_id` é obrigatório
   * — sem ele (ausente/0) retorna `[]` (o plano depende do centro; evita carga).
   * Busca textual opcional por código/descrição.
   * @throws {LookupServiceError} 500 em falha do banco.
   */
  async list(params: LookupListParams = {}): Promise<ChartAccount[]> {
    // Plano de contas só existe no contexto de um centro de custo selecionado.
    if (!params.costCenterId) return [];

    let query = getSupabaseAdmin()
      .from(CHART_ACCOUNT_TABLE)
      .select('chart_account_id,account_code,account_description')
      .is('is_postable', true)
      .eq('cost_center_id', params.costCenterId);

    const term = params.search?.trim() ? sanitizeTerm(params.search) : '';
    if (term) {
      query = query.or(`account_code.ilike.%${term}%,account_description.ilike.%${term}%`);
    }

    const { data, error } = await query.order('account_description', { ascending: true }).limit(clampLimit(params.limit));
    if (error) throw new LookupServiceError(error.message, 500);
    return (data ?? []) as ChartAccount[];
  },
};
