// lib/suppliers.ts
// CRUD de fornecedores (tabela `supplier`) sobre o Supabase (service_role, ignora RLS).
// Repository (acesso ao banco) → Service (regras + validação Zod). As rotas mapeiam
// SupplierServiceError para o status HTTP via instanceof (padrão de PythonBridgeError).
//
// Regras de negócio refletidas:
// - chk_supplier_has_identifier (migration 011): ao menos um identificador no create.
// - soft delete (migration 045): baixa marca deleted_at; leituras filtram deleted_at IS NULL.
// - supplier é PRESERVADO: a baixa é bloqueada (409) quando há contas vinculadas.

import {
  supplierCreateSchema,
  supplierUpdateSchema,
  type Supplier,
  type SupplierCreateInput,
  type SupplierUpdateInput,
} from '@sheild/shared/schemas';
import type { ZodError } from 'zod';
import { getSupabaseAdmin } from './supabase-admin';
import { applyOrder, resolveSort, type SortOrder } from './sort';
import { checkClassificationPair } from './classification';
import { ApiServiceError } from './api-error';

const SUPPLIER_TABLE = 'supplier';
// Colunas ordenáveis (própria tabela) usadas pelo sort do grid de /fornecedores.
// cost_center_id/chart_account_id ordenam a classificação pela FK própria (server-side,
// agrupa por centro/plano) — o PostgREST não ordena por coluna de embed de forma confiável.
const SORTABLE_COLUMNS = [
  'legal_name',
  'trade_name',
  'cnpj',
  'cpf',
  'email',
  'cost_center_id',
  'chart_account_id',
] as const;
const ACCOUNTS_TABLE = 'financial_account_control';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Leitura de um fornecedor com a classificação contábil DEFAULT já com rótulos
// (embeds dos cadastros) — alimenta o pré-preenchimento do modal de contas.
const SELECT_WITH_CLASSIFICATION =
  '*,cost_center:financial_cost_center(cost_center_code,cost_center_description),' +
  'chart_account:financial_chart_of_account(account_code,account_description)';

// Colunas pesquisáveis no filtro de texto (índices GIN trigram — migration 029).
const SEARCH_COLUMNS = ['legal_name', 'trade_name', 'cnpj', 'cpf', 'email', 'email2', 'email3', 'email4'];

// Erro de negócio com status HTTP — capturado por instanceof nos route handlers.
export class SupplierServiceError extends ApiServiceError {
  constructor(message: string, status: number) {
    super(message, status, 'SupplierServiceError');
  }
}

export interface SupplierListParams {
  page?: number;
  limit?: number;
  search?: string;
  /**
   * Ordenação: o alias `name` = alfabética por nome fantasia (lookup do modal de contas);
   * uma coluna de `SORTABLE_COLUMNS` = sort server-side do grid (com `order`); padrão = mais
   * recentes (sk_supplier desc).
   */
  sort?: string;
  order?: SortOrder;
}

export interface SupplierListResult {
  data: Supplier[];
  total: number;
  page: number;
  limit: number;
}

function formatZodError(error: ZodError): string {
  return error.issues.map((i) => i.message).join('; ');
}

// Violação de UNIQUE (cnpj/cpf) do Postgres → 409. A mensagem distingue o campo.
function duplicateMessage(detail: string): string {
  if (/cnpj/i.test(detail)) return 'CNPJ já cadastrado';
  if (/cpf/i.test(detail)) return 'CPF já cadastrado';
  return 'Fornecedor já cadastrado';
}

// Camada de acesso ao banco. Interna ao módulo — os testes exercitam-na via service.
const supplierRepository = {
  async findAll(params: { from: number; to: number; search?: string; sort?: string; order?: SortOrder }) {
    // Inclui os embeds de classificação (centro de custo / plano de contas) para o
    // grid de /fornecedores exibir as descrições — antes a lista trazia só os ids.
    let query = getSupabaseAdmin()
      .from(SUPPLIER_TABLE)
      .select(SELECT_WITH_CLASSIFICATION, { count: 'exact' })
      .is('deleted_at', null);

    if (params.search) {
      const term = params.search.replace(/[%,()]/g, ' ').trim();
      query = query.or(SEARCH_COLUMNS.map((c) => `${c}.ilike.%${term}%`).join(','));
    }

    // Prioridade: (1) sort por coluna do grid (allowlist + order); (2) alias `name` =
    // alfabética por nome fantasia (lookup do modal de contas); (3) padrão = mais
    // recentes (sk_supplier desc — página /fornecedores).
    // applyOrder acrescenta o desempate por `sk_supplier` (PK) — obrigatório com
    // paginação por range/offset, senão fornecedores empatados repetem entre páginas e
    // outros somem. Ver lib/sort.ts.
    const sorted = resolveSort(params.sort, params.order, SORTABLE_COLUMNS);
    const fallback = params.sort === 'name'
      ? { column: 'trade_name', ascending: true, nullsFirst: false }
      : { column: 'sk_supplier', ascending: false };

    return applyOrder(query, sorted, fallback, 'sk_supplier').range(params.from, params.to);
  },

  findBySk(sk: number) {
    return getSupabaseAdmin()
      .from(SUPPLIER_TABLE)
      .select(SELECT_WITH_CLASSIFICATION)
      .eq('sk_supplier', sk)
      .is('deleted_at', null)
      .maybeSingle();
  },

  create(payload: SupplierCreateInput) {
    return getSupabaseAdmin().from(SUPPLIER_TABLE).insert(payload).select().single();
  },

  update(sk: number, payload: SupplierUpdateInput) {
    return getSupabaseAdmin()
      .from(SUPPLIER_TABLE)
      .update(payload)
      .eq('sk_supplier', sk)
      .is('deleted_at', null)
      .select()
      .maybeSingle();
  },

  // Conta quantas contas a pagar referenciam o fornecedor (FK reversa).
  countLinkedAccounts(sk: number) {
    return getSupabaseAdmin()
      .from(ACCOUNTS_TABLE)
      .select('sk_supplier', { count: 'exact', head: true })
      .eq('sk_supplier', sk);
  },

  softDelete(sk: number, deletedAt: string) {
    return getSupabaseAdmin()
      .from(SUPPLIER_TABLE)
      .update({ deleted_at: deletedAt })
      .eq('sk_supplier', sk)
      .is('deleted_at', null)
      .select()
      .maybeSingle();
  },
};

export const supplierService = {
  /**
   * Lista fornecedores ativos (deleted_at IS NULL) com paginação e busca textual.
   * @param params `page` (>=1), `limit` (1..100), `search` (casa nome/CNPJ/CPF/e-mails).
   * @returns `{ data, total, page, limit }` para o envelope com `meta`.
   * @throws {SupplierServiceError} 500 em falha do banco.
   */
  async list(params: SupplierListParams = {}): Promise<SupplierListResult> {
    const page = Math.max(1, Math.trunc(params.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(params.limit ?? DEFAULT_LIMIT)));
    const from = (page - 1) * limit;

    const { data, count, error } = await supplierRepository.findAll({
      from,
      to: from + limit - 1,
      search: params.search?.trim() || undefined,
      sort: params.sort,
      order: params.order,
    });
    if (error) throw new SupplierServiceError(error.message, 500);

    // Double cast: o SELECT com embeds faz o supabase-js inferir um tipo de parser
    // de relação, não diretamente Supplier[] (mesmo padrão de getBySk).
    return { data: (data ?? []) as unknown as Supplier[], total: count ?? 0, page, limit };
  },

  /**
   * Obtém um fornecedor ativo por sk_supplier.
   * @param sk Surrogate key do fornecedor.
   * @returns O fornecedor encontrado.
   * @throws {SupplierServiceError} 404 quando não existe (ou está baixado).
   */
  async getBySk(sk: number): Promise<Supplier> {
    const { data, error } = await supplierRepository.findBySk(sk);
    if (error) throw new SupplierServiceError(error.message, 500);
    if (!data) throw new SupplierServiceError('Fornecedor não encontrado', 404);
    // Double cast: o SELECT com embeds (cost_center/chart_account) faz o supabase-js
    // inferir um tipo de parser de relação, não diretamente Supplier.
    return data as unknown as Supplier;
  },

  /**
   * Cria um fornecedor. Valida o input (ao menos um identificador; CNPJ/CPF sem
   * máscara) e persiste via service_role.
   * @param raw Corpo da requisição (não confiável) — validado com `supplierCreateSchema`.
   * @returns O fornecedor criado.
   * @throws {SupplierServiceError} 422 (payload inválido) ou 409 (CNPJ/CPF duplicado).
   */
  async create(raw: unknown): Promise<Supplier> {
    const parsed = supplierCreateSchema.safeParse(raw);
    if (!parsed.success) throw new SupplierServiceError(formatZodError(parsed.error), 422);

    // Par de classificação DEFAULT (centro de custo + plano de contas): mesma trava do
    // CRUD de contas — plano sem centro relacionado (e vice-versa) é rejeitado.
    const pairMsg = await checkClassificationPair(parsed.data.cost_center_id ?? 0, parsed.data.chart_account_id ?? 0);
    if (pairMsg) throw new SupplierServiceError(pairMsg, 422);

    const { data, error } = await supplierRepository.create(parsed.data);
    if (error) {
      if (error.code === '23505') {
        throw new SupplierServiceError(duplicateMessage(error.details ?? error.message), 409);
      }
      throw new SupplierServiceError(error.message, 422);
    }
    return data as Supplier;
  },

  /**
   * Atualiza campos de um fornecedor (partial update).
   * @param sk Surrogate key do fornecedor.
   * @param raw Campos a atualizar — validados com `supplierUpdateSchema`.
   * @returns O fornecedor atualizado.
   * @throws {SupplierServiceError} 422 (payload inválido), 404 (inexistente) ou 409 (CNPJ/CPF de outro registro).
   */
  async update(sk: number, raw: unknown): Promise<Supplier> {
    const parsed = supplierUpdateSchema.safeParse(raw);
    if (!parsed.success) throw new SupplierServiceError(formatZodError(parsed.error), 422);

    // Par de classificação — só quando algum id vem no PATCH (SupplierForm envia os dois).
    const { cost_center_id: cc, chart_account_id: ca } = parsed.data;
    if (cc !== undefined || ca !== undefined) {
      const pairMsg = await checkClassificationPair(cc ?? 0, ca ?? 0);
      if (pairMsg) throw new SupplierServiceError(pairMsg, 422);
    }

    const { data, error } = await supplierRepository.update(sk, parsed.data);
    if (error) {
      if (error.code === '23505') {
        throw new SupplierServiceError(duplicateMessage(error.details ?? error.message), 409);
      }
      throw new SupplierServiceError(error.message, 422);
    }
    if (!data) throw new SupplierServiceError('Fornecedor não encontrado', 404);
    return data as Supplier;
  },

  /**
   * Baixa lógica (soft delete) de um fornecedor. Bloqueada quando há contas a pagar
   * vinculadas (FK reversa) — fornecedor com histórico é PRESERVADO.
   * @param sk Surrogate key do fornecedor.
   * @param now Timestamp ISO da baixa (injetado pela rota para testabilidade).
   * @returns `{ sk_supplier }` do fornecedor baixado.
   * @throws {SupplierServiceError} 404 (inexistente) ou 409 (possui contas vinculadas).
   */
  async remove(sk: number, now: string): Promise<{ sk_supplier: number }> {
    const existing = await supplierRepository.findBySk(sk);
    if (existing.error) throw new SupplierServiceError(existing.error.message, 500);
    if (!existing.data) throw new SupplierServiceError('Fornecedor não encontrado', 404);

    const linked = await supplierRepository.countLinkedAccounts(sk);
    if (linked.error) throw new SupplierServiceError(linked.error.message, 500);
    if ((linked.count ?? 0) > 0) {
      throw new SupplierServiceError('Fornecedor possui contas vinculadas e não pode ser removido', 409);
    }

    const { error } = await supplierRepository.softDelete(sk, now);
    if (error) throw new SupplierServiceError(error.message, 500);
    return { sk_supplier: sk };
  },
};

/**
 * Grava a classificação contábil DEFAULT do fornecedor (write-back do modal de
 * contas — ver `contaService`). Caminho dedicado: `cost_center_id`/`chart_account_id`
 * NÃO fazem parte de `supplierUpdateSchema` (PATCH público de fornecedor), então a
 * atualização passa por aqui, fora do schema editável. Best-effort no chamador.
 * NOTA: fornecedor de FUNCIONÁRIO (trade_name com "funcionário") é mantido em 0 pela
 * trigger `trg_supplier_no_funcionario_classification` (migration 070) — este write-back
 * vira no-op para eles (a despesa de funcionário varia por conta, sem default no cadastro).
 * @param sk Surrogate key do fornecedor.
 * @param costCenterId FK do centro de custo (> 0 — validado pelo chamador).
 * @param chartAccountId FK do plano de contas (> 0 — validado pelo chamador).
 */
export async function setSupplierClassification(
  sk: number,
  costCenterId: number,
  chartAccountId: number,
): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from(SUPPLIER_TABLE)
    .update({ cost_center_id: costCenterId, chart_account_id: chartAccountId })
    .eq('sk_supplier', sk)
    .is('deleted_at', null);
  if (error) throw new SupplierServiceError(error.message, 500);
}
