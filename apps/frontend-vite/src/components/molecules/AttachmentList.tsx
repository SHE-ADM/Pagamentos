// src/components/molecules/AttachmentList.tsx
// Molecule — lista de anexos, APRESENTACIONAL PURA (sem fetch, sem estado).
// Serve tanto para os anexos JÁ SALVOS (organisms/ContaAttachments) quanto para os
// PENDENTES ainda na fila do formulário (molecules/AttachmentPicker); por isso o item é
// uma forma genérica, não o tipo do banco.
import { FileText, Image as ImageIcon, Eye, Trash2, Mail } from 'lucide-react';
import { fmtBytes } from '../../lib/format';

export interface AttachmentListItem {
  /** Identidade estável para a `key` e para os callbacks. */
  id: string | number;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Anexo vindo do e-mail: exibe o selo de origem e nunca é removível. */
  fromEmail?: boolean;
}

interface AttachmentListProps {
  items: AttachmentListItem[];
  /** Ausente = não há o que visualizar ainda (fila de pendentes). */
  onView?: (item: AttachmentListItem) => void;
  /** Ausente = sem lixeira (ex.: sem permissão, ou anexo de e-mail). */
  onRemove?: (item: AttachmentListItem) => void;
  /** Desabilita as ações durante um envio/remoção em curso. */
  busy?: boolean;
  emptyText?: string;
}

export default function AttachmentList({
  items,
  onView,
  onRemove,
  busy = false,
  emptyText = 'Nenhum anexo.',
}: Readonly<AttachmentListProps>) {
  if (!items.length) {
    return <p className="text-sm text-slate-500">{emptyText}</p>;
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((item) => {
        const Icon = item.mimeType.startsWith('image/') ? ImageIcon : FileText;
        // Anexo de e-mail é o documento que ORIGINOU a conta (trilha de auditoria):
        // some a lixeira mesmo que o pai passe onRemove. O backend também recusa (403).
        const canRemove = !!onRemove && !item.fromEmail;
        return (
          <li
            key={item.id}
            className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2"
          >
            <Icon size={16} aria-hidden="true" className="shrink-0 text-slate-500" />
            <span className="min-w-0 flex-1 truncate text-sm text-slate-700" title={item.name}>
              {item.name}
            </span>
            {item.fromEmail && (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-status-info-bg px-2 py-0.5 text-xs text-status-info-fg"
                title="Anexo recebido por e-mail — não pode ser removido"
              >
                <Mail size={11} aria-hidden="true" /> e-mail
              </span>
            )}
            <span className="shrink-0 text-xs text-slate-500">{fmtBytes(item.sizeBytes)}</span>
            {onView && (
              <button
                type="button"
                onClick={() => onView(item)}
                className="btn shrink-0"
                aria-label={`Ver ${item.name}`}
                title="Ver o anexo"
              >
                <Eye size={14} aria-hidden="true" />
              </button>
            )}
            {canRemove && (
              <button
                type="button"
                onClick={() => onRemove(item)}
                disabled={busy}
                className="btn shrink-0 text-status-error-fg disabled:opacity-50"
                aria-label={`Remover ${item.name}`}
                title="Remover o anexo"
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
