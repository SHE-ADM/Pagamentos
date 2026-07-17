// lib/lookups.ts
// Lookups de classificação contábil (centro de custo / plano de contas) sobre o
// Supabase (service_role, ignora RLS). São cadastros pré-existentes só-leitura,
// consumidos pelos react-select do formulário de contas. Service simples (sem
// Repository dedicado): a leitura é trivial e não há escrita.

import { type CostCenter, type ChartAccount } from '@sheild/shared';
import { getSupabaseAdmin } from './supabase-admin';

const COST_CENTER_TABLE = 'financial_cost_center';
const CHART_ACCOUNT_TABLE = 'financial_chart_of_account';
const STATUS_TABLE = 'status';
const COMPANY_TABLE = 'company';
const DEFAULT_LIMIT = 500; // cadastros pequenos (dezenas/centenas) — cabe num fetch.
const MAX_LIMIT = 1000;

// Linha da dimensão `status` (lookup do CRUD de contas — financial_account.status_id).
export interface StatusOption {
  status_id: number;
  status_name: string | null;
}

// Linha do cadastro `company` (lookup da empresa pagadora no ContaForm —
// financial_account_control.sk_company). Hoje 3 linhas: OTIMOTEX TECIDOS (1), LEBIANCO (2)
// e OTIMOTEX FARDOS (3). Sem filtro/limite — empresa nova aparece sozinha nos selects.
export interface CompanyOption {
  sk_company: number;
  trade_name: string | null;
}

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

export const statusService = {
  /**
   * Lista a dimensão `status` (lookup de situação do CRUD de contas — alimenta o
   * <select> de `financial_account.status_id`). Ordenada por id.
   * @throws {LookupServiceError} 500 em falha do banco.
   */
  async list(): Promise<StatusOption[]> {
    const { data, error } = await getSupabaseAdmin()
      .from(STATUS_TABLE)
      .select('status_id,status_name')
      .order('status_id', { ascending: true });
    if (error) throw new LookupServiceError(error.message, 500);
    return (data ?? []) as StatusOption[];
  },
};

export const companyService = {
  /**
   * Lista o cadastro `company` (lookup da EMPRESA PAGADORA — alimenta o <select> de
   * `financial_account_control.sk_company` no ContaForm). Cadastro minúsculo (2 linhas:
   * OTIMOTEX/LEBIANCO) e só-leitura — sem busca nem paginação, como o statusService.
   * Ordenado por nome para a lista ficar estável na tela.
   * @throws {LookupServiceError} 500 em falha do banco.
   */
  async list(): Promise<CompanyOption[]> {
    const { data, error } = await getSupabaseAdmin()
      .from(COMPANY_TABLE)
      .select('sk_company,trade_name')
      .order('trade_name', { ascending: true });
    if (error) throw new LookupServiceError(error.message, 500);
    return (data ?? []) as CompanyOption[];
  },
};
