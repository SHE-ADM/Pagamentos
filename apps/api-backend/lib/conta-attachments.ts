// lib/conta-attachments.ts
// Anexos (PDF/imagem) de uma conta a pagar — tabela financial_account_attachment
// (migration 079) + bucket `attachments` do Storage. Repository → Service → Route
// (espelha lib/contas.ts). As rotas mapeiam ContaAttachmentServiceError → status HTTP.
//
// FLUXO DE UPLOAD (2 passos) — os bytes NÃO passam por esta API:
//   1) createUploadUrl: valida e devolve uma URL assinada + a chave que ELA gerou.
//   2) o BROWSER envia os bytes direto ao Storage (uploadToSignedUrl).
//   3) register: confere que o objeto existe e grava a linha com o metadado REAL.
// Motivo: a Vercel limita o corpo de uma function a ~4,5 MB — foto de celular passaria
// disso. E assim não é preciso abrir policy de INSERT em storage.objects: quem escreve
// continua sendo só o service_role (via a URL assinada que ele emite).
//
// Regras refletidas:
// - origin='pipeline' (documento que originou a conta) é trilha de auditoria → 403 ao remover.
// - Remoção é SOFT DELETE: marca deleted_at/deleted_by; o objeto FICA no bucket.
// - Remover anexo manual: só o AUTOR ou o grupo Administrador (migration 065).

import {
  attachmentRegisterSchema,
  attachmentUploadRequestSchema,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MIME_TO_EXT,
  ATTACHMENT_MIME_TYPES,
  type AttachmentMimeType,
  type FinancialAccountAttachment,
} from '@sheild/shared';
import { randomUUID } from 'node:crypto';
import type { ZodError } from 'zod';
import { isInAdminGroup } from './auth';
import { contaService } from './contas';
import { getSupabaseAdmin } from './supabase-admin';
import { ApiServiceError } from './api-error';

const TABLE = 'financial_account_attachment';
export const ATTACHMENT_BUCKET = 'attachments';

// Colunas devolvidas ao cliente. `deleted_at`/`deleted_by` ficam FORA: a lista nunca
// expõe o removido (o filtro é explícito no repository — o service_role ignora a RLS).
const SELECT_COLUMNS = 'id,account_id,storage_key,file_name,mime_type,size_bytes,origin,uploaded_by,created_at';

// Sufixo aleatório da chave: sem ele, dois arquivos de mesmo nome, mesma conta e mesmo
// segundo colidiriam (o pipeline resolve isso pelo disco local, que aqui não existe).
const RAND_LEN = 8;

export class ContaAttachmentServiceError extends ApiServiceError {
  constructor(message: string, status: number) {
    super(message, status, 'ContaAttachmentServiceError');
  }
}

function formatZodError(error: ZodError): string {
  return error.issues.map((i) => i.message).join('; ');
}

/**
 * Mapeia erro de escrita para status/mensagem CURADOS (espelha `mapWriteError` de contas.ts).
 *
 * O default é **500**, não 422: `failFromError` ECOA a mensagem de qualquer status < 500, então
 * um erro inesperado do Postgres em 422 vazaria nome de tabela/constraint ao cliente — o que a
 * regra §3 M-2 proíbe. Com 500 a mensagem vira genérica e o detalhe vai só para o log.
 */
function mapWriteError(error: { code?: string; message: string; details?: string }): ContaAttachmentServiceError {
  if (error.code === '23505') return new ContaAttachmentServiceError('Anexo já registrado', 409);
  // FK: a conta sumiu entre o getById e o insert (corrida com o cancelamento/limpeza).
  if (error.code === '23503') return new ContaAttachmentServiceError('Conta não encontrada', 404);
  return new ContaAttachmentServiceError(error.message, 500);
}

/**
 * Sanitiza um nome para uso em chave de objeto do Storage.
 *
 * ESPELHA `safe_filename` do pipeline (skills/email-reader/scripts/read_emails.py) — mesma
 * regra dos dois lados: derruba não-ASCII (acentos viram a letra base via NFKD) e mantém só
 * [A-Za-z0-9_], espaço e hífen, com espaços virando `_`. O Storage rejeita chave com
 * caractere fora disso (InvalidKey).
 *
 * Efeito colateral desejado: como o PONTO e a BARRA são removidos, `..` e `/` não
 * sobrevivem — não há path traversal a partir do nome enviado pelo cliente.
 */
export function safeFileName(text: string, maxLen = 40): string {
  const ascii = (text || '')
    .normalize('NFKD')
    // NFKD só SEPARA o acento; quem o derruba é este strip (equivale ao
    // .encode('ascii','ignore') do Python). Sem ele, "ç" sobreviveria ao passo seguinte.
    .replace(/[^\x20-\x7E]/g, '');
  const cleaned = ascii
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '_');
  return cleaned.slice(0, maxLen);
}

/**
 * Monta a chave do objeto para upload MANUAL:
 *   `manual/{accountId}/{YYYYMMDDTHHMMSSZ}_{rand8}_{nome}.{ext}`
 *
 * O prefixo `manual/` torna a colisão com o pipeline IMPOSSÍVEL por construção: o
 * safe_filename do pipeline remove a barra, então nenhuma chave dele contém `/`.
 * A extensão vem do MIME já validado — nunca do nome enviado pelo cliente, que pode mentir.
 * Gerada sempre no SERVIDOR: se o cliente escolhesse a chave, pediria autorização para o
 * objeto de outra conta (ou do pipeline) e o sobrescreveria.
 */
export function buildStorageKey(accountId: number, fileName: string, mimeType: AttachmentMimeType): string {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const rand = randomUUID().replace(/-/g, '').slice(0, RAND_LEN);
  // Só o miolo do nome: a extensão do cliente é descartada (a canônica vem do mime).
  const stem = safeFileName(fileName.replace(/\.[^./\\]+$/, ''), 40) || 'anexo';
  return `manual/${accountId}/${ts}_${rand}_${stem}${ATTACHMENT_MIME_TO_EXT[mimeType]}`;
}

/**
 * A chave é do formato EXATO que `buildStorageKey` gera para ESTA conta?
 *
 * Valida o formato INTEIRO — não só o prefixo `manual/{id}/`. O prefixo sozinho é
 * INSEGURO: `manual/7/../8/boleto.pdf` começa com `manual/7/` e o Supabase Storage
 * **NORMALIZA o `..`** (verificado contra o bucket real: `info()` resolve, `createSignedUrl`
 * assina e o download devolve os bytes). Com só o prefixo, um usuário registraria na conta
 * dele o objeto de OUTRA conta e o veria pela UI — furando a visibilidade por dono (076).
 *
 * A regex sai das mesmas constantes de `buildStorageKey`, para as duas não divergirem:
 * `manual/{id}/{YYYYMMDDTHHMMSSZ}_{rand8}_{stem}.{ext}` — o `stem` vem de `safeFileName`
 * (só `[A-Za-z0-9_-]`, pois ponto e barra são removidos) e a `ext` do mime validado.
 */
function isOwnManualKey(accountId: number, key: string): boolean {
  const exts = Object.values(ATTACHMENT_MIME_TO_EXT)
    .map((e) => e.slice(1)) // '.pdf' → 'pdf'
    .join('|');
  const pattern = new RegExp(`^manual/${accountId}/\\d{8}T\\d{6}Z_[0-9a-f]{${RAND_LEN}}_[\\w-]+\\.(?:${exts})$`);
  return pattern.test(key);
}

function isAllowedMime(mime: string | undefined): mime is AttachmentMimeType {
  return !!mime && (ATTACHMENT_MIME_TYPES as readonly string[]).includes(mime);
}

const attachmentRepository = {
  // Filtro de deleted_at EXPLÍCITO: este client usa service_role, que IGNORA a RLS —
  // a policy que esconde o soft-deletado não vale aqui. Sem isto, um anexo removido
  // voltaria na lista (e no retorno do PATCH da conta, que o grid mescla in-place).
  findByAccount(accountId: number) {
    return getSupabaseAdmin()
      .from(TABLE)
      .select(SELECT_COLUMNS)
      .eq('account_id', accountId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true });
  },

  // Traz origin/uploaded_by/deleted_at — necessários para decidir a remoção (403/404).
  findById(id: number) {
    return getSupabaseAdmin()
      .from(TABLE)
      .select('id,account_id,origin,uploaded_by,deleted_at')
      .eq('id', id)
      .maybeSingle();
  },

  insert(payload: {
    account_id: number;
    storage_key: string;
    file_name: string;
    mime_type: string;
    size_bytes: number;
    uploaded_by?: string;
  }) {
    return getSupabaseAdmin().from(TABLE).insert(payload).select(SELECT_COLUMNS).single();
  },

  // Soft delete — NUNCA remove o objeto do bucket (política de preservação + policy 073).
  softDelete(id: number, userId: string) {
    return getSupabaseAdmin()
      .from(TABLE)
      .update({ deleted_at: new Date().toISOString(), deleted_by: userId })
      .eq('id', id)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle();
  },
};

export const contaAttachmentService = {
  /**
   * Lista os anexos ativos de uma conta (ordem de criação).
   * @throws {ContaAttachmentServiceError} 404 (conta inexistente) ou 500 (falha do banco).
   */
  async list(accountId: number): Promise<FinancialAccountAttachment[]> {
    await contaService.getById(accountId); // 404 se a conta não existe
    const { data, error } = await attachmentRepository.findByAccount(accountId);
    if (error) throw new ContaAttachmentServiceError(error.message, 500);
    return (data ?? []) as unknown as FinancialAccountAttachment[];
  },

  /**
   * Passo 1 — autoriza o upload: valida o arquivo declarado e devolve a URL assinada
   * junto da chave gerada pelo servidor.
   * @returns `{ storage_key, signed_url, token }` — o cliente sobe os bytes com o token.
   * @throws {ContaAttachmentServiceError} 404 (conta), 422 (tipo/tamanho) ou 500 (Storage).
   */
  async createUploadUrl(
    accountId: number,
    raw: unknown,
  ): Promise<{ storage_key: string; signed_url: string; token: string }> {
    await contaService.getById(accountId);

    const parsed = attachmentUploadRequestSchema.safeParse(raw);
    if (!parsed.success) throw new ContaAttachmentServiceError(formatZodError(parsed.error), 422);

    const key = buildStorageKey(accountId, parsed.data.file_name, parsed.data.mime_type);
    // upsert ausente (= false): a URL não pode sobrescrever um objeto existente.
    const { data, error } = await getSupabaseAdmin().storage.from(ATTACHMENT_BUCKET).createSignedUploadUrl(key);
    if (error || !data) {
      throw new ContaAttachmentServiceError('Não foi possível preparar o envio do arquivo', 500);
    }
    return { storage_key: key, signed_url: data.signedUrl, token: data.token };
  },

  /**
   * Passo 3 — registra o anexo depois que o browser subiu os bytes.
   *
   * Os guards são a segurança do fluxo: a URL assinada não valida conteúdo, e o cliente
   * poderia declarar "pdf de 1 KB" e subir outra coisa. Por isso o tamanho/mime gravados
   * são os REAIS (lidos do objeto), e a chave precisa ser desta conta.
   *
   * @throws {ContaAttachmentServiceError} 404 (conta), 422 (chave alheia / objeto
   *   inexistente / conteúdo fora do permitido), 409 (já registrado) ou 500.
   */
  async register(accountId: number, raw: unknown, userId?: string): Promise<FinancialAccountAttachment> {
    await contaService.getById(accountId);

    const parsed = attachmentRegisterSchema.safeParse(raw);
    if (!parsed.success) throw new ContaAttachmentServiceError(formatZodError(parsed.error), 422);
    const { storage_key: key, file_name } = parsed.data;

    // (1) A chave TEM de ser uma que ESTA API gerou para ESTA conta — formato inteiro, não
    // só o prefixo (ver isOwnManualKey: o Storage normaliza `..`, e um guard de prefixo
    // deixaria o cliente registrar o objeto do pipeline ou de outra conta sem subir nada).
    if (!isOwnManualKey(accountId, key)) {
      throw new ContaAttachmentServiceError('Chave de anexo inválida para esta conta', 422);
    }

    const store = getSupabaseAdmin().storage.from(ATTACHMENT_BUCKET);

    // (2) O objeto precisa existir — senão gravaríamos uma linha fantasma.
    const { data: info, error: infoError } = await store.info(key);
    if (infoError || !info) {
      throw new ContaAttachmentServiceError('Arquivo não encontrado no Storage. Envie novamente.', 422);
    }

    // (3) Metadado REAL manda. Fora do permitido → recusa E limpa o objeto: ele ainda não
    // está vinculado a conta nenhuma, então removê-lo não fere a preservação (que protege
    // anexo DE CONTA); deixá-lo seria lixo permanente no bucket.
    const realSize = info.size ?? 0;
    const realMime = info.contentType;
    if (realSize > ATTACHMENT_MAX_BYTES || !isAllowedMime(realMime)) {
      await store.remove([key]).catch(() => undefined);
      throw new ContaAttachmentServiceError(
        realSize > ATTACHMENT_MAX_BYTES ? 'Arquivo maior que o limite de 10 MB' : 'Tipo de arquivo não permitido',
        422,
      );
    }

    const { data, error } = await attachmentRepository.insert({
      account_id: accountId,
      storage_key: key,
      file_name,
      mime_type: realMime,
      size_bytes: realSize,
      ...(userId ? { uploaded_by: userId } : {}),
    });
    if (error) throw mapWriteError(error);
    return data as unknown as FinancialAccountAttachment;
  },

  /**
   * Remove um anexo MANUAL (soft delete — o objeto permanece no bucket).
   *
   * Anexo `pipeline` é o documento que originou a conta (trilha de auditoria) e nunca é
   * removível. Anexo manual: só o autor ou o grupo Administrador.
   *
   * @throws {ContaAttachmentServiceError} 404 (inexistente/de outra conta), 403 (pipeline
   *   ou de outro usuário) ou 500.
   */
  async remove(accountId: number, attachmentId: number, userId: string): Promise<void> {
    const { data, error } = await attachmentRepository.findById(attachmentId);
    if (error) throw new ContaAttachmentServiceError(error.message, 500);

    const row = data as { account_id: number; origin: string; uploaded_by: string | null; deleted_at: string | null } | null;
    // Anexo de outra conta é 404 (não 403): não revela a existência de anexo alheio.
    if (!row || row.account_id !== accountId || row.deleted_at) {
      throw new ContaAttachmentServiceError('Anexo não encontrado', 404);
    }
    if (row.origin === 'pipeline') {
      throw new ContaAttachmentServiceError('O anexo recebido por e-mail não pode ser removido', 403);
    }
    if (row.uploaded_by !== userId && !(await isInAdminGroup(userId))) {
      throw new ContaAttachmentServiceError('Só quem enviou o anexo pode removê-lo', 403);
    }

    const { data: deleted, error: delError } = await attachmentRepository.softDelete(attachmentId, userId);
    if (delError) throw new ContaAttachmentServiceError(delError.message, 500);
    // Corrida: alguém removeu entre o SELECT e o UPDATE.
    if (!deleted) throw new ContaAttachmentServiceError('Anexo não encontrado', 404);
  },
};
