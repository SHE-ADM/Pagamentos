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
import { supabase } from '../lib/supabaseClient';

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
  const byStatus = (s: string) =>
    query<{ id: number }[]>('email_control', { select: 'id', status: `eq.${s}`, limit: 2000 });
  const [all, extraido, recebido, pendente, falha, ignorado, duplicidade] = await Promise.all([
    query<{ id: number }[]>('email_control', { select: 'id', limit: 2000 }),
    byStatus('extraído'),
    byStatus('recebido'),
    byStatus('pendente'),
    byStatus('falha'),
    byStatus('ignorado'),
    byStatus('duplicidade'),
  ]);
  return {
    total: all.length,
    extraido: extraido.length,
    recebido: recebido.length,
    pendente: pendente.length,
    falha: falha.length,
    ignorado: ignorado.length,
    duplicidade: duplicidade.length,
  };
}

// ── financial_account_control ───────────────────────────────────────────────

// SELECT com os JOINs de exibição: fornecedor (nome/CNPJ/CPF) + classificação
// contábil (centro de custo / plano de contas) via aliases de embed do PostgREST.
const SELECT_WITH_EMBEDS =
  '*,supplier(trade_name,legal_name,cnpj,cpf),' +
  'cost_center:financial_cost_center(cost_center_code,cost_center_description),' +
  'chart_account:financial_chart_of_account(account_code,account_description)';

interface FinancialAccountControlFilters {
  supplier?: string;
  docType?: string;
  status?: string;
  paymentMethod?: string;
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
async function findSupplierIdsByTerm(term: string): Promise<number[]> {
  const url = new URL(`${BASE_URL}/rest/v1/supplier`);
  url.searchParams.set('select', 'sk_supplier');
  url.searchParams.set(
    'or',
    `(trade_name.ilike.*${term}*,legal_name.ilike.*${term}*,cnpj.ilike.*${term}*,` +
      `cpf.ilike.*${term}*,email.ilike.*${term}*,email2.ilike.*${term}*,` +
      `email3.ilike.*${term}*,email4.ilike.*${term}*)`,
  );
  url.searchParams.set('limit', '1000');
  const res = await fetch(url.toString(), { headers: await authHeaders() });
  if (!res.ok) return [];
  const data = (await res.json()) as { sk_supplier: number }[];
  return data.map((r) => r.sk_supplier);
}

function applyFinancialFilters(
  params: URLSearchParams,
  { supplier, docType, status, paymentMethod, dateFrom, dateTo }: FinancialAccountControlFilters,
  supplierIds: number[] = [],
  // Só o GRID inclui canceladas; os KPIs (Valor total) mantêm a exclusão para não
  // somar cancelado (evita confusão). Default = excluir cancelado.
  includeCancelled = false,
): void {
  // or= nas colunas próprias da conta (nº documento, assunto, remetente) mais os
  // sk_supplier resolvidos pelo termo (nome/CNPJ/CPF/e-mail do cadastro supplier).
  if (supplier) {
    const clauses = [
      `invoice_number.ilike.*${supplier}*`,
      `subject.ilike.*${supplier}*`,
      `sender_email.ilike.*${supplier}*`,
    ];
    if (supplierIds.length) clauses.push(`sk_supplier.in.(${supplierIds.join(',')})`);
    params.set('or', `(${clauses.join(',')})`);
  }
  if (docType) params.set('document_type', `eq.${docType}`);
  // Situação: filtro explícito sobrescreve tudo. Sem filtro, o grid mostra TODAS
  // (inclui cancelado — regra antiga removida); os KPIs mantêm `neq.cancelado`.
  if (status) params.set('status', `eq.${status}`);
  else if (!includeCancelled) params.set('status', 'neq.cancelado');
  if (paymentMethod) params.set('payment_method', `eq.${paymentMethod}`);
  if (dateFrom) params.append('due_date', `gte.${dateFrom}`);
  if (dateTo) params.append('due_date', `lte.${dateTo}`);
}

export async function getFinancialAccountControl({
  supplier,
  docType,
  status,
  paymentMethod,
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
  // Sort explícito do usuário sobrescreve.
  url.searchParams.set('order', sortCol ? `${sortCol}.${sortDir ?? 'asc'}` : 'created_at.desc');
  url.searchParams.set('limit', String(pageSize));
  url.searchParams.set('offset', String(offset));
  const supplierIds = supplier ? await findSupplierIdsByTerm(supplier) : [];
  // Grid: inclui canceladas (includeCancelled=true). Os KPIs continuam excluindo.
  applyFinancialFilters(url.searchParams, { supplier, docType, status, paymentMethod, dateFrom, dateTo }, supplierIds, true);
  const reqHeaders = await authHeaders({ Prefer: 'count=exact' });
  const res = await fetch(url.toString(), { headers: reqHeaders });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as FinancialAccountControl[];
  const cr = res.headers.get('Content-Range');
  const { total, totalIsEstimate } = parsePaginationTotal(cr, offset, pageSize, data.length);
  return { data, total, totalIsEstimate };
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

// Permite ao usuário autenticado alterar a situação de uma conta em /consulta.
// A migration 036 concede GRANT UPDATE (status) TO authenticated.
// A trigger fn_set_status_from_due_date (SECURITY DEFINER) sincroniza status_id.
export async function setFinancialAccountStatus(id: number, status: string): Promise<void> {
  const url = new URL(`${BASE_URL}/rest/v1/financial_account_control`);
  url.searchParams.set('id', `eq.${id}`);
  const res = await fetch(url.toString(), {
    method: 'PATCH',
    headers: await authHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}

export async function setFinancialAccountStatusBulk(ids: number[], status: string): Promise<void> {
  const url = new URL(`${BASE_URL}/rest/v1/financial_account_control`);
  url.searchParams.set('id', `in.(${ids.join(',')})`);
  const res = await fetch(url.toString(), {
    method: 'PATCH',
    headers: await authHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ status }),
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
  const supplierIds = filters.supplier ? await findSupplierIdsByTerm(filters.supplier) : [];
  applyFinancialFilters(url.searchParams, filters, supplierIds);
  const res = await fetch(url.toString(), { headers: await authHeaders() });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { amount: number | null }[];
  return data.reduce((s, r) => s + (Number(r.amount) || 0), 0);
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
  const all = await query<Pick<FinancialAccountControl, 'amount' | 'status' | 'due_date'>[]>(
    'financial_account_control',
    { select: 'amount,status,due_date', status: 'neq.cancelado', limit: 1000 },
  );
  const sum = (rows: typeof all) => rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const in7 = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10);

  const pagoRows = all.filter((r) => r.status === 'pago');
  const aVencerRows = all.filter((r) => r.status === 'a vencer');
  const vencendoRows = aVencerRows.filter(
    (r) => r.due_date !== null && r.due_date >= todayStr && r.due_date <= in7,
  );
  const vencidasRows = all.filter((r) => r.status === 'vencido');

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
export interface SupplierRank { name: string; value: number; count: number }
export interface MonthlyFlow { month: number; aPagar: number; pago: number }
export type PriorityKind = 'agua' | 'luz' | 'internet' | 'telefone' | 'aluguel' | 'tributo' | 'outro';
export interface PriorityAccount {
  id: number; kind: PriorityKind; supplier: string;
  due: string | null; amount: number | null; status: string; critical: boolean;
}
export type DashboardScope = 'month' | 'all';
export interface DashboardData {
  month: number; year: number; scope: DashboardScope;
  kpis: DashboardKpis;
  statusBreakdown: StatusSlice[];
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

type MonthRow = Pick<FinancialAccountControl, 'id' | 'amount' | 'status' | 'due_date' | 'document_type' | 'description'> & {
  supplier?: { trade_name: string | null; legal_name: string | null } | null;
};
type YearRow = Pick<FinancialAccountControl, 'amount' | 'status' | 'due_date'>;

const num = (v: number | null | undefined): number => Number(v) || 0;
const supplierName = (r: MonthRow): string => r.supplier?.trade_name ?? r.supplier?.legal_name ?? 'Sem fornecedor';

// `scope` = 'month' (mês selecionado, padrão) ou 'all' (todas as contas, sem filtro
// de data nos painéis). O gráfico de movimentações sempre reflete o `year`.
export async function getDashboardData(month: number, year: number, scope: DashboardScope = 'month'): Promise<DashboardData> {
  const first = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const last = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);
  const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  // Contas do escopo (exclui cancelado) com embed do fornecedor.
  // 'month' → filtra pelo intervalo do mês; 'all' → todas as contas.
  const monthRows = await query<MonthRow[]>('financial_account_control', {
    select: 'id,amount,status,due_date,document_type,description,supplier(trade_name,legal_name)',
    status: 'neq.cancelado',
    ...(scope === 'month' ? { and: `(due_date.gte.${first},due_date.lte.${last})` } : {}),
    limit: scope === 'month' ? 5000 : 20000,
  });

  // Contas do ano inteiro (só os campos do gráfico) para as movimentações mês a mês.
  const yearRows = await query<YearRow[]>('financial_account_control', {
    select: 'amount,status,due_date',
    status: 'neq.cancelado',
    and: `(due_date.gte.${year}-01-01,due_date.lte.${year}-12-31)`,
    limit: 20000,
  });

  // KPIs
  const sum = (rows: MonthRow[]): number => rows.reduce((s, r) => s + num(r.amount), 0);
  const pagoRows = monthRows.filter((r) => r.status === 'pago');
  const aVencerRows = monthRows.filter((r) => r.status === 'a vencer');
  const vencendoRows = aVencerRows.filter((r) => r.due_date && r.due_date >= todayStr && r.due_date <= in7);
  const vencidasRows = monthRows.filter((r) => r.status === 'vencido');
  const kpis: DashboardKpis = {
    totalCount: monthRows.length, totalValue: sum(monthRows),
    pagoCount: pagoRows.length, pagoValue: sum(pagoRows),
    aVencerCount: aVencerRows.length, aVencerValue: sum(aVencerRows),
    vencendoCount: vencendoRows.length, vencendoValue: sum(vencendoRows),
    vencidasCount: vencidasRows.length, vencidasValue: sum(vencidasRows),
  };

  // Situação por status
  const statusMap = new Map<string, { count: number; value: number }>();
  for (const r of monthRows) {
    const k = r.status ?? 'pendente';
    const cur = statusMap.get(k) ?? { count: 0, value: 0 };
    cur.count += 1; cur.value += num(r.amount);
    statusMap.set(k, cur);
  }
  const statusBreakdown: StatusSlice[] = [...statusMap.entries()]
    .map(([status, v]) => ({ status, ...v }))
    .sort((a, b) => b.count - a.count);

  // Ranking de fornecedores (top 6 por valor)
  const supMap = new Map<string, { value: number; count: number }>();
  for (const r of monthRows) {
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
  for (const r of yearRows) {
    if (!r.due_date) continue;
    const m = Number(r.due_date.slice(5, 7)) - 1;
    if (m < 0 || m > 11) continue;
    buckets[m].aPagar += num(r.amount);
    if (r.status === 'pago') buckets[m].pago += num(r.amount);
  }

  // Contas críticas / prioritárias: utilidades essenciais OU vencidas.
  const priorityAccounts: PriorityAccount[] = monthRows
    .map((r): PriorityAccount | null => {
      const kind = classifyPriority(`${supplierName(r)} ${r.description ?? ''} ${r.document_type ?? ''}`);
      const isVencido = r.status === 'vencido';
      if (!kind && !isVencido) return null;
      return {
        id: r.id, kind: kind ?? 'outro', supplier: supplierName(r),
        due: r.due_date, amount: r.amount, status: r.status ?? 'pendente',
        critical: isVencido,
      };
    })
    .filter((x): x is PriorityAccount => x !== null)
    .sort((a, b) => {
      if (a.critical !== b.critical) return a.critical ? -1 : 1; // vencidas primeiro
      return (a.due ?? '').localeCompare(b.due ?? '');
    })
    .slice(0, 7);

  return { month, year, scope, kpis, statusBreakdown, supplierRanking, monthlyFlow: buckets, priorityAccounts };
}
