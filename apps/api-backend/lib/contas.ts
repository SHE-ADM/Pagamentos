// lib/contas.ts
// CRUD de contas a pagar (tabela financial_account_control) sobre o Supabase
// (service_role, ignora RLS). Repository → Service → Route (espelha lib/suppliers.ts).
// As rotas mapeiam ContaServiceError para o status HTTP via instanceof.
//
// Regras refletidas:
// - PK é `id` (BIGINT); o fornecedor é a FK `sk_supplier` (obrigatória).
// - SEM hard-delete: "remoção" = PATCH status='cancelado' (a lista exclui cancelado por padrão).
// - document_type/payment_method/amount validados pelos schemas de @sheild/shared.

import {
  financialAccountControlCreateSchema,
  financialAccountControlUpdateSchema,
  STATUS_ID_CANCELADO,
  type FinancialAccountControl,
  type FinancialAccountControlCreate,
  type FinancialAccountControlUpdate,
} from '@sheild/shared';
import type { ZodError } from 'zod';
import { getSupabaseAdmin } from './supabase-admin';
import { setSupplierClassification } from './suppliers';

const TABLE = 'financial_account_control';
const SUPPLIER_TABLE = 'supplier';
// Recursos embutidos: fornecedor (nome/CNPJ/CPF) + classificação contábil (centro
// de custo / plano de contas) vêm de JOINs — não há colunas próprias para exibição.
// IMPORTANTE — manter em SINCRONIA com o `SELECT_WITH_EMBEDS` do frontend
// (apps/frontend-vite/src/services/supabase.ts): a célula "Plano de contas" do grid de
// /consulta concatena plano + grupo + subgrupo + centro de custo, e a resposta de
// escrita (POST/PATCH) desta API é mesclada IN-PLACE no grid (sem refetch). Se este
// SELECT não trouxer a hierarquia aninhada (group/subgroup), a célula fica parcial até
// um refresh da página. Por isso o embed de chart_account inclui group + subgroup.
const SELECT_WITH_SUPPLIER =
  '*,supplier(trade_name,legal_name,cnpj,cpf),' +
  'cost_center:financial_cost_center(cost_center_code,cost_center_description),' +
  'chart_account:financial_chart_of_account(account_code,account_description,' +
  'group:financial_chart_of_account_group(group_code,group_description),' +
  'subgroup:financial_chart_of_account_subgroup(subgroup_code,subgroup_description)),' +
  // Dimensão `status` (via FK status_id) — nome da situação para exibição (status_id é a
  // fonte única; a coluna `status` texto está em remoção faseada).
  'status_dim:status(status_name,status_short_name),' +
  // Anexos (1:N — migration 079): e-mail (origin='pipeline') + upload do usuário ('manual').
  // O soft-deletado é excluído por ATTACHMENTS_ACTIVE_FILTER (ver abaixo) — obrigatório,
  // pois este client é service_role e ignora a policy que o esconderia.
  'attachments:financial_account_attachment(id,account_id,storage_key,file_name,mime_type,size_bytes,origin,uploaded_by,created_at)';

// Filtro de RECURSO EMBUTIDO do PostgREST (`attachments.deleted_at=is.null`): remove o anexo
// soft-deletado de DENTRO de cada conta, sem descartar contas (diferente de `!inner`) — conta
// sem anexo continua vindo, com `attachments: []`. Vale também no retorno de INSERT/UPDATE
// (`return=representation`), que é o que o grid de /consulta mescla in-place.
const ATTACHMENTS_DELETED_AT = 'attachments.deleted_at';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Colunas pesquisáveis no fornecedor (resolve sk_supplier por termo — índices trgm migration 029).
const SUPPLIER_SEARCH_COLUMNS = ['legal_name', 'trade_name', 'cnpj', 'cpf', 'email', 'email2', 'email3', 'email4'];

export class ContaServiceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ContaServiceError';
    this.status = status;
  }
}

export interface ContaListParams {
  page?: number;
  limit?: number;
  search?: string;
}

export interface ContaListResult {
  data: FinancialAccountControl[];
  total: number;
  page: number;
  limit: number;
}

function formatZodError(error: ZodError): string {
  return error.issues.map((i) => i.message).join('; ');
}

function duplicateMessage(detail: string): string {
  if (/cnpj/i.test(detail)) return 'CNPJ já cadastrado';
  if (/cpf/i.test(detail)) return 'CPF já cadastrado';
  return 'Registro já cadastrado';
}

// Mapeia erro de escrita para status/mensagem CURADOS (sem vazar detalhe do Postgres).
// 23505 (UNIQUE) → 409; 23503 (FK) → 422 identificando o campo pela constraint/detalhe
// (sk_supplier / cost_center_id / chart_account_id / status_id). Espelha o padrão de
// financial-accounts.ts. Ver achado A1-3.
function mapWriteError(error: { code?: string; message: string; details?: string }): ContaServiceError {
  if (error.code === '23505') return new ContaServiceError(duplicateMessage(error.details ?? error.message), 409);
  if (error.code === '23503') {
    const detail = `${error.details ?? ''} ${error.message}`;
    if (/supplier/i.test(detail)) return new ContaServiceError('Fornecedor informado não existe', 422);
    if (/cost_center/i.test(detail)) return new ContaServiceError('Centro de custo informado não existe', 422);
    if (/chart_account/i.test(detail)) return new ContaServiceError('Plano de contas informado não existe', 422);
    if (/status/i.test(detail)) return new ContaServiceError('Situação informada não existe', 422);
    return new ContaServiceError('Fornecedor, centro de custo, plano de contas ou situação informado não existe', 422);
  }
  return new ContaServiceError(error.message, 422);
}

// Sanitiza o termo de busca para o filtro `or` do PostgREST (chars de controle da sintaxe).
function sanitizeTerm(term: string): string {
  return term.replace(/[%,()]/g, ' ').trim();
}

const contaRepository = {
  // Resolve os sk_supplier cujo cadastro casa o termo (nome/CNPJ/CPF/e-mails).
  async supplierSkByTerm(term: string): Promise<number[]> {
    const { data, error } = await getSupabaseAdmin()
      .from(SUPPLIER_TABLE)
      .select('sk_supplier')
      .or(SUPPLIER_SEARCH_COLUMNS.map((c) => `${c}.ilike.%${term}%`).join(','))
      .limit(1000);
    if (error) throw new ContaServiceError(error.message, 500);
    return (data ?? []).map((r) => (r as { sk_supplier: number }).sk_supplier);
  },

  async findAll(params: { from: number; to: number; search?: string }) {
    let query = getSupabaseAdmin()
      .from(TABLE)
      .select(SELECT_WITH_SUPPLIER, { count: 'exact' })
      // Contas canceladas ficam fora da lista por padrão (mesmo critério de /consulta).
      // Por status_id (fonte única) — a coluna `status` texto está em remoção faseada.
      .neq('status_id', STATUS_ID_CANCELADO)
      .is(ATTACHMENTS_DELETED_AT, null);

    if (params.search) {
      const term = sanitizeTerm(params.search);
      const skIds = await contaRepository.supplierSkByTerm(term);
      const clauses = [
        `invoice_number.ilike.%${term}%`,
        `subject.ilike.%${term}%`,
        `sender_email.ilike.%${term}%`,
      ];
      if (skIds.length) clauses.push(`sk_supplier.in.(${skIds.join(',')})`);
      query = query.or(clauses.join(','));
    }

    return query.order('created_at', { ascending: false }).range(params.from, params.to);
  },

  findById(id: number) {
    return getSupabaseAdmin()
      .from(TABLE)
      .select(SELECT_WITH_SUPPLIER)
      .eq('id', id)
      .is(ATTACHMENTS_DELETED_AT, null)
      .maybeSingle();
  },

  // `created_by` é carimbado pelo servidor (UUID do usuário logado) — não vem do corpo.
  create(payload: FinancialAccountControlCreate & { created_by?: string }) {
    return getSupabaseAdmin()
      .from(TABLE)
      .insert(payload)
      .select(SELECT_WITH_SUPPLIER)
      .is(ATTACHMENTS_DELETED_AT, null)
      .single();
  },

  // `updated_by` é carimbado pelo servidor (UUID do usuário logado) — não vem do corpo.
  update(id: number, payload: FinancialAccountControlUpdate & { updated_by?: string }) {
    return getSupabaseAdmin()
      .from(TABLE)
      .update(payload)
      .eq('id', id)
      .select(SELECT_WITH_SUPPLIER)
      .is(ATTACHMENTS_DELETED_AT, null)
      .maybeSingle();
  },

  // HARD DELETE físico — usado só pela rota DELETE (restrita ao grupo Administrador).
  // As linhas de financial_account_attachment somem por CASCADE (FK ON DELETE CASCADE);
  // os objetos no bucket viram órfãos (limpos pelo purge_orphan_attachments). Devolve a
  // linha removida (só `id`) — vazio => a conta não existia (404).
  hardDelete(id: number) {
    return getSupabaseAdmin()
      .from(TABLE)
      .delete()
      .eq('id', id)
      .select('id')
      .maybeSingle();
  },
};

// Write-back da classificação para o fornecedor (item 2 do plano): ao salvar a
// conta pelo modal com classificação COMPLETA (centro de custo E plano de contas
// > 0), o supplier passa a carregar essa classificação como default. Best-effort —
// a conta é o artefato primário, então falha aqui NÃO derruba a resposta.
// A extração Python não passa por este service, então não dispara write-back.
async function writeBackSupplierClassification(conta: FinancialAccountControl): Promise<void> {
  const { sk_supplier: sk, cost_center_id: cc, chart_account_id: ca } = conta;
  if (!sk || !cc || !ca) return; // sentinela 0 em qualquer um → não grava no supplier
  try {
    await setSupplierClassification(sk, cc, ca);
  } catch (e) {
    console.error(`Falha ao gravar classificação default no fornecedor ${sk}:`, e);
  }
}

export const contaService = {
  /**
   * Lista contas (exceto canceladas) com paginação e busca textual (fornecedor +
   * nº documento/assunto/remetente).
   * @param params `page` (>=1), `limit` (1..100), `search`.
   * @returns `{ data, total, page, limit }` para o envelope com `meta`.
   * @throws {ContaServiceError} 500 em falha do banco.
   */
  async list(params: ContaListParams = {}): Promise<ContaListResult> {
    const page = Math.max(1, Math.trunc(params.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(params.limit ?? DEFAULT_LIMIT)));
    const from = (page - 1) * limit;

    const { data, count, error } = await contaRepository.findAll({
      from,
      to: from + limit - 1,
      search: params.search?.trim() || undefined,
    });
    if (error) throw new ContaServiceError(error.message, 500);

    return { data: (data ?? []) as unknown as FinancialAccountControl[], total: count ?? 0, page, limit };
  },

  /**
   * Obtém uma conta por `id` (PK).
   * @throws {ContaServiceError} 404 quando não existe.
   */
  async getById(id: number): Promise<FinancialAccountControl> {
    const { data, error } = await contaRepository.findById(id);
    if (error) throw new ContaServiceError(error.message, 500);
    if (!data) throw new ContaServiceError('Conta não encontrada', 404);
    return data as unknown as FinancialAccountControl;
  },

  /**
   * Cria uma conta a pagar. Valida com `financialAccountControlCreateSchema`
   * (sk_supplier obrigatório, amount > 0, document_type/payment_method dos enums).
   * @throws {ContaServiceError} 422 (payload inválido) ou 409 (violação UNIQUE).
   */
  async create(raw: unknown, userId?: string): Promise<FinancialAccountControl> {
    const parsed = financialAccountControlCreateSchema.safeParse(raw);
    if (!parsed.success) throw new ContaServiceError(formatZodError(parsed.error), 422);

    // Autoria (Etapa 1 — visibilidade por dono): carimba o UUID do usuário logado
    // (resolvido do Bearer no handler). Sem userId, o DEFAULT da coluna (sentinela) assume.
    const payload = userId ? { ...parsed.data, created_by: userId } : parsed.data;
    const { data, error } = await contaRepository.create(payload);
    if (error) throw mapWriteError(error);
    const conta = data as unknown as FinancialAccountControl;
    await writeBackSupplierClassification(conta);
    return conta;
  },

  /**
   * Atualiza campos de uma conta (partial). Permite alterar a situação
   * (ex.: `status='cancelado'` é a forma de "remover" — não há hard-delete).
   * @throws {ContaServiceError} 422 (payload inválido), 404 (inexistente) ou 409 (UNIQUE).
   */
  async update(id: number, raw: unknown, userId?: string): Promise<FinancialAccountControl> {
    const parsed = financialAccountControlUpdateSchema.safeParse(raw);
    if (!parsed.success) throw new ContaServiceError(formatZodError(parsed.error), 422);

    // Autoria (Etapa 2): carimba o editor. Quando status_id muda no PATCH, a trigger deriva
    // status_changed_by do mesmo ator (updated_by) — não precisa enviar aqui.
    const payload = userId ? { ...parsed.data, updated_by: userId } : parsed.data;
    const { data, error } = await contaRepository.update(id, payload);
    if (error) throw mapWriteError(error);
    if (!data) throw new ContaServiceError('Conta não encontrada', 404);
    const conta = data as unknown as FinancialAccountControl;
    await writeBackSupplierClassification(conta);
    return conta;
  },

  /**
   * HARD DELETE de uma conta (físico, irreversível). Restrito ao GRUPO ADMINISTRADOR
   * no handler (`requireAdminGroup`). Exceção deliberada à regra de preservação — o
   * cancelamento (PATCH `status_id=cancelado`) segue como caminho padrão para os demais.
   * @throws {ContaServiceError} 404 (inexistente), 409 (FK que bloqueia) ou 500.
   */
  async remove(id: number): Promise<{ id: number }> {
    const { data, error } = await contaRepository.hardDelete(id);
    if (error) {
      // 23503 = alguma FK RESTRICT referenciando a conta (anexos são CASCADE, não caem aqui).
      if ((error as { code?: string }).code === '23503') {
        throw new ContaServiceError('Conta vinculada a outros registros — não pode ser excluída', 409);
      }
      throw new ContaServiceError(error.message, 500);
    }
    if (!data) throw new ContaServiceError('Conta não encontrada', 404);
    return { id: (data as { id: number }).id };
  },
};
