import { useState } from 'react';

const PREVIEW_LINES = 3;
const PREVIEW_CHARS = 200;

interface ExpandableTextProps {
  text: string | null | undefined;
  previewLines?: number;
  maxChars?: number;
}

// Atom — texto longo com alternancia "ver mais"/"ver menos". Preserva quebras
// de linha e espacamento original (whitespace-pre-wrap), util para exibir
// trechos de e-mail ou observacoes extensas sem poluir a tela por padrao.
// Trunca por linhas OU por quantidade de caracteres (o que vencer primeiro).
export default function ExpandableText({
  text,
  previewLines = PREVIEW_LINES,
  maxChars = PREVIEW_CHARS,
}: Readonly<ExpandableTextProps>) {
  const [expanded, setExpanded] = useState(false);

  if (!text) return null;

  const lines = text.split('\n');
  const tooManyLines = lines.length > previewLines;
  const tooLong = text.length > maxChars;
  const isLong = tooManyLines || tooLong;

  const preview = tooManyLines
    ? lines.slice(0, previewLines).join('\n')
    : text.slice(0, maxChars);

  return (
    <div>
      <p className="text-xs text-gray-600 whitespace-pre-wrap break-words">
        {expanded || !isLong ? text : `${preview}…`}
      </p>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          className="mt-1 text-xs text-brand hover:underline font-medium"
        >
          {expanded ? 'ver menos' : 'ver mais'}
        </button>
      )}
    </div>
  );
}
