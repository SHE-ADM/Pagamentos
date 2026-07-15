// src/services/contaAttachments.ts
// Anexos (PDF/imagem) de uma conta — Next API (metadados) + Supabase Storage (bytes).
//
// O upload tem 2 passos e os BYTES NÃO passam pela Next API:
//   1) POST /contas/:id/attachments/upload-url → chave (gerada pelo servidor) + token
//   2) supabase.storage.uploadToSignedUrl(...)  → browser → Storage, direto
//   3) POST /contas/:id/attachments             → registra a linha (confere o objeto)
// Motivo: a Vercel corta o corpo de uma function em ~4,5 MB (foto de celular passa disso),
// e assim não é preciso dar INSERT em storage.objects ao papel `authenticated`.
//
// Por que não usar o dataApiCall para os bytes: ele fixa 'Content-Type: application/json'
// (o spread de headers sobrescreve o que vier em init), então um FormData/Blob quebraria.
// Os passos 1 e 3 SÃO JSON — esses usam o dataApiCall normalmente.

import type { FinancialAccountAttachment } from '@sheild/shared';
import { supabase } from '../lib/supabaseClient';
import { dataApiCall } from './dataApi';
import { getErrorMessage } from '../lib/getErrorMessage';

const BUCKET = 'attachments';

interface UploadUrlResponse {
  storage_key: string;
  signed_url: string;
  token: string;
}

/** Resultado de um lote de uploads — nenhum arquivo derruba os outros. */
export interface UploadOutcome {
  saved: FinancialAccountAttachment[];
  failed: { file: File; message: string }[];
}

export async function listContaAttachments(accountId: number): Promise<FinancialAccountAttachment[]> {
  const body = await dataApiCall<FinancialAccountAttachment[]>(`/contas/${accountId}/attachments`);
  return body.data ?? [];
}

export async function deleteContaAttachment(accountId: number, attachmentId: number): Promise<void> {
  await dataApiCall(`/contas/${accountId}/attachments/${attachmentId}`, { method: 'DELETE' });
}

/**
 * Envia UM arquivo e registra o anexo (os 3 passos).
 * @throws Error com mensagem em pt-BR (curada pelo backend ou do Storage).
 */
export async function uploadContaAttachment(
  accountId: number,
  file: File,
): Promise<FinancialAccountAttachment> {
  const urlBody = await dataApiCall<UploadUrlResponse>(`/contas/${accountId}/attachments/upload-url`, {
    method: 'POST',
    body: JSON.stringify({ file_name: file.name, mime_type: file.type, size_bytes: file.size }),
  });
  const auth = urlBody.data;
  if (!auth) throw new Error('Não foi possível preparar o envio do arquivo');

  const { error } = await supabase.storage
    .from(BUCKET)
    .uploadToSignedUrl(auth.storage_key, auth.token, file, { contentType: file.type });
  if (error) throw new Error('Falha ao enviar o arquivo. Verifique a conexão e tente novamente.');

  const body = await dataApiCall<FinancialAccountAttachment>(`/contas/${accountId}/attachments`, {
    method: 'POST',
    body: JSON.stringify({
      storage_key: auth.storage_key,
      file_name: file.name,
      mime_type: file.type,
      size_bytes: file.size,
    }),
  });
  if (!body.data) throw new Error('Falha ao registrar o anexo');
  return body.data;
}

/**
 * Envia uma FILA de arquivos, um a um.
 *
 * SEQUENCIAL de propósito (não Promise.all): dá um progresso honesto ("2/3") e isola a
 * falha por arquivo. NÃO lança — devolve `{ saved, failed }` para a página decidir o que
 * dizer; a conta já existe neste ponto, então abortar tudo por um arquivo seria pior.
 *
 * @param onProgress recebe (concluídos, total) após cada arquivo.
 */
export async function uploadContaAttachments(
  accountId: number,
  files: File[],
  onProgress?: (done: number, total: number) => void,
): Promise<UploadOutcome> {
  const saved: FinancialAccountAttachment[] = [];
  const failed: { file: File; message: string }[] = [];

  for (const [index, file] of files.entries()) {
    try {
      saved.push(await uploadContaAttachment(accountId, file));
    } catch (e) {
      failed.push({ file, message: getErrorMessage(e) });
    }
    onProgress?.(index + 1, files.length);
  }
  return { saved, failed };
}
