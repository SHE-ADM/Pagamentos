// src/components/StatusBadge.tsx
const cfg: Record<string, string> = {
  extracted: 'bg-green-100 text-green-800',
  downloaded: 'bg-blue-100  text-blue-800',
  received: 'bg-gray-100  text-gray-700',
  error: 'bg-red-100   text-red-700',
  ignored: 'bg-yellow-100 text-yellow-800',
  pending: 'bg-amber-100  text-amber-800',
  paid: 'bg-green-100  text-green-800',
  cancelled: 'bg-gray-100   text-gray-500',
  boleto: 'bg-blue-100   text-blue-800',
  nfe: 'bg-teal-100   text-teal-800',
  nfse: 'bg-teal-100   text-teal-800',
  fatura: 'bg-purple-100 text-purple-800',
  pdf_text: 'bg-green-100  text-green-800',
  pdf_vision: 'bg-indigo-100 text-indigo-800',
  outro: 'bg-gray-100   text-gray-600',
  // Situacao de vencimento (due_status — migration 004)
  'A Vencer': 'bg-emerald-100 text-emerald-800',
  Vencido: 'bg-red-100     text-red-700',
  // Tipos de erro (email_processing_errors)
  sem_valor: 'bg-amber-100  text-amber-800',
  sem_fornecedor: 'bg-orange-100 text-orange-800',
  extracao_falhou: 'bg-red-100    text-red-700',
  db_erro: 'bg-red-100    text-red-700',
  processamento_erro: 'bg-purple-100 text-purple-800',
  pdf_protegido: 'bg-yellow-100 text-yellow-800',
};

interface StatusBadgeProps {
  value: string | null | undefined;
}

export default function StatusBadge({ value }: StatusBadgeProps) {
  const cls = (value && cfg[value]) || 'bg-gray-100 text-gray-600';
  return <span className={`badge ${cls}`}>{value ?? '—'}</span>;
}
