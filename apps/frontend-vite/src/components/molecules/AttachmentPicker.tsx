// src/components/molecules/AttachmentPicker.tsx
// Molecule — fila de arquivos a anexar, CONTROLADA (`value`/`onChange`, como um input).
//
// Os arquivos NÃO sobem aqui: ficam em memória até o pai gravar a conta e chamar o flush.
// Na inclusão a conta ainda não tem id (o anexo precisa de um), e no modo edição subir na
// hora deixaria o arquivo órfão se o usuário cancelasse o modal — os dois modos usam o
// mesmo caminho.
//
// A validação daqui é conveniência (erro imediato, sem round-trip); quem MANDA é o
// backend, que confere o metadado real do objeto no Storage.
import { useState } from 'react';
import { ATTACHMENT_MIME_TYPES, ATTACHMENT_MAX_BYTES } from '@sheild/shared';
import FileInputButton from '../atoms/FileInputButton';
import AttachmentList, { type AttachmentListItem } from './AttachmentList';
import { fmtBytes } from '../../lib/format';

const ACCEPT = ATTACHMENT_MIME_TYPES.join(',');
const ALLOWED: readonly string[] = ATTACHMENT_MIME_TYPES;

interface AttachmentPickerProps {
  value: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
  label?: string;
}

// Chave de identidade de um File (o objeto não tem id). Nome+tamanho+data basta para
// detectar "o mesmo arquivo escolhido duas vezes".
const fileKey = (f: File): string => `${f.name}:${f.size}:${f.lastModified}`;

function validate(file: File, queue: File[]): string | null {
  if (!ALLOWED.includes(file.type)) return `"${file.name}": tipo não permitido (envie PDF ou imagem).`;
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return `"${file.name}": ${fmtBytes(file.size)} excede o limite de ${fmtBytes(ATTACHMENT_MAX_BYTES)}.`;
  }
  if (file.size === 0) return `"${file.name}": arquivo vazio.`;
  if (queue.some((q) => fileKey(q) === fileKey(file))) return `"${file.name}" já está na lista.`;
  return null;
}

export default function AttachmentPicker({
  value,
  onChange,
  disabled = false,
  label = 'Anexos',
}: Readonly<AttachmentPickerProps>) {
  const [errors, setErrors] = useState<string[]>([]);

  const handleFiles = (files: File[]) => {
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const file of files) {
      // Valida contra a fila atual + os já aceitos nesta leva (pega duplicata dentro da
      // própria seleção múltipla).
      const error = validate(file, [...value, ...accepted]);
      if (error) rejected.push(error);
      else accepted.push(file);
    }
    setErrors(rejected);
    if (accepted.length) onChange([...value, ...accepted]);
  };

  const handleRemove = (item: AttachmentListItem) => {
    onChange(value.filter((f) => fileKey(f) !== item.id));
  };

  const items: AttachmentListItem[] = value.map((f) => ({
    id: fileKey(f),
    name: f.name,
    mimeType: f.type,
    sizeBytes: f.size,
  }));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-gray-700">{label}</span>
        <FileInputButton accept={ACCEPT} onFiles={handleFiles} disabled={disabled} />
      </div>

      {value.length > 0 && <AttachmentList items={items} onRemove={handleRemove} busy={disabled} />}

      {errors.length > 0 && (
        // role="alert" para o leitor de tela anunciar a rejeição (o foco fica no botão).
        <div role="alert" className="flex flex-col gap-0.5">
          {errors.map((e) => (
            <span key={e} className="text-xs text-status-error-fg">
              {e}
            </span>
          ))}
        </div>
      )}

      {value.length === 0 && errors.length === 0 && (
        <span className="text-xs text-slate-500">PDF ou imagem, até {fmtBytes(ATTACHMENT_MAX_BYTES)} por arquivo.</span>
      )}
    </div>
  );
}
