// src/pages/Consulta.jsx
import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, Download, AlertCircle, TrendingUp, Clock, DollarSign, FileText } from 'lucide-react'
import { getFinancialEmails, getFinancialStats } from '../services/supabase'
import StatusBadge from '../components/StatusBadge'

const fmtDate  = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('pt-BR') : '—'
const fmtMoney = v => v != null ? Number(v).toLocaleString('pt-BR', { style:'currency', currency:'BRL' }) : '—'
const fmtCnpj  = c => c?.length === 14
  ? `${c.slice(0,2)}.${c.slice(2,5)}.${c.slice(5,8)}/${c.slice(8,12)}-${c.slice(12)}`
  : (c || '—')

const PAGE_SIZE = 20

function exportCsv(rows) {
  const cols = ['due_date','due_status','supplier_name','supplier_cnpj','document_type','amount',
                'amount_charged','discount','other_deductions','fine_interest','other_additions',
                'payment_method','nosso_numero','extraction_source','status','invoice_number',
                'barcode','description','processing_notes']
  const header = cols.join(';')
  const body   = rows.map(r => cols.map(c => `"${(r[c]??'').toString().replace(/"/g,'""')}"`).join(';'))
  const blob = new Blob(['﻿' + [header, ...body].join('\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
  a.download = `financial_emails_${new Date().toISOString().slice(0,10)}.csv`
  a.click()
}

export default function Consulta() {
  const [rows,    setRows]    = useState([])
  const [stats,   setStats]   = useState({})
  const [sel,     setSel]     = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)
  const [f, setF_]      = useState({ supplier:'', docType:'', status:'', dueStatus:'', dateFrom:'', dateTo:'' })
  const [applied, setApplied] = useState({ supplier:'', docType:'', status:'', dueStatus:'', dateFrom:'', dateTo:'' })
  const [page,  setPage]  = useState(1)
  const [total, setTotal] = useState(0)
  const sf = (k, v) => setF_(x => ({ ...x, [k]: v }))

  // load depends on applied (snapshot do filtro no momento do Buscar) e page.
  // useEffect dispara automaticamente quando qualquer dos dois muda.
  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [result, st] = await Promise.all([
        getFinancialEmails({ ...applied, page, pageSize: PAGE_SIZE }),
        getFinancialStats()
      ])
      setRows(result.data); setTotal(result.total); setStats(st)
    } catch(e) { setError(e.message) }
    finally { setLoading(false) }
  }, [applied, page])

  useEffect(() => { load() }, [load])

  // Buscar: congela filtro atual em applied e volta para pagina 1.
  // React 18 faz batch dos dois setState — gera um unico load novo.
  const handleSearch = () => { setApplied({ ...f }); setPage(1) }
  const goPage = (n) => setPage(n)
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-gray-200 bg-white flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-gray-900">Consulta de movimentações</h1>
          <p className="text-xs text-gray-500 mt-0.5">Registros extraídos — tabela financial_emails</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => exportCsv(rows)} className="btn" disabled={!rows.length}>
            <Download size={14} /> Exportar página ({rows.length})
          </button>
          <button onClick={load} className="btn" disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Carregando…' : 'Atualizar'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex gap-2">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            <span><strong>Erro:</strong> {error}</span>
          </div>
        )}

        <div className="grid grid-cols-5 gap-3 mb-5">
          {[
            { icon: FileText,    label:'Total de registros',  value: stats.totalRecords ?? 0, fmt: v => v },
            { icon: Clock,       label:'Pendentes',           value: stats.pending      ?? 0, fmt: v => v },
            { icon: DollarSign,  label:'Valor total',         value: stats.totalValue   ?? 0, fmt: fmtMoney },
            { icon: TrendingUp,  label:'A vencer em 7 dias',  value: stats.vencendo     ?? 0, fmt: v => v },
            { icon: AlertCircle, label:'Vencidas',            value: stats.vencidas     ?? 0, fmt: v => v },
          ].map(({ icon: Icon, label, value, fmt }) => (
            <div key={label} className="metric-card">
              <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-1">
                <Icon size={13} />{label}
              </div>
              <div className="text-xl font-semibold text-gray-900">{fmt(value)}</div>
            </div>
          ))}
        </div>

        <div className="flex gap-2 mb-4 flex-wrap">
          <input className="input w-44" placeholder="Fornecedor ou CNPJ…"
            value={f.supplier} onChange={e => sf('supplier', e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()} />
          <select className="input w-32" value={f.docType} onChange={e => sf('docType', e.target.value)}>
            <option value="">Tipo</option>
            {['boleto','nfe','nfse','fatura','recibo','outro'].map(t => <option key={t}>{t}</option>)}
          </select>
          <select className="input w-32" value={f.status} onChange={e => sf('status', e.target.value)}>
            <option value="">Status</option>
            {['pending','paid','cancelled','error'].map(s => <option key={s}>{s}</option>)}
          </select>
          <select className="input w-32" value={f.dueStatus} onChange={e => sf('dueStatus', e.target.value)}>
            <option value="">Situação</option>
            {['A Vencer','Vencido'].map(s => <option key={s}>{s}</option>)}
          </select>
          <input type="date" className="input w-36" value={f.dateFrom}
            onChange={e => sf('dateFrom', e.target.value)} title="Vencimento de" />
          <input type="date" className="input w-36" value={f.dateTo}
            onChange={e => sf('dateTo', e.target.value)} title="Vencimento até" />
          <button onClick={handleSearch} className="btn btn-primary">Buscar</button>
        </div>

        <div className="card overflow-hidden mb-2">
          <table className="w-full">
            <thead>
              <tr>
                {['Vencimento','Situação','Fornecedor','CNPJ','Tipo','Valor','Pagamento','Extração','Status'].map(h =>
                  <th key={h} className="table-header">{h}</th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={9} className="table-cell text-center text-gray-400 py-8">
                  {loading ? 'Buscando registros…' : 'Nenhum registro encontrado — ajuste os filtros e clique em Buscar'}
                </td></tr>
              ) : rows.map(r => (
                <tr key={r.id}
                  className={`cursor-pointer hover:bg-gray-50 ${sel?.id === r.id ? 'bg-brand-light/40' : ''}`}
                  onClick={() => setSel(sel?.id === r.id ? null : r)}>
                  <td className="table-cell text-xs whitespace-nowrap font-mono">{fmtDate(r.due_date)}</td>
                  <td className="table-cell"><StatusBadge value={r.due_status} /></td>
                  <td className="table-cell text-xs max-w-[150px] truncate" title={r.supplier_name}>{r.supplier_name || '—'}</td>
                  <td className="table-cell text-xs font-mono text-gray-500">{fmtCnpj(r.supplier_cnpj)}</td>
                  <td className="table-cell"><StatusBadge value={r.document_type} /></td>
                  <td className="table-cell text-xs font-mono font-medium">{fmtMoney(r.amount)}</td>
                  <td className="table-cell"><StatusBadge value={r.payment_method} /></td>
                  <td className="table-cell"><StatusBadge value={r.extraction_source} /></td>
                  <td className="table-cell"><StatusBadge value={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between py-2 px-1 mb-4">
          <span className="text-xs text-gray-500">
            {total} registros · Página {page} de {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => goPage(page - 1)}
              disabled={page <= 1 || loading}
              className="btn"
            >
              ← Anterior
            </button>
            <button
              onClick={() => goPage(page + 1)}
              disabled={page >= totalPages || loading}
              className="btn"
            >
              Próxima →
            </button>
          </div>
        </div>

        {sel && (
          <div className="card p-4">
            <p className="text-xs font-semibold text-gray-500 mb-3 uppercase tracking-wide">
              Detalhes — {sel.supplier_name || 'registro'} · {fmtDate(sel.due_date)}
            </p>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-2">
              {[
                ['Fornecedor',     sel.supplier_name],
                ['CNPJ',          fmtCnpj(sel.supplier_cnpj)],
                ['N° Documento',  sel.invoice_number],
                ['Competência',   sel.competence_date],
                ['Emissão',       fmtDate(sel.issue_date)],
                ['Vencimento',    fmtDate(sel.due_date)],
                ['Situação',      sel.due_status],
                ['Valor do documento', fmtMoney(sel.amount)],
                ['Valor cobrado', fmtMoney(sel.amount_charged)],
                ['Desconto / abatimentos', fmtMoney(sel.discount)],
                ['Outras deduções', fmtMoney(sel.other_deductions)],
                ['Mora / multa',  fmtMoney(sel.fine_interest)],
                ['Outros acréscimos', fmtMoney(sel.other_additions)],
                ['Nosso número',  sel.nosso_numero || '—'],
                ['Forma de pag.', sel.payment_method],
                ['Código de barras', sel.barcode || '—'],
                ['Extração',      sel.extraction_source],
                ['Origem',        sel.source_file],
                ['Observações',   sel.processing_notes || '—'],
              ].map(([k,v]) => (
                <div key={k} className="flex gap-3">
                  <dt className="w-36 flex-shrink-0 text-gray-400 text-xs">{k}</dt>
                  <dd className="text-gray-700 text-xs break-all">{v ?? '—'}</dd>
                </div>
              ))}
            </dl>
            {sel.description && (
              <div className="mt-3 p-3 bg-gray-50 rounded-lg">
                <p className="text-[10px] text-gray-400 mb-1 uppercase tracking-wide">Descrição</p>
                <p className="text-xs text-gray-600">{sel.description}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
