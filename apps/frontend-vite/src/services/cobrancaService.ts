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

interface EnviosFilter { token: string; page?: number; search?: string; dateFrom?: string; dateTo?: string; }

export async function fetchEnviosLog(filter: EnviosFilter): Promise<PaginatedResult<CobrancaEnvioLog>> {
  const { token, page = 1, search, dateFrom, dateTo } = filter;
  const params: Record<string, string> = {
    select: 'id,document_id,customer_name,primary_email,cc_email,due_date,bill_amount,email_subject,sent_at',
    order: 'sent_at.desc', limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE),
  };
  if (search?.trim()) params['or'] = `(customer_name.ilike.*${search.trim()}*,document_id.ilike.*${search.trim()}*)`;
  if (dateFrom) params['sent_at'] = `gte.${dateFrom}`;
  if (dateTo)   params['sent_at'] = params['sent_at'] ? `gte.${dateFrom},lte.${dateTo}T23:59:59` : `lte.${dateTo}T23:59:59`;
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
