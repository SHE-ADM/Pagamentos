import { z } from 'zod';

// Schema da tabela `email_control` — controle/deduplicação de e-mails lidos
// via IMAP. Reflete as migrations 002, 019 e 022 (taxonomia de status pt-BR).

export const EMAIL_CONTROL_STATUSES = [
  'extraído', // PDF extraído (CSV gerado) — conta de PDF ou erro logado à parte
  'recebido', // sem PDF, conta criada via corpo do e-mail
  'pendente', // PDF salvo mas extração não gerou CSV (substitui 'baixado')
  'falha', // casou keyword mas sem PDF e sem conta no corpo
  'ignorado', // não-financeiro (assunto sem keyword)
] as const;

export const emailControlStatusSchema = z.enum(EMAIL_CONTROL_STATUSES);

export const emailControlSchema = z.object({
  id: z.number().int(),

  // Identificação única
  message_id: z.string(),
  imap_uid: z.string().nullable(),

  // Metadados do e-mail
  received_at: z.string().nullable(),
  sender_name: z.string().nullable(),
  sender_email: z.string().nullable(),
  subject: z.string().nullable(),
  body_preview: z.string().nullable(),
  keyword_matched: z.string().nullable(),

  // Anexos
  has_attachment: z.boolean().default(false),
  attachment_names: z.string().nullable(),
  attachment_saved: z.boolean().default(false),

  // Extração
  pdf_extracted: z.boolean().default(false),
  extraction_csv: z.string().nullable(),

  // Status
  status: emailControlStatusSchema.default('pendente'),

  // Auditoria
  notes: z.string().nullable(),
  processed_at: z.string(),
  updated_at: z.string(),
});

export type EmailControl = z.infer<typeof emailControlSchema>;
export type EmailControlStatus = (typeof EMAIL_CONTROL_STATUSES)[number];
