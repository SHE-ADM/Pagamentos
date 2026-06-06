// src/services/supabase.js
// Acesso direto à REST API do Supabase — sem dependência do cliente oficial

const BASE_URL = import.meta.env.VITE_SUPABASE_URL
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

const headers = {
  'apikey':        ANON_KEY,
  'Authorization': `Bearer ${ANON_KEY}`,
  'Content-Type':  'application/json',
}

async function query(table, params = {}) {
  const url = new URL(`${BASE_URL}/rest/v1/${table}`)
  Object.entries(params).forEach(([k, v]) => v !== undefined && url.searchParams.set(k, v))
  const res = await fetch(url.toString(), { headers })
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`)
  return res.json()
}

// ── email_control ──────────────────────────────────────────────────────────

export async function getEmailControl({ status, sender, days, limit = 200 } = {}) {
  const params = { select: '*', order: 'received_at.desc', limit }
  if (status)  params['status']       = `eq.${status}`
  if (sender)  params['sender_email'] = `ilike.*${sender}*`
  if (days) {
    const since = new Date(Date.now() - days * 86400000).toISOString()
    params['received_at'] = `gte.${since}`
  }
  return query('email_control', params)
}

export async function getEmailStats() {
  const [all, withPdf, extracted, dupes] = await Promise.all([
    query('email_control', { select: 'id', limit: 1000 }),
    query('email_control', { select: 'id', has_attachment: 'eq.true', limit: 1000 }),
    query('email_control', { select: 'id', pdf_extracted: 'eq.true', limit: 1000 }),
    query('email_control', { select: 'id', status: 'eq.ignored', limit: 1000 }),
  ])
  return {
    total:     all.length,
    withPdf:   withPdf.length,
    extracted: extracted.length,
    semPdf:    all.length - withPdf.length,
  }
}

// ── financial_emails ───────────────────────────────────────────────────────

export async function getFinancialEmails({
  supplier, docType, status, dueStatus, dateFrom, dateTo, limit = 200
} = {}) {
  const params = { select: '*', order: 'due_date.asc', limit }
  if (supplier)  params['supplier_name'] = `ilike.*${supplier}*`
  if (docType)   params['document_type'] = `eq.${docType}`
  if (status)    params['status']        = `eq.${status}`
  if (dueStatus) params['due_status']    = `eq.${dueStatus}`
  if (dateFrom)  params['due_date']      = `gte.${dateFrom}`
  if (dateTo)    params['due_date']      = (params['due_date'] || '') + `&due_date=lte.${dateTo}`
  return query('financial_emails', params)
}

// Conta(s) extraida(s) ligada(s) a um e-mail, via gmail_message_id.
// Multiplos PDFs recebem sufixo (#1, #2), por isso o filtro usa LIKE prefixo.
export async function getAccountsByMessageId(messageId) {
  if (!messageId) return []
  return query('financial_emails', {
    select: '*',
    gmail_message_id: `like.${messageId}*`,
    order: 'due_date.asc',
  })
}

export async function getFinancialStats() {
  const [all, pending] = await Promise.all([
    query('financial_emails', { select: 'amount,status,due_date,due_status', limit: 1000 }),
    query('financial_emails', { select: 'id', status: 'eq.pending', limit: 1000 }),
  ])
  const total = all.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0)
  const today = new Date()
  const in7   = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10)
  const vencendo = all.filter(r =>
    r.status === 'pending' && r.due_date && r.due_date <= in7
  ).length
  const vencidas = all.filter(r => r.due_status === 'Vencido').length
  return { totalRecords: all.length, pending: pending.length, totalValue: total, vencendo, vencidas }
}
