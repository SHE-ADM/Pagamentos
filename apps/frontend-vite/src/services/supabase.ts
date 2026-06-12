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

export interface EmailStats {
  total: number;
  withPdf: number;
  extracted: number;
  semPdf: number;
  soRecebidos: number;
}

export async function getEmailStats(): Promise<EmailStats> {
  const [all, withPdf, extracted, pendingExtraction] = await Promise.all([
    query<{ id: number }[]>('email_control', { select: 'id', limit: 1000 }),
    query<{ id: number }[]>('email_control', { select: 'id', has_attachment: 'eq.true', limit: 1000 }),
    query<{ id: number }[]>('email_control', { select: 'id', pdf_extracted: 'eq.true', limit: 1000 }),
    // Tem anexo mas ainda não foi extraído — fonte de verdade para o card "Só recebidos".
    query<{ id: number }[]>('email_control', {
      select: 'id',
      has_attachment: 'eq.true',
      pdf_extracted: 'eq.false',
      limit: 1000,
    }),
  ]);
  return {
    total: all.length,
    withPdf: withPdf.length,
    extracted: extracted.length,
    semPdf: all.length - withPdf.length,
    soRecebidos: pendingExtraction.length,
  };
}

// ── financial_account_control ───────────────────────────────────────────────

interface FinancialAccountControlFilters {
  supplier?: string;
  docType?: string;
  status?: string;
  dueStatuses?: string[];
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
}

export async function getFinancialAccountControl({
  supplier,
  docType,
  status,
  dueStatuses,
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
  url.searchParams.set('select', '*');
  url.searchParams.set('order', sortCol ? `${sortCol}.${sortDir ?? 'asc'}` : 'issue_date.desc');
  url.searchParams.set('limit', String(pageSize));
  url.searchParams.set('offset', String(offset));
  // or= em três colunas: nome, CNPJ/CPF e nº documento
  if (supplier) {
    url.searchParams.set(
      'or',
      `(supplier_name.ilike.*${supplier}*,supplier_cnpj.ilike.*${supplier}*,invoice_number.ilike.*${supplier}*)`,
    );
  }
  if (docType) url.searchParams.set('document_type', `eq.${docType}`);
  // Sem filtro de status → exclui cancelado por padrão; filtro explícito sobrescreve.
  if (status) {
    url.searchParams.set('status', `eq.${status}`);
  } else {
    url.searchParams.set('status', 'neq.cancelado');
  }
  if (dueStatuses?.length === 1) url.searchParams.set('due_status', `eq.${dueStatuses[0]}`);
  else if (dueStatuses && dueStatuses.length > 1) url.searchParams.set('due_status', `in.(${dueStatuses.join(',')})`);
  if (paymentMethod) url.searchParams.set('payment_method', `eq.${paymentMethod}`);
  if (dateFrom) url.searchParams.append('due_date', `gte.${dateFrom}`);
  if (dateTo) url.searchParams.append('due_date', `lte.${dateTo}`);
  const reqHeaders = await authHeaders({ Prefer: 'count=exact' });
  const res = await fetch(url.toString(), { headers: reqHeaders });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as FinancialAccountControl[];
  const cr = res.headers.get('Content-Range');
  const total = cr ? Number.parseInt(cr.split('/')[1]) || 0 : data.length;
  return { data, total };
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
  const total = cr ? Number.parseInt(cr.split('/')[1]) || 0 : data.length;
  return { data, total };
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
    select: '*',
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
  pending: number;
  totalValue: number;
  vencendo: number;
  vencidas: number;
}

export async function getFinancialStats(): Promise<FinancialStats> {
  const [all, pending] = await Promise.all([
    query<Pick<FinancialAccountControl, 'amount' | 'status' | 'due_date' | 'due_status'>[]>('financial_account_control', {
      select: 'amount,status,due_date,due_status',
      limit: 1000,
    }),
    query<{ id: number }[]>('financial_account_control', { select: 'id', status: 'eq.pendente', limit: 1000 }),
  ]);
  const total = all.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const today = new Date();
  const in7 = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10);
  const vencendo = all.filter((r) => r.status === 'pendente' && r.due_date && r.due_date <= in7).length;
  const vencidas = all.filter((r) => r.due_status === 'vencido').length;
  return { totalRecords: all.length, pending: pending.length, totalValue: total, vencendo, vencidas };
}
