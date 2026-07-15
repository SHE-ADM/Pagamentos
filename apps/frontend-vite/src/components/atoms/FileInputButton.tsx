// src/components/atoms/FileInputButton.tsx
// Atom — botão que abre o seletor de arquivos.
//
// É um <input type="file"> REAL escondido dentro de um <label> (não um <div onClick> que
// dispara .click()): assim foco por teclado, Enter/Espaço, nome acessível e o anúncio do
// leitor de tela vêm de graça do navegador. O `sr-only` esconde o input visualmente sem
// tirá-lo da árvore de acessibilidade (`hidden`/`display:none` o removeriam do foco).
import { useId } from 'react';
import { Paperclip } from 'lucide-react';
import { cn } from '../../lib/cn';

interface FileInputButtonProps {
  /** MIME types aceitos (atributo accept) — filtro do diálogo, não validação. */
  accept: string;
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}

export default function FileInputButton({
  accept,
  onFiles,
  disabled = false,
  label = 'Anexar arquivos',
  className,
}: Readonly<FileInputButtonProps>) {
  const id = useId();

  return (
    <label
      htmlFor={id}
      className={cn(
        'btn inline-flex cursor-pointer items-center gap-1.5',
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
    >
      <Paperclip size={14} aria-hidden="true" />
      <span>{label}</span>
      <input
        id={id}
        type="file"
        multiple
        accept={accept}
        disabled={disabled}
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onFiles(files);
          // Zera o valor para que escolher O MESMO arquivo de novo dispare `change`
          // (o navegador não emite o evento quando o valor não muda).
          e.target.value = '';
        }}
      />
    </label>
  );
}
