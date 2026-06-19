// types/cobranca.ts
export interface CobrancaEnvioLog {
  id: number;
  document_id: string;
  customer_name: string;
  primary_email: string;
  cc_email: string | null;
  due_date: string;
  bill_amount: number;
  email_subject: string;
  sent_at: string;
  created_at: string;
}
export interface CobrancaErroLog {
  id: number;
  document_id: string | null;
  customer_name: string | null;
  primary_email: string | null;
  cc_email: string | null;
  due_date: string | null;
  bill_amount: number | null;
  email_subject: string | null;
  error_type: ErrorType;
  error_message: string;
  error_detail: string | null;
  occurred_at: string;
  created_at: string;
}
export type ErrorType =
  | 'email_ausente' | 'email_invalido'
  | 'smtp_falha' | 'smtp_bloqueio' | 'supabase_falha'
  | 'firebird_falha' | 'erro_inesperado';
export const ERROR_TYPE_LABEL: Record<ErrorType, string> = {
  email_ausente: 'Cliente sem e-mail',
  email_invalido: 'E-mail inválido',
  smtp_falha: 'Instabilidade no envio',
  smtp_bloqueio: 'Envio bloqueado',
  supabase_falha: 'Falha ao registrar',
  firebird_falha: 'Falha no sistema financeiro',
  erro_inesperado: 'Erro inesperado',
};
export interface PaginatedResult<T> { data: T[]; total: number; }
