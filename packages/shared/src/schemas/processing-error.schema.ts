import { z } from 'zod';

// Schema da tabela `email_processing_errors` — log de falhas de
// processamento. Reflete a migration 012.

export const PROCESSING_ERROR_TYPES = [
  'erro_api', // API Anthropic indisponível (crédito/auth/limite) — falha crítica
  'sem_valor', // amount ausente ou zero no documento extraído
  'sem_fornecedor', // cnpj, cpf e nome do fornecedor ausentes
  'extracao_falhou', // extract_pdf.py não gerou CSV para o PDF
  'db_erro', // falha ao gravar em financial_account_control (HTTP error)
  'processamento_erro', // exceção inesperada no processamento do e-mail
] as const;

// O banco usa TEXT livre em error_type; mantemos os valores conhecidos como
// referência, mas o schema aceita qualquer string para não rejeitar novos
// tipos introduzidos no pipeline.
export const processingErrorTypeSchema = z.string();

export const processingErrorSchema = z.object({
  id: z.number().int(),
  logged_at: z.string(),
  gmail_message_id: z.string().nullable(),
  sender_name: z.string().nullable(),
  sender_email: z.string().nullable(),
  subject: z.string().nullable(),
  received_at: z.string().nullable(),
  source_file: z.string().nullable(),
  error_type: processingErrorTypeSchema,
  error_message: z.string().nullable(),
  raw_payload: z.unknown().nullable(),
});

export type ProcessingError = z.infer<typeof processingErrorSchema>;
export type ProcessingErrorType = (typeof PROCESSING_ERROR_TYPES)[number];
