// src/services/supabase.ts
// Acesso direto à REST API do Supabase — sem dependência do cliente oficial
// para leitura de dados (o cliente oficial em lib/supabaseClient.ts cuida
// apenas da sessão de autenticação).
//
// As policies de RLS exigem o papel `authenticated` (migration 015) — por
// isso o header Authorization carrega o token da sessão do usuário logado,
// não a anon key. O `apikey` continua sendo a anon key: ela só identifica o
// projeto perante o Supabase, quem define o papel para o RLS é o JWT do
// Authorization.

import type { EmailControl, FinancialAccountControl, ProcessingError } from '@sheild/shared';
import {
  STATUS_ID_CANCELADO,
  STATUS_ID_PAGO,
  STATUS_ID_VENCIDO,
  STATUS_ID_A_VENCER,
  STATUS_NAME_BY_ID,
} from '@sheild/shared';
import { supabase } from '../lib/supabaseClient';

// Situação é filtrada/ordenada por status_id (fonte única). Ordenar a coluna
// "Situação" continua ALFABÉTICO pelo NOME (decisão de negócio — id ≠ ordem), via o
// embed da dimensão: order=status_dim(status_name). Mapeia a chave de coluna do grid.
const STATUS_SORT_KEY = 'status';
const STATUS_DIM_ORDER = 'status_dim(status_name)';

const BASE_URL = import.meta.env.VITE_SUPABASE_URL;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

type QueryParams = Record<string, string | number | undefined>;

async function authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token ?? ANON_KEY;
  return {
    apikey: ANON_KEY,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function query<T>(table: string, params: QueryParams = {}): Promise<T> {
  const url = new URL(`${BASE_URL}/rest/v1/${table}`);
  Object.entries(params).forEach(([k, v]) => v !== undefined && url.searchParams.set(k, String(v)));
  const res = await fetch(url.toString(), { headers: await authHeaders() });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

// ── company ──────────────────────────────────────────────────────────────────

// E-mail da empresa pagadora (cadastro `company`, company_id=1) — exibido como
// subtítulo em /emails: é a caixa de onde os e-mails são lidos. RLS: policy
// `authenticated read` (qual `true`). Retorna null se não encontrado/sem acesso.
export async function getCompanyEmail(companyId = 1): Promise<string | null> {
  const rows = await query<{ email: string | null }[]>('company', {
    select: 'email',
    company_id: `eq.${companyId}`,
    limit: 1,
  });
  return rows[0]?.email ?? null;
}

// ── email_control ──────────────────────────────────────────────────────────

interface EmailControlFilters {
  status?: string;
  sender?: string;
  days?: number;
  limit?: number;
  hasAttachment?: boolean;
  pdfExtracted?: boolean;
}

// Busca message_ids em financial_account_control pelo invoice_number, depois
// retorna as linhas de email_control correspondentes.
// Usado para permitir pesquisa por nº documento em /emails.
async function lookupEmailsByInvoiceNumber(
  term: string,
  baseParams: QueryParams,
): Promise<EmailControl[]> {
  const u1 = new URL(`${BASE_URL}/rest/v1/financial_account_control`);
  u1.searchParams.set('select', 'gmail_message_id');
  u1.searchParams.set('invoice_number', `ilike.*${term}*`);
  u1.searchParams.set('limit', '100');
  const r1 = await fetch(u1.toString(), { headers: await authHeaders() });
  if (!r1.ok) return [];

  const accts = (await r1.json()) as { gmail_message_id: string | null }[];
  const ids = [
    ...new Set(
      accts
        .map((a) => a.gmail_message_id?.replace(/#\d+$/, ''))
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (!ids.length) return [];

  // in.("id1","id2") — aspas duplas para suportar chars especiais no message_id
  const u2 = new URL(`${BASE_URL}/rest/v1/email_control`);
  Object.entries(baseParams).forEach(
    ([k, v]) => v !== undefined && u2.searchParams.set(k, String(v)),
  );
  u2.searchParams.set('message_id', `in.("${ids.join('","')}")`);
  const r2 = await fetch(u2.toString(), { headers: await authHeaders() });
  if (!r2.ok) return [];
  return r2.json() as Promise<EmailControl[]>;
}

export async function getEmailControl({
  status,
  sender,
  days,
  limit = 200,
  hasAttachment,
  pdfExtracted,
}: EmailControlFilters = {}): Promise<EmailControl[]> {
  const baseParams: QueryParams = { select: '*', order: 'received_at.desc', limit };
  if (status) baseParams['status'] = `eq.${status}`;
  if (days) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    baseParams['received_at'] = `gte.${since}`;
  }
  if (hasAttachment !== undefined) baseParams['has_attachment'] = `eq.${String(hasAttachment)}`;
  if (pdfExtracted !== undefined) baseParams['pdf_extracted'] = `eq.${String(pdfExtracted)}`;

  if (!sender) return query<EmailControl[]>('email_control', baseParams);

  // Busca em paralelo: por remetente/assunto E por nº documento via lookup inverso
  const senderParams: QueryParams = {
    ...baseParams,
    or: `(sender_email.ilike.*${sender}*,subject.ilike.*${sender}*)`,
  };

  const [senderRows, invoiceRows] = await Promise.all([
    query<EmailControl[]>('email_control', senderParams),
    lookupEmailsByInvoiceNumber(sender, baseParams),
  ]);

  // Merge deduplificado, mantendo ordem desc por received_at
  const seen = new Set(senderRows.map((r) => r.id));
  const merged = [...senderRows];
  for (const r of invoiceRows) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      merged.push(r);
    }
  }
  return merged.sort((a, b) => (b.received_at ?? '').localeCompare(a.received_at ?? ''));
}

// Marca um e-mail como revisado (reviewed_at = agora) — usado em /emails ao abrir
// o card de detalhes de um e-mail com falha. A migration 030 restringe o papel
// `authenticated` a escrever SOMENTE a coluna reviewed_at. Retorna o ISO gravado.
export async function markEmailReviewed(id: number): Promise<string> {
  const reviewedAt = new Date().toISOString();
  const url = new URL(`${BASE_URL}/rest/v1/email_control`);
  url.searchParams.set('id', `eq.${id}`);
  const res = await fetch(url.toString(), {
    method: 'PATCH',
    headers: await authHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ reviewed_at: reviewedAt }),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return reviewedAt;
}

// Contagens por status (taxonomia da migration 022) — uma KPI por status.
export interface EmailStats {
  total: number;
  extraido: number;
  recebido: number;
  pendente: number;
  falha: number;
  ignorado: number;
  duplicidade: number;
}

export async function getEmailStats(): Promise<EmailStats> {
  // Uma única requisição: traz a coluna `status` de todo o email_control e conta no
  // cliente (mesmo padrão de getProcessingErrorStats). Antes eram 8 requisições por
  // refresh (1 total + 6 por status), repetidas a cada poll de leitura.
  const rows = await query<{ status: string }[]>('email_control', { select: 'status', limit: 50000 });
  const count = (s: string): number => rows.filter((r) => r.status === s).length;
  return {
    total: rows.length,
    extraido: count('extraído'),
    recebido: count('recebido'),
    pendente: count('pendente'),
    falha: count('falha'),
    ignorado: count('ignorado'),
    duplicidade: count('duplicidade'),
  };
}

// ── financial_account_control ───────────────────────────────────────────────

// SELECT com os JOINs de exibição: fornecedor (nome/CNPJ/CPF) + classificação
// contábil (centro de custo / plano de contas) via aliases de embed do PostgREST.
const SELECT_WITH_EMBEDS =
  '*,supplier(trade_name,legal_name,cnpj,cpf),' +
  'cost_center:financial_cost_center(cost_center_code,cost_center_description),' +
  // Plano de contas + sua hierarquia (grupo/subgrupo, embeds aninhados) — a célula
  // "Plano de contas" do grid concatena plano + grupo + subgrupo + centro de custo.
  'chart_account:financial_chart_of_account(account_code,account_description,' +
  'group:financial_chart_of_account_group(group_code,group_description),' +
  'subgroup:financial_chart_of_account_subgroup(subgroup_code,subgroup_description)),' +
  // Dimensão `status` (via FK status_id) — fonte do NOME da situação para exibição
  // (a coluna `status` texto está em remoção faseada; status_id é a fonte única).
  'status_dim:status(status_name,status_short_name)';

interface FinancialAccountControlFilters {
  supplier?: string;
  docType?: string;
  // Situação filtrada por status_id (fonte única). undefined = sem filtro de situação.
  statusId?: number;
  paymentMethod?: string;
  // Coluna de data do filtro de período: vencimento (default) ou emissão.
  dateField?: 'due_date' | 'issue_date';
  // Filtro por mês/ano (0-indexed). Ambos presentes → range do mês na coluna dateField.
  // null/ausente → escopo "todas" (cai no range explícito dateFrom/dateTo, ou nada).
  month?: number | null;
  year?: number | null;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
  sortCol?: string;
  sortDir?: 'asc' | 'desc';
}

interface Paginated<T> {
  data: T[];
  total: number;
  /** true quando `total` é estimativa (PostgREST não devolveu contagem exata). */
  totalIsEstimate: boolean;
}

// Content-Range do PostgREST: "0-19/247" (count=exact) ou "*/*" / "0-19/*" quando a
// contagem é indisponível. Indisponível → NÃO zera a paginação: estima "há mais páginas"
// por offset + itens recebidos (+ pageSize se a página veio cheia), evitando prender o
// usuário na página 1. Mantém o caminho count=exact intacto.
// ts-prune-ignore-next
export function parsePaginationTotal(
  cr: string | null,
  offset: number,
  pageSize: number,
  dataLength: number,
): { total: number; totalIsEstimate: boolean } {
  const exact = Number.parseInt(cr?.split('/')[1] ?? '', 10);
  if (Number.isFinite(exact)) return { total: exact, totalIsEstimate: false };
  return {
    total: offset + dataLength + (dataLength === pageSize ? pageSize : 0),
    totalIsEstimate: true,
  };
}

// Aplica os filtros de financial_account_control nos search params — compartilhado
// entre a listagem paginada e a soma do card "Valor total".
// Como financial_account_control não guarda mais nome/CNPJ do fornecedor (só a FK
// sk_supplier — migrations 040/041/042), a busca por fornecedor resolve antes os
// sk_supplier que casam o termo na tabela `supplier` (nome, CNPJ/CPF e os 4 e-mails)
// e alimenta o filtro `sk_supplier IN (...)`. Os índices GIN trigram (migration 029)
// aceleram o ILIKE '%termo%' nos e-mails.
// Valor de um `ilike` dentro de um or(...): entre ASPAS DUPLAS para sobreviver a
// caracteres reservados do PostgREST (vírgula e parênteses são delimitadores de
// cláusula). Sem isso, um termo como "463,21" quebra o filtro inteiro (PGRST100).
// As aspas do próprio termo são removidas para não invalidar o literal citado.
function ilikeContains(term: string): string {
  return `"*${term.replace(/"/g, '')}*"`;
}

// Interpreta o termo de busca como VALOR monetário (formato BR ou simples) e devolve
// o número canônico a casar em `amount` (NUMERIC(15,2)); null quando o termo não é um
// valor numérico completo — aí a busca segue apenas textual. A correspondência é EXATA.
// Aceita o símbolo monetário opcional "R$" (com/sem espaço), indicador de busca por valor.
// Exemplos: "463,21" → "463.21" · "R$ 1.999,99" → "1999.99" · "R$1999,99" → "1999.99" · "391".
export function parseBrlAmount(term: string): string | null {
  // Remove o prefixo "R$" (e espaços) antes de validar o número.
  const t = term.trim().replace(/^r\$\s*/i, '').trim();
  let normalized: string;
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) {
    // BR com separador de milhar: remove os pontos, vírgula → ponto decimal.
    normalized = t.replace(/\./g, '').replace(',', '.');
  } else if (/^\d+,\d{1,2}$/.test(t)) {
    // Vírgula como separador decimal (ex.: "463,21").
    normalized = t.replace(',', '.');
  } else if (/^\d+(\.\d{1,2})?$/.test(t)) {
    // Número simples ou ponto decimal (ex.: "391" ou "463.21").
    normalized = t;
  } else {
    return null;
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? String(n) : null;
}

// O símbolo "R$" no termo indica busca EXPLÍCITA por valor do documento: correspondência
// exata em `amount`, sem busca textual (nº doc/assunto/remetente) nem lookup de fornecedor.
export function isCurrencyValueSearch(term: string): boolean {
  return /r\$/i.test(term) && parseBrlAmount(term) !== null;
}

async function findSupplierIdsByTerm(term: string): Promise<number[]> {
  const url = new URL(`${BASE_URL}/rest/v1/supplier`);
  const like = ilikeContains(term);
  url.searchParams.set('select', 'sk_supplier');
  url.searchParams.set(
    'or',
    `(trade_name.ilike.${like},legal_name.ilike.${like},cnpj.ilike.${like},` +
      `cpf.ilike.${like},email.ilike.${like},email2.ilike.${like},` +
      `email3.ilike.${like},email4.ilike.${like})`,
  );
  url.searchParams.set('limit', '1000');
  const res = await fetch(url.toString(), { headers: await authHeaders() });
  if (!res.ok) return [];
  const data = (await res.json()) as { sk_supplier: number }[];
  return data.map((r) => r.sk_supplier);
}

// GET genérico numa tabela de cadastro que casa `term` (ilike) em `code`/`description`
// e devolve a coluna de id. Espelha findSupplierIdsByTerm para a classificação contábil.
async function findIdsByTerm(
  table: string,
  idCol: string,
  cols: string[],
  term: string,
  extra = '',
): Promise<number[]> {
  const url = new URL(`${BASE_URL}/rest/v1/${table}`);
  const like = ilikeContains(term);
  url.searchParams.set('select', idCol);
  url.searchParams.set('or', `(${cols.map((c) => `${c}.ilike.${like}`).join(',')})`);
  url.searchParams.set('limit', '1000');
  const qs = extra ? `${url.toString()}&${extra}` : url.toString();
  const res = await fetch(qs, { headers: await authHeaders() });
  if (!res.ok) return [];
  const data = (await res.json()) as Record<string, number>[];
  return data.map((r) => r[idCol]);
}

// cost_center_id[] cujo código/descrição casa o termo. Exclui o sentinela id 0 ("não
// informado") — buscar por classificação não deve trazer o balde de não classificados.
async function findCostCenterIdsByTerm(term: string): Promise<number[]> {
  return findIdsByTerm(
    'financial_cost_center', 'cost_center_id',
    ['cost_center_code', 'cost_center_description'], term, 'cost_center_id=gt.0',
  );
}

// chart_account_id[] cujo PLANO (código/descrição), GRUPO ou SUBGRUPO casa o termo. Grupo e
// subgrupo são resolvidos primeiro (FKs diretas do plano: chart_account_group_id migration
// 058, chart_account_subgroup_id) e entram como `.in.(...)` no or do plano.
async function findChartAccountIdsByTerm(term: string): Promise<number[]> {
  const [groupIds, subgroupIds] = await Promise.all([
    findIdsByTerm('financial_chart_of_account_group', 'chart_account_group_id',
      ['group_code', 'group_description'], term),
    findIdsByTerm('financial_chart_of_account_subgroup', 'chart_account_subgroup_id',
      ['subgroup_code', 'subgroup_description'], term),
  ]);
  const url = new URL(`${BASE_URL}/rest/v1/financial_chart_of_account`);
  const like = ilikeContains(term);
  const clauses = [`account_code.ilike.${like}`, `account_description.ilike.${like}`];
  if (groupIds.length) clauses.push(`chart_account_group_id.in.(${groupIds.join(',')})`);
  if (subgroupIds.length) clauses.push(`chart_account_subgroup_id.in.(${subgroupIds.join(',')})`);
  url.searchParams.set('select', 'chart_account_id');
  url.searchParams.set('or', `(${clauses.join(',')})`);
  url.searchParams.set('chart_account_id', 'gt.0');
  url.searchParams.set('limit', '1000');
  const res = await fetch(url.toString(), { headers: await authHeaders() });
  if (!res.ok) return [];
  const data = (await res.json()) as { chart_account_id: number }[];
  return data.map((r) => r.chart_account_id);
}

// IDs de busca resolvidos em paralelo (fornecedor + classificação contábil) para o termo
// livre de /consulta. Busca por valor ("R$ …") pula tudo. Alimenta applyFinancialFilters.
interface SearchIds {
  supplierIds: number[];
  costCenterIds: number[];
  chartAccountIds: number[];
}
async function resolveSearchIds(term: string | undefined): Promise<SearchIds> {
  if (!term || isCurrencyValueSearch(term)) {
    return { supplierIds: [], costCenterIds: [], chartAccountIds: [] };
  }
  const [supplierIds, costCenterIds, chartAccountIds] = await Promise.all([
    findSupplierIdsByTerm(term),
    findCostCenterIdsByTerm(term),
    findChartAccountIdsByTerm(term),
  ]);
  return { supplierIds, costCenterIds, chartAccountIds };
}

const EMPTY_SEARCH_IDS: SearchIds = { supplierIds: [], costCenterIds: [], chartAccountIds: [] };

// Exportado para teste unitário puro (sem fetch) — monta o or(...) do PostgREST.
// ts-prune-ignore-next
export function applyFinancialFilters(
  params: URLSearchParams,
  { supplier, docType, statusId, paymentMethod, dateField, month, year, dateFrom, dateTo }: FinancialAccountControlFilters,
  searchIds: SearchIds = EMPTY_SEARCH_IDS,
  // Só o GRID inclui canceladas; os KPIs (Valor total) mantêm a exclusão para não
  // somar cancelado (evita confusão). Default = excluir cancelado.
  includeCancelled = false,
): void {
  // or= nas colunas próprias da conta (nº documento, assunto, remetente, valor) mais os
  // ids resolvidos pelo termo: sk_supplier (nome/CNPJ/CPF/e-mail do cadastro supplier),
  // cost_center_id (centro de custo) e chart_account_id (plano de contas + grupo/subgrupo).
  if (supplier) {
    if (isCurrencyValueSearch(supplier)) {
      // "R$ ..." → busca EXATA pelo valor do documento, sem busca textual.
      params.set('amount', `eq.${parseBrlAmount(supplier)}`);
    } else {
      const like = ilikeContains(supplier);
      const { supplierIds, costCenterIds, chartAccountIds } = searchIds;
      const clauses = [
        `invoice_number.ilike.${like}`,
        `subject.ilike.${like}`,
        `sender_email.ilike.${like}`,
      ];
      // Termo numérico SEM R$ (ex.: "463,21") também casa o VALOR, além do texto.
      const amount = parseBrlAmount(supplier);
      if (amount) clauses.push(`amount.eq.${amount}`);
      if (supplierIds.length) clauses.push(`sk_supplier.in.(${supplierIds.join(',')})`);
      if (costCenterIds.length) clauses.push(`cost_center_id.in.(${costCenterIds.join(',')})`);
      if (chartAccountIds.length) clauses.push(`chart_account_id.in.(${chartAccountIds.join(',')})`);
      params.set('or', `(${clauses.join(',')})`);
    }
  }
  if (docType) params.set('document_type', `eq.${docType}`);
  // Situação (status_id, fonte única): filtro explícito sobrescreve tudo. Sem filtro, o
  // grid mostra TODAS (inclui cancelado); os KPIs mantêm neq.cancelado (por id).
  if (statusId != null) params.set('status_id', `eq.${statusId}`);
  else if (!includeCancelled) params.set('status_id', `neq.${STATUS_ID_CANCELADO}`);
  if (paymentMethod) params.set('payment_method', `eq.${paymentMethod}`);
  // Filtro de data na coluna escolhida (vencimento por padrão):
  //  1) Intervalo explícito dateFrom/dateTo (busca global por range OU card "7 dias")
  //     tem PRECEDÊNCIA — quando presente, vence o mês/ano.
  //  2) Senão, mês/ano (navegação por período) monta o range do mês [01, último dia].
  //  3) Sem nada, não filtra por data.
  const col = dateField ?? 'due_date';
  if (dateFrom || dateTo) {
    if (dateFrom) params.append(col, `gte.${dateFrom}`);
    if (dateTo) params.append(col, `lte.${dateTo}`);
  } else if (month != null && year != null) {
    const first = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    const last = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
    params.append(col, `gte.${first}`);
    params.append(col, `lte.${last}`);
  }
}

export async function getFinancialAccountControl({
  supplier,
  docType,
  statusId,
  paymentMethod,
  dateField,
  month,
  year,
  dateFrom,
  dateTo,
  page = 1,
  pageSize = 20,
  sortCol,
  sortDir,
}: FinancialAccountControlFilters = {}): Promise<Paginated<FinancialAccountControl>> {
  const offset = (page - 1) * pageSize;
  const url = new URL(`${BASE_URL}/rest/v1/financial_account_control`);
  // JOIN com supplier via FK sk_supplier — retorna dados canônicos do cadastro
  // (nome/CNPJ/CPF). Fonte de verdade única; não há mais colunas denormalizadas.
  // Embeds de classificação contábil (FKs cost_center_id / chart_account_id).
  url.searchParams.set('select', SELECT_WITH_EMBEDS);
  // Ordenação padrão = criação (created_at) descendente — mais recente no topo (igual ao /emails).
  // Sort explícito do usuário sobrescreve. A coluna "Situação" ordena pelo NOME da
  // dimensão (alfabético — decisão de negócio; id ≠ ordem), via order=status_dim(status_name).
  const orderCol = sortCol === STATUS_SORT_KEY ? STATUS_DIM_ORDER : sortCol;
  url.searchParams.set('order', orderCol ? `${orderCol}.${sortDir ?? 'asc'}` : 'created_at.desc');
  url.searchParams.set('limit', String(pageSize));
  url.searchParams.set('offset', String(offset));
  // Busca "R$ ..." é por valor → não resolve ids pelo termo. Senão, resolve fornecedor +
  // classificação contábil (centro de custo / plano de contas / grupo / subgrupo) em paralelo.
  const searchIds = await resolveSearchIds(supplier);
  // Grid: inclui canceladas (includeCancelled=true). Os KPIs continuam excluindo.
  applyFinancialFilters(
    url.searchParams,
    { supplier, docType, statusId, paymentMethod, dateField, month, year, dateFrom, dateTo },
    searchIds,
    true,
  );
  const reqHeaders = await authHeaders({ Prefer: 'count=exact' });
  const res = await fetch(url.toString(), { headers: reqHeaders });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as FinancialAccountControl[];
  const cr = res.headers.get('Content-Range');
  const { total, totalIsEstimate } = parsePaginationTotal(cr, offset, pageSize, data.length);
  return { data, total, totalIsEstimate };
}

// Diretório id→e-mail dos usuários (view app_user, migration 077) para exibir o AUTOR
// (criado / editado / situação alterada) no detalhe de /consulta. São poucos usuários
// internos → busca única, sem paginação. Falha não é crítica (o detalhe cai no fallback).
export async function getAppUsers(): Promise<Record<string, string>> {
  const url = new URL(`${BASE_URL}/rest/v1/app_user`);
  url.searchParams.set('select', 'id,email');
  const res = await fetch(url.toString(), { headers: await authHeaders() });
  if (!res.ok) return {};
  const rows = (await res.json()) as { id: string; email: string }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.email]));
}

// Flags de curadoria manual de uma conta ("Tem NF ?" / "Tem Boleto"), editáveis
// como checkbox em /consulta. A migration 033 restringe o papel `authenticated`
// a escrever SOMENTE estas duas colunas (column-level grant + policy de RLS).
export type FinancialAccountFlag = 'has_invoice' | 'has_bank_slip';

export async function setFinancialAccountFlag(
  id: number,
  field: FinancialAccountFlag,
  value: boolean,
): Promise<void> {
  const url = new URL(`${BASE_URL}/rest/v1/financial_account_control`);
  url.searchParams.set('id', `eq.${id}`);
  const res = await fetch(url.toString(), {
    method: 'PATCH',
    headers: await authHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ [field]: value }),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}

// Permite ao usuário autenticado alterar a situação de uma conta em /consulta — grava
// por status_id (fonte única). A migration 068 concede GRANT UPDATE (status_id) TO
// authenticated; a trigger id-primária (SECURITY DEFINER) deriva o texto `status`.
export async function setFinancialAccountStatus(id: number, statusId: number): Promise<void> {
  const url = new URL(`${BASE_URL}/rest/v1/financial_account_control`);
  url.searchParams.set('id', `eq.${id}`);
  const res = await fetch(url.toString(), {
    method: 'PATCH',
    headers: await authHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ status_id: statusId }),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}

export async function setFinancialAccountStatusBulk(ids: number[], statusId: number): Promise<void> {
  const url = new URL(`${BASE_URL}/rest/v1/financial_account_control`);
  url.searchParams.set('id', `in.(${ids.join(',')})`);
  const res = await fetch(url.toString(), {
    method: 'PATCH',
    headers: await authHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ status_id: statusId }),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}

// Soma de `amount` para o filtro corrente — alimenta o card "Valor total" de
// /consulta, que reflete o subconjunto filtrado (cards ou filtros manuais).
// Busca só a coluna amount (sem paginar) e soma no cliente, como getFinancialStats.
export async function getFinancialAccountTotalValue(
  filters: FinancialAccountControlFilters = {},
): Promise<number> {
  const url = new URL(`${BASE_URL}/rest/v1/financial_account_control`);
  url.searchParams.set('select', 'amount');
  url.searchParams.set('limit', '10000');
  const searchIds = await resolveSearchIds(filters.supplier);
  applyFinancialFilters(url.searchParams, filters, searchIds);
  const res = await fetch(url.toString(), { headers: await authHeaders() });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { amount: number | null }[];
  return data.reduce((s, r) => s + (Number(r.amount) || 0), 0);
}

// Contagem EXATA de documentos NÃO cancelados para o filtro corrente — alimenta o
// "Total de registros" do rodapé de /consulta. Cancelado nunca entra em somas
// (includeCancelled=false, como o "Valor total"); o grid segue mostrando as linhas
// canceladas, mas elas não são contadas aqui. Usa Prefer: count=exact + Content-Range
// (limit 1, sem trafegar as linhas).
export async function getFinancialAccountCount(
  filters: FinancialAccountControlFilters = {},
): Promise<number> {
  const url = new URL(`${BASE_URL}/rest/v1/financial_account_control`);
  url.searchParams.set('select', 'id');
  url.searchParams.set('limit', '1');
  const searchIds = await resolveSearchIds(filters.supplier);
  applyFinancialFilters(url.searchParams, filters, searchIds);
  const res = await fetch(url.toString(), { headers: await authHeaders({ Prefer: 'count=exact' }) });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const cr = res.headers.get('Content-Range');
  const data = (await res.json()) as unknown[];
  return parsePaginationTotal(cr, 0, 1, data.length).total;
}

// ── email_processing_errors ───────────────────────────────────────────────

interface ProcessingErrorFilters {
  errorType?: string;
  sender?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export async function getProcessingErrors({
  errorType,
  sender,
  dateFrom,
  dateTo,
  page = 1,
  pageSize = 25,
}: ProcessingErrorFilters = {}): Promise<Paginated<ProcessingError>> {
  const offset = (page - 1) * pageSize;
  const url = new URL(`${BASE_URL}/rest/v1/email_processing_errors`);
  url.searchParams.set('select', '*');
  url.searchParams.set('order', 'logged_at.desc');
  url.searchParams.set('limit', String(pageSize));
  url.searchParams.set('offset', String(offset));
  if (errorType) url.searchParams.set('error_type', `eq.${errorType}`);
  if (sender) url.searchParams.set('sender_email', `ilike.*${sender}*`);
  if (dateFrom) url.searchParams.append('logged_at', `gte.${dateFrom}`);
  if (dateTo) url.searchParams.append('logged_at', `lte.${dateTo}T23:59:59`);
  const reqHeaders = await authHeaders({ Prefer: 'count=exact' });
  const res = await fetch(url.toString(), { headers: reqHeaders });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as ProcessingError[];
  const cr = res.headers.get('Content-Range');
  const { total, totalIsEstimate } = parsePaginationTotal(cr, offset, pageSize, data.length);
  return { data, total, totalIsEstimate };
}

export interface ProcessingErrorStats {
  total: number;
  counts: Record<string, number>;
}

export async function getProcessingErrorStats(): Promise<ProcessingErrorStats> {
  const data = await query<{ error_type: string }[]>('email_processing_errors', {
    select: 'error_type',
    limit: 5000,
  });
  const counts: Record<string, number> = {};
  for (const r of data) counts[r.error_type] = (counts[r.error_type] || 0) + 1;
  return { total: data.length, counts };
}

// Conta(s) extraida(s) ligada(s) a um e-mail, via gmail_message_id.
// Multiplos PDFs recebem sufixo (#1, #2), por isso o filtro usa LIKE prefixo.
export async function getAccountsByMessageId(messageId: string | null): Promise<FinancialAccountControl[]> {
  if (!messageId) return [];
  return query<FinancialAccountControl[]>('financial_account_control', {
    select: SELECT_WITH_EMBEDS,
    gmail_message_id: `like.${messageId}*`,
    order: 'due_date.asc',
  });
}

// Busca em lote o primeiro invoice_number de cada message_id.
// Usa PostgREST `or=(like.id*)` para cobrir o sufixo #N de múltiplos PDFs.
// Chunkeia em grupos de 50 para evitar URL muito longa.
export async function getInvoiceNumbersByMessageIds(
  messageIds: string[],
): Promise<Record<string, string>> {
  if (!messageIds.length) return {};
  const CHUNK = 50;
  const map: Record<string, string> = {};
  for (let i = 0; i < messageIds.length; i += CHUNK) {
    const chunk = messageIds.slice(i, i + CHUNK);
    const orVal = `(${chunk.map((id) => `gmail_message_id.like.${id}*`).join(',')})`;
    const url = new URL(`${BASE_URL}/rest/v1/financial_account_control`);
    url.searchParams.set('select', 'gmail_message_id,invoice_number');
    url.searchParams.set('or', orVal);
    url.searchParams.set('limit', '500');
    const res = await fetch(url.toString(), { headers: await authHeaders() });
    if (!res.ok) continue;
    const data = (await res.json()) as { gmail_message_id: string; invoice_number: string | null }[];
    for (const r of data) {
      if (!r.invoice_number) continue;
      const base = r.gmail_message_id.replace(/#\d+$/, '');
      if (!map[base]) map[base] = r.invoice_number;
    }
  }
  return map;
}

export interface FinancialStats {
  totalRecords: number;
  totalValue: number;
  pago: number;
  pagoValue: number;
  aVencer: number;
  aVencerValue: number;
  vencendo: number;
  vencendoValue: number;
  vencidas: number;
  vencidasValue: number;
}

export async function getFinancialStats(): Promise<FinancialStats> {
  // `neq.cancelado` espelha o padrão da listagem (applyFinancialFilters): contas
  // canceladas ficam fora dos KPIs a menos que o usuário filtre explicitamente.
  const all = await query<Pick<FinancialAccountControl, 'amount' | 'status_id' | 'due_date'>[]>(
    'financial_account_control',
    { select: 'amount,status_id,due_date', status_id: `neq.${STATUS_ID_CANCELADO}`, limit: 1000 },
  );
  const sum = (rows: typeof all) => rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const in7 = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10);

  const pagoRows = all.filter((r) => r.status_id === STATUS_ID_PAGO);
  const aVencerRows = all.filter((r) => r.status_id === STATUS_ID_A_VENCER);
  const vencendoRows = aVencerRows.filter(
    (r) => r.due_date !== null && r.due_date >= todayStr && r.due_date <= in7,
  );
  const vencidasRows = all.filter((r) => r.status_id === STATUS_ID_VENCIDO);

  return {
    totalRecords: all.length,
    totalValue: sum(all),
    pago: pagoRows.length,
    pagoValue: sum(pagoRows),
    aVencer: aVencerRows.length,
    aVencerValue: sum(aVencerRows),
    vencendo: vencendoRows.length,
    vencendoValue: sum(vencendoRows),
    vencidas: vencidasRows.length,
    vencidasValue: sum(vencidasRows),
  };
}

// ============================================================================
//  ADICIONAR AO FINAL DE: apps/frontend-vite/src/services/supabase.ts
//  (usa os helpers privados `query`/`authHeaders`/`BASE_URL` já existentes
//   no arquivo — por isso este bloco precisa viver DENTRO de supabase.ts.)
// ============================================================================

// ── dashboard ────────────────────────────────────────────────────────────────
// Agrega tudo que o Dashboard financeiro precisa em 2 leituras: as contas do mês
// selecionado (KPIs, situação por status, ranking de fornecedores, prioritárias)
// e as contas do ano (movimentações mês a mês). Tudo calculado no cliente, no
// mesmo estilo de getFinancialStats. `month` é 0-indexed (0 = Janeiro).

export interface DashboardKpis {
  totalCount: number; totalValue: number;
  pagoCount: number; pagoValue: number;
  aVencerCount: number; aVencerValue: number;
  vencendoCount: number; vencendoValue: number; // a vencer em 7 dias
  vencidasCount: number; vencidasValue: number;
}
export interface StatusSlice { status: string; count: number; value: number }
// Fatia genérica de donut por rótulo (tipos de conta / formas de pagamento).
export interface LabelSlice { label: string; count: number; value: number }
export interface SupplierRank { name: string; value: number; count: number }
export interface MonthlyFlow { month: number; aPagar: number; pago: number }
export type PriorityKind = 'agua' | 'luz' | 'internet' | 'telefone' | 'aluguel' | 'tributo' | 'outro';
export interface PriorityAccount {
  id: number; kind: PriorityKind; supplier: string;
  due: string | null; amount: number | null; status: string; critical: boolean;
}
export type DashboardScope = 'month' | 'all';
// Filtro por KPI clicado no topo do Dashboard. 'total' = sem filtro (padrão).
// Os cards de KPI seguem mostrando os totais completos; só os gráficos filtram.
export type KpiFilter = 'total' | 'pago' | 'aVencer' | 'vencendo7' | 'vencidas';
export interface DashboardData {
  month: number; year: number; scope: DashboardScope;
  kpis: DashboardKpis;
  statusBreakdown: StatusSlice[];
  documentTypeBreakdown: LabelSlice[];
  taxTypeBreakdown: LabelSlice[];
  paymentMethodBreakdown: LabelSlice[];
  supplierRanking: SupplierRank[];
  monthlyFlow: MonthlyFlow[];
  priorityAccounts: PriorityAccount[];
}

// Classificação de contas prioritárias/essenciais por palavra-chave no nome do
// fornecedor + descrição + tipo de documento. Ajuste as regexes conforme os
// fornecedores reais da operação.
const PRIORITY_RULES: { kind: PriorityKind; re: RegExp }[] = [
  { kind: 'agua', re: /\b(sabesp|[áa]guas?|saneamento|copasa|caesb|sanepar|aegea|cedae)\b/i },
  { kind: 'luz', re: /\b(cpfl|energia|el[ée]tric|enel|cemig|light|celesc|coelba|equatorial|neoenergia|elektro|edp)\b/i },
  { kind: 'internet', re: /\b(vivo|claro|tim\b|oi\b|net\b|fibra|internet|telecom|algar|brisanet|telef[oô]nica)\b/i },
  { kind: 'telefone', re: /\b(telefon[ei]a?|celular|m[óo]vel)\b/i },
  { kind: 'aluguel', re: /\b(aluguel|alug[uú][ée]is|imobili[áa]ri|loca[çc][ãa]o|condom[íi]nio)\b/i },
  { kind: 'tributo', re: /\b(darf|das\b|gps\b|inss|fgts|iss\b|icms|tribut|imposto|receita federal|prefeitura|sefaz)\b/i },
];

function classifyPriority(text: string): PriorityKind | null {
  for (const r of PRIORITY_RULES) if (r.re.test(text)) return r.kind;
  return null;
}

type MonthRow = Pick<FinancialAccountControl, 'id' | 'amount' | 'status_id' | 'due_date' | 'document_type' | 'payment_method' | 'description'> & {
  supplier?: { trade_name: string | null; legal_name: string | null } | null;
};
type YearRow = Pick<FinancialAccountControl, 'amount' | 'status_id' | 'due_date'>;

const num = (v: number | null | undefined): number => Number(v) || 0;
const supplierName = (r: MonthRow): string => r.supplier?.trade_name ?? r.supplier?.legal_name ?? 'Sem fornecedor';

// Agrega monthRows por um campo de rótulo → Top N por contagem + fatia "outros".
// Rótulo ausente (null) vira "não informado".
function breakdownBy(rows: MonthRow[], pick: (r: MonthRow) => string | null, topN = 8): LabelSlice[] {
  const map = new Map<string, { count: number; value: number }>();
  for (const r of rows) {
    const k = pick(r) ?? 'não informado';
    const cur = map.get(k) ?? { count: 0, value: 0 };
    cur.count += 1; cur.value += num(r.amount);
    map.set(k, cur);
  }
  const all = [...map.entries()]
    .map(([label, v]) => ({ label, ...v }))
    .sort((a, b) => b.count - a.count);
  if (all.length <= topN) return all;
  const top = all.slice(0, topN);
  const rest = all.slice(topN).reduce(
    (acc, x) => ({ count: acc.count + x.count, value: acc.value + x.value }),
    { count: 0, value: 0 },
  );
  return [...top, { label: 'outros', ...rest }];
}

// Documentos tributários (guias de arrecadação) — agrupados num único rótulo
// "Tributos" no donut de tipos de conta. Espelha a noção de documento fiscal do
// pipeline (_is_tax_document); `gps` (INSS/previdência) incluído por ser guia de
// arrecadação. Ajuste o conjunto se a operação exigir.
const TAX_DOCUMENT_TYPES = new Set<string>([
  'darf', 'gps', 'das', 'gru', 'dae', 'dare', 'gnre',
  'ipva', 'iptu', 'dam / duam', 'iss', 'itbi', 'gare', 'tributo',
]);
export function isTaxDocumentType(dt: string | null): boolean {
  return !!dt && TAX_DOCUMENT_TYPES.has(dt.toLowerCase());
}
// No donut de tipos de conta, todas as guias tributárias colapsam em "Tributos"
// (o detalhamento por tipo vai no donut dedicado "Tributos").
export function groupDocumentTypeLabel(dt: string | null): string | null {
  return isTaxDocumentType(dt) ? 'Tributos' : dt;
}

// Predicado do filtro por KPI. Vale para qualquer linha com status_id + due_date
// (MonthRow e YearRow). 'total' não filtra.
function matchesKpiFilter(
  r: { status_id: number; due_date: string | null },
  filter: KpiFilter,
  todayStr: string,
  in7: string,
): boolean {
  switch (filter) {
    case 'pago': return r.status_id === STATUS_ID_PAGO;
    case 'aVencer': return r.status_id === STATUS_ID_A_VENCER;
    case 'vencendo7': return r.status_id === STATUS_ID_A_VENCER && !!r.due_date && r.due_date >= todayStr && r.due_date <= in7;
    case 'vencidas': return r.status_id === STATUS_ID_VENCIDO;
    default: return true; // 'total'
  }
}

// `scope` = 'month' (mês selecionado, padrão) ou 'all' (todas as contas, sem filtro
// de data nos painéis). O gráfico de movimentações sempre reflete o `year`.
// `filter` = KPI clicado no topo: os cards mantêm os totais completos, mas TODOS
// os gráficos passam a refletir só o subconjunto do KPI (limpar = 'total').
export async function getDashboardData(month: number, year: number, scope: DashboardScope = 'month', filter: KpiFilter = 'total'): Promise<DashboardData> {
  const first = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const last = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);
  const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  // Contas do escopo (exclui cancelado) com embed do fornecedor.
  // 'month' → filtra pelo intervalo do mês; 'all' → todas as contas.
  // As duas leituras são independentes → Promise.all (antes eram sequenciais).
  const [monthRows, yearRows] = await Promise.all([
    query<MonthRow[]>('financial_account_control', {
      select: 'id,amount,status_id,due_date,document_type,payment_method,description,supplier(trade_name,legal_name)',
      status_id: `neq.${STATUS_ID_CANCELADO}`,
      ...(scope === 'month' ? { and: `(due_date.gte.${first},due_date.lte.${last})` } : {}),
      limit: scope === 'month' ? 5000 : 20000,
    }),
    // Contas do ano inteiro (só os campos do gráfico) para as movimentações mês a mês.
    query<YearRow[]>('financial_account_control', {
      select: 'amount,status_id,due_date',
      status_id: `neq.${STATUS_ID_CANCELADO}`,
      and: `(due_date.gte.${year}-01-01,due_date.lte.${year}-12-31)`,
      limit: 20000,
    }),
  ]);

  // KPIs
  const sum = (rows: MonthRow[]): number => rows.reduce((s, r) => s + num(r.amount), 0);
  const pagoRows = monthRows.filter((r) => r.status_id === STATUS_ID_PAGO);
  const aVencerRows = monthRows.filter((r) => r.status_id === STATUS_ID_A_VENCER);
  const vencendoRows = aVencerRows.filter((r) => r.due_date && r.due_date >= todayStr && r.due_date <= in7);
  const vencidasRows = monthRows.filter((r) => r.status_id === STATUS_ID_VENCIDO);
  const kpis: DashboardKpis = {
    totalCount: monthRows.length, totalValue: sum(monthRows),
    pagoCount: pagoRows.length, pagoValue: sum(pagoRows),
    aVencerCount: aVencerRows.length, aVencerValue: sum(aVencerRows),
    vencendoCount: vencendoRows.length, vencendoValue: sum(vencendoRows),
    vencidasCount: vencidasRows.length, vencidasValue: sum(vencidasRows),
  };

  // Aplica o filtro do KPI clicado APENAS aos gráficos (os KPIs acima usam o
  // conjunto completo). 'total' => sem filtro (evita recriar os arrays à toa).
  const fMonth = filter === 'total' ? monthRows : monthRows.filter((r) => matchesKpiFilter(r, filter, todayStr, in7));
  const fYear = filter === 'total' ? yearRows : yearRows.filter((r) => matchesKpiFilter(r, filter, todayStr, in7));

  // Situação por status
  const statusMap = new Map<string, { count: number; value: number }>();
  for (const r of fMonth) {
    const k = STATUS_NAME_BY_ID[r.status_id] ?? 'pendente';
    const cur = statusMap.get(k) ?? { count: 0, value: 0 };
    cur.count += 1; cur.value += num(r.amount);
    statusMap.set(k, cur);
  }
  const statusBreakdown: StatusSlice[] = [...statusMap.entries()]
    .map(([status, v]) => ({ status, ...v }))
    .sort((a, b) => b.count - a.count);

  // Tipos de conta (document_type) e formas de pagamento (payment_method) — Top 8 + "outros".
  // No de tipos de conta, todas as guias tributárias colapsam num único "Tributos".
  const documentTypeBreakdown = breakdownBy(fMonth, (r) => groupDocumentTypeLabel(r.document_type));
  const paymentMethodBreakdown = breakdownBy(fMonth, (r) => r.payment_method);
  // Donut "Tributos": cópia do de tipos de conta, mas só das guias tributárias,
  // detalhadas por tipo (darf, das, gnre, …).
  const taxTypeBreakdown = breakdownBy(fMonth.filter((r) => isTaxDocumentType(r.document_type)), (r) => r.document_type);

  // Ranking de fornecedores (top 6 por valor)
  const supMap = new Map<string, { value: number; count: number }>();
  for (const r of fMonth) {
    const k = supplierName(r);
    const cur = supMap.get(k) ?? { value: 0, count: 0 };
    cur.value += num(r.amount); cur.count += 1;
    supMap.set(k, cur);
  }
  const supplierRanking: SupplierRank[] = [...supMap.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);

  // Movimentações mês a mês (12 baldes)
  const buckets: MonthlyFlow[] = Array.from({ length: 12 }, (_, m) => ({ month: m, aPagar: 0, pago: 0 }));
  for (const r of fYear) {
    if (!r.due_date) continue;
    const m = Number(r.due_date.slice(5, 7)) - 1;
    if (m < 0 || m > 11) continue;
    buckets[m].aPagar += num(r.amount);
    if (r.status_id === STATUS_ID_PAGO) buckets[m].pago += num(r.amount);
  }

  // Contas críticas / prioritárias: utilidades essenciais OU vencidas.
  const priorityAccounts: PriorityAccount[] = fMonth
    .map((r): PriorityAccount | null => {
      const kind = classifyPriority(`${supplierName(r)} ${r.description ?? ''} ${r.document_type ?? ''}`);
      const isVencido = r.status_id === STATUS_ID_VENCIDO;
      if (!kind && !isVencido) return null;
      return {
        id: r.id, kind: kind ?? 'outro', supplier: supplierName(r),
        due: r.due_date, amount: r.amount,
        // PriorityAccount.status carrega o NOME (o Dashboard renderiza StatusBadge por nome).
        status: STATUS_NAME_BY_ID[r.status_id] ?? 'pendente',
        critical: isVencido,
      };
    })
    .filter((x): x is PriorityAccount => x !== null)
    .sort((a, b) => {
      if (a.critical !== b.critical) return a.critical ? -1 : 1; // vencidas primeiro
      return (a.due ?? '').localeCompare(b.due ?? '');
    })
    .slice(0, 7);

  return { month, year, scope, kpis, statusBreakdown, documentTypeBreakdown, taxTypeBreakdown, paymentMethodBreakdown, supplierRanking, monthlyFlow: buckets, priorityAccounts };
}
