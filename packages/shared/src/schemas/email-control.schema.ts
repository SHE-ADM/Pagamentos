import { z } from 'zod';

// Schema da tabela `email_control` — controle/deduplicação de e-mails lidos
// via IMAP. Reflete a migration 002.

export const EMAIL_CONTROL_STATUSES = [
  'received', // e-mail lido, sem PDF
  'downloaded', // PDF salvo em pdfs_inbox
  'extracted', // extract_pdf.py executado com sucesso
  'error', // falha em alguma etapa
  'ignored', // filtrado mas descartado manualmente
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
  status: emailControlStatusSchema.default('received'),

  // Auditoria
  notes: z.string().nullable(),
  processed_at: z.string(),
  updated_at: z.string(),
});

export type EmailControl = z.infer<typeof emailControlSchema>;
export type EmailControlStatus = (typeof EMAIL_CONTROL_STATUSES)[number];
