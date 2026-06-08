// src/components/ExpandableText.jsx
// Atom — texto longo com alternancia "ver mais"/"ver menos". Preserva quebras
// de linha e espacamento original (whitespace-pre-wrap), util para exibir
// trechos de e-mail ou observacoes extensas sem poluir a tela por padrao.
import { useState } from 'react'

const PREVIEW_LINES = 3

export default function ExpandableText({ text, previewLines = PREVIEW_LINES }) {
  const [expanded, setExpanded] = useState(false)

  if (!text) return null

  const lines = text.split('\n')
  const isLong = lines.length > previewLines
  const preview = lines.slice(0, previewLines).join('\n')

  return (
    <div>
      <p className="text-xs text-gray-600 whitespace-pre-wrap break-words">
        {expanded || !isLong ? text : `${preview}…`}
      </p>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded(x => !x)}
          className="mt-1 text-[11px] text-brand hover:underline font-medium"
        >
          {expanded ? 'ver menos' : 'ver mais'}
        </button>
      )}
    </div>
  )
}
