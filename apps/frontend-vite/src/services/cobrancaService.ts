// services/cobrancaService.ts
// Leitura paginada de cobranca_envios_log e cobranca_erros_log.

import type { CobrancaEnvioLog, CobrancaErroLog, PaginatedResult } from '../types/cobranca';

const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;
const PAGE_SIZE     = 50;

function baseHeaders(token: string): HeadersInit {
  return {
    apikey:         SUPABASE_ANON,
    Authorization:  `Bearer ${token}`,
    Accept:         'application/json',
    'Content-Type': 'application/json',
    Prefer:         'count=exact',
  };
}

function parseTotal(contentRange: string | null): number {
  if (!contentRange) return 0;
  const match = /\/(\d+)$/.exec(contentRange);
  return match ? Number.parseInt(match[1], 10) : 0;
}

async function get<T>(token: string, table: string, params: Record<string, string>): Promise<PaginatedResult<T>> {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { headers: baseHeaders(token) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[${table}] HTTP ${res.status}: ${body}`);
  }
  const data  = (await res.json()) as T[];
  const total = parseTotal(res.headers.get('Content-Range'));
  return { data, total };
}

interface EnviosFilter {
  token: string;
  page?: number;
  search?: string;
  sentFrom?: string;
  sentTo?: string;
  dueFrom?: string;
  dueTo?: string;
  sortCol?: string | null;
  sortDir?: 'asc' | 'desc' | null;
}

export async function fetchEnviosLog(filter: EnviosFilter): Promise<PaginatedResult<CobrancaEnvioLog>> {
  const { token, page = 1, search, sentFrom, sentTo, dueFrom, dueTo, sortCol, sortDir } = filter;
  // Ordenação padrão = vencimento (due_date) descendente; sort explícito sobrescreve.
  const order = sortCol && sortDir ? `${sortCol}.${sortDir}` : 'due_date.desc';
  const params: Record<string, string> = {
    select: 'id,document_id,customer_name,primary_email,cc_email,due_date,bill_amount,email_subject,sent_at',
    order, limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE),
  };
  if (search?.trim()) params['or'] = `(customer_name.ilike.*${search.trim()}*,document_id.ilike.*${search.trim()}*)`;
  // Filtros de data combinados via `and` (coexiste com o `or` da busca — o PostgREST faz
  // AND entre os parâmetros de topo). "Enviado em" (sent_at) é TIMESTAMPTZ: filtramos só
  // pela DATA, ignorando o horário — o limite superior vai até o fim do dia (T23:59:59).
  // "Vencimento" (due_date) é DATE puro (gte/lte direto, sem horário).
  const conds: string[] = [];
  if (sentFrom) conds.push(`sent_at.gte.${sentFrom}`);
  if (sentTo)   conds.push(`sent_at.lte.${sentTo}T23:59:59`);
  if (dueFrom)  conds.push(`due_date.gte.${dueFrom}`);
  if (dueTo)    conds.push(`due_date.lte.${dueTo}`);
  if (conds.length) params['and'] = `(${conds.join(',')})`;
  return get<CobrancaEnvioLog>(token, 'cobranca_envios_log', params);
}

interface ErrosFilter { token: string; page?: number; errorType?: string; search?: string; dateFrom?: string; dateTo?: string; }

export async function fetchErrosLog(filter: ErrosFilter): Promise<PaginatedResult<CobrancaErroLog>> {
  const { token, page = 1, errorType, search, dateFrom, dateTo } = filter;
  const params: Record<string, string> = {
    select: 'id,document_id,customer_name,primary_email,due_date,bill_amount,error_type,error_message,error_detail,occurred_at',
    order: 'occurred_at.desc', limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE),
  };
  if (errorType?.trim()) params['error_type'] = `eq.${errorType.trim()}`;
  if (search?.trim()) params['or'] = `(customer_name.ilike.*${search.trim()}*,document_id.ilike.*${search.trim()}*)`;
  if (dateFrom) params['occurred_at'] = `gte.${dateFrom}`;
  if (dateTo)   params['occurred_at'] = params['occurred_at'] ? `gte.${dateFrom},lte.${dateTo}T23:59:59` : `lte.${dateTo}T23:59:59`;
  return get<CobrancaErroLog>(token, 'cobranca_erros_log', params);
}
