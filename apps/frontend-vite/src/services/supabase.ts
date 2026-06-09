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

import type { EmailControl, FinancialEmail, ProcessingError } from '@sheild/shared';
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

export interface EmailControlFilters {
  status?: string;
  sender?: string;
  days?: number;
  limit?: number;
}

export async function getEmailControl({
  status,
  sender,
  days,
  limit = 200,
}: EmailControlFilters = {}): Promise<EmailControl[]> {
  const params: QueryParams = { select: '*', order: 'received_at.desc', limit };
  if (status) params['status'] = `eq.${status}`;
  if (sender) params['sender_email'] = `ilike.*${sender}*`;
  if (days) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    params['received_at'] = `gte.${since}`;
  }
  return query<EmailControl[]>('email_control', params);
}

export interface EmailStats {
  total: number;
  withPdf: number;
  extracted: number;
  semPdf: number;
}

export async function getEmailStats(): Promise<EmailStats> {
  const [all, withPdf, extracted] = await Promise.all([
    query<{ id: number }[]>('email_control', { select: 'id', limit: 1000 }),
    query<{ id: number }[]>('email_control', { select: 'id', has_attachment: 'eq.true', limit: 1000 }),
    query<{ id: number }[]>('email_control', { select: 'id', pdf_extracted: 'eq.true', limit: 1000 }),
  ]);
  return {
    total: all.length,
    withPdf: withPdf.length,
    extracted: extracted.length,
    semPdf: all.length - withPdf.length,
  };
}

// ── financial_emails ───────────────────────────────────────────────────────

export interface FinancialEmailFilters {
  supplier?: string;
  docType?: string;
  status?: string;
  dueStatus?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface Paginated<T> {
  data: T[];
  total: number;
}

export async function getFinancialEmails({
  supplier,
  docType,
  status,
  dueStatus,
  dateFrom,
  dateTo,
  page = 1,
  pageSize = 20,
}: FinancialEmailFilters = {}): Promise<Paginated<FinancialEmail>> {
  const offset = (page - 1) * pageSize;
  const url = new URL(`${BASE_URL}/rest/v1/financial_emails`);
  url.searchParams.set('select', '*');
  url.searchParams.set('order', 'due_date.asc');
  url.searchParams.set('limit', String(pageSize));
  url.searchParams.set('offset', String(offset));
  if (supplier) url.searchParams.set('supplier_name', `ilike.*${supplier}*`);
  if (docType) url.searchParams.set('document_type', `eq.${docType}`);
  if (status) url.searchParams.set('status', `eq.${status}`);
  if (dueStatus) url.searchParams.set('due_status', `eq.${dueStatus}`);
  if (dateFrom) url.searchParams.append('due_date', `gte.${dateFrom}`);
  if (dateTo) url.searchParams.append('due_date', `lte.${dateTo}`);
  const reqHeaders = await authHeaders({ Prefer: 'count=exact' });
  const res = await fetch(url.toString(), { headers: reqHeaders });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as FinancialEmail[];
  const cr = res.headers.get('Content-Range');
  const total = cr ? parseInt(cr.split('/')[1]) || 0 : data.length;
  return { data, total };
}

// ── email_processing_errors ───────────────────────────────────────────────

export interface ProcessingErrorFilters {
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
  const total = cr ? parseInt(cr.split('/')[1]) || 0 : data.length;
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
export async function getAccountsByMessageId(messageId: string | null): Promise<FinancialEmail[]> {
  if (!messageId) return [];
  return query<FinancialEmail[]>('financial_emails', {
    select: '*',
    gmail_message_id: `like.${messageId}*`,
    order: 'due_date.asc',
  });
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
    query<Pick<FinancialEmail, 'amount' | 'status' | 'due_date' | 'due_status'>[]>('financial_emails', {
      select: 'amount,status,due_date,due_status',
      limit: 1000,
    }),
    query<{ id: number }[]>('financial_emails', { select: 'id', status: 'eq.pending', limit: 1000 }),
  ]);
  const total = all.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const today = new Date();
  const in7 = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10);
  const vencendo = all.filter((r) => r.status === 'pending' && r.due_date && r.due_date <= in7).length;
  const vencidas = all.filter((r) => r.due_status === 'Vencido').length;
  return { totalRecords: all.length, pending: pending.length, totalValue: total, vencendo, vencidas };
}
