import { z } from 'zod';

// Schema da tabela `financial_account_attachment` (migration 079) — anexos (PDF/imagem)
// de uma conta a pagar, 1:N. PADRÃO ÚNICO das duas origens:
//   origin='pipeline' → documento que ORIGINOU a conta (espelha
//     financial_account_control.source_file, gravado pela extração de e-mail). É trilha de
//     auditoria: irremovível pela UI (a API devolve 403).
//   origin='manual'   → arquivo enviado pelo usuário no cadastro/edição de contas.
//
// Soft delete: `deleted_at` oculta a linha (a policy de SELECT já filtra para
// `authenticated`); o OBJETO permanece no bucket `attachments`.

// ── Domínios ────────────────────────────────────────────────────────────────

// Espelha _UPLOAD_CONTENT_TYPES do pipeline (read_emails.py) — os mesmos tipos que a
// extração aceita como anexo. Ao acrescentar um tipo aqui, acrescentar lá também.
export const ATTACHMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  // .docx (Word) — o pipeline passou a aceitar boleto anexado como documento do Word.
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

// Extensão canônica por mime — a chave do objeto usa a extensão do MIME VALIDADO, nunca a
// do nome enviado pelo cliente (que pode mentir).
export const ATTACHMENT_MIME_TO_EXT: Record<(typeof ATTACHMENT_MIME_TYPES)[number], string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

export const ATTACHMENT_ORIGINS = ['manual', 'pipeline'] as const;

// Teto por arquivo. Referência: o maior objeto real no bucket tem ~1,6 MB e a média é
// ~182 KB — 10 MB cobre foto de celular e PDF escaneado com folga.
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export const attachmentMimeTypeSchema = z.enum(ATTACHMENT_MIME_TYPES);
export const attachmentOriginSchema = z.enum(ATTACHMENT_ORIGINS);

// ── Linha (leitura) ─────────────────────────────────────────────────────────

export const financialAccountAttachmentSchema = z.object({
  id: z.number().int(),
  account_id: z.number().int(),
  // Chave CRUA do objeto no bucket — passada direto ao createSignedUrl pelo AttachmentViewer.
  // Pipeline: nome flat. Manual: `manual/{account_id}/{ts}_{rand8}_{nome}.ext`.
  storage_key: z.string(),
  file_name: z.string(), // nome ORIGINAL do arquivo, só para exibição
  mime_type: z.string(),
  size_bytes: z.coerce.number().int(),
  origin: attachmentOriginSchema,
  uploaded_by: z.string().nullable(),
  created_at: z.string(),
});

// Embed em financial_account_control (alias `attachments`). A policy de SELECT já exclui o
// soft-deletado para `authenticated`; no service_role (que ignora RLS) o filtro é explícito
// no repository.
export const financialAccountAttachmentEmbeddedSchema = financialAccountAttachmentSchema;

// ── Entrada — passo 1: pedir a URL assinada de upload ───────────────────────
// O cliente declara nome/mime/tamanho; a API valida e devolve a chave que ELA gerou.
// Os valores declarados são só um pré-filtro: o que vale para gravar é o metadado real do
// objeto (lido via storage.info() no register) — a signed URL não valida conteúdo.

export const attachmentUploadRequestSchema = z.object({
  // `.trim()` ANTES do `.min(1)`: sem ele, um nome só de espaços passaria aqui e só morreria
  // no CHECK `btrim(file_name) <> ''` do banco — devolvendo erro de constraint em vez de
  // validação (e o detalhe cru do Postgres vazaria ao cliente pelo status 422).
  file_name: z.string().trim().min(1, 'Informe o nome do arquivo').max(200, 'Nome de arquivo muito longo'),
  mime_type: attachmentMimeTypeSchema,
  size_bytes: z.coerce
    .number()
    .int()
    .positive('Arquivo vazio')
    .max(ATTACHMENT_MAX_BYTES, 'Arquivo maior que o limite de 10 MB'),
});

// ── Entrada — passo 2: registrar o anexo após o browser subir os bytes ──────
// `storage_key` DEVE ser a chave devolvida no passo 1 (a API confere o prefixo
// `manual/{account_id}/` e a existência do objeto antes de gravar).

export const attachmentRegisterSchema = attachmentUploadRequestSchema.extend({
  storage_key: z.string().min(1, 'Chave do objeto ausente'),
});

export type FinancialAccountAttachment = z.infer<typeof financialAccountAttachmentSchema>;
export type AttachmentUploadRequest = z.infer<typeof attachmentUploadRequestSchema>;
export type AttachmentRegister = z.infer<typeof attachmentRegisterSchema>;
export type AttachmentMimeType = (typeof ATTACHMENT_MIME_TYPES)[number];
export type AttachmentOrigin = (typeof ATTACHMENT_ORIGINS)[number];
