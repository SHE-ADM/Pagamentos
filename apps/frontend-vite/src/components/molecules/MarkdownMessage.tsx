// src/components/molecules/MarkdownMessage.tsx
// Molecule — renderiza a resposta do chat de IA a partir dos blocos de lib/markdownLite.
//
// JSX puro, sem `dangerouslySetInnerHTML`: o texto vem do modelo, e renderizá-lo como HTML seria
// abrir um caminho de injeção por uma conveniência que não precisamos.
import { Fragment } from 'react';
import { parseMarkdownLite, type InlineToken, type MarkdownBlock } from '../../lib/markdownLite';
import { cn } from '../../lib/cn';

/** Célula que parece número/dinheiro alinha à direita — é o que faz a tabela de valores ser lida. */
const NUMERIC_CELL_RE = /^(R\$\s*)?-?[\d.,\s]+%?$/;

function Inline({ tokens }: Readonly<{ tokens: InlineToken[] }>) {
  return (
    <>
      {tokens.map((t, i) => {
        // Índice como key: os tokens de UMA linha não são reordenáveis nem removíveis
        // individualmente — a mensagem é imutável depois de renderizada.
        const key = `${t.type}-${i}`;
        if (t.type === 'strong') return <strong key={key} className="font-semibold">{t.text}</strong>;
        if (t.type === 'code') {
          return (
            <code key={key} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">
              {t.text}
            </code>
          );
        }
        return <Fragment key={key}>{t.text}</Fragment>;
      })}
    </>
  );
}

function cellText(tokens: InlineToken[]): string {
  return tokens.map((t) => t.text).join('');
}

function Block({ block }: Readonly<{ block: MarkdownBlock }>) {
  if (block.type === 'heading') {
    return (
      <p className="text-sm font-semibold text-slate-800">
        <Inline tokens={block.content} />
      </p>
    );
  }

  if (block.type === 'list') {
    const ListTag = block.ordered ? 'ol' : 'ul';
    return (
      <ListTag
        className={cn(
          'space-y-0.5 pl-5 text-sm text-slate-700',
          block.ordered ? 'list-decimal' : 'list-disc',
        )}
      >
        {block.items.map((item, i) => (
          <li key={`item-${i}`}>
            <Inline tokens={item} />
          </li>
        ))}
      </ListTag>
    );
  }

  if (block.type === 'table') {
    return (
      // Tabela larga rola DENTRO do próprio contêiner — o corpo do chat nunca rola na horizontal.
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {block.header.map((cell, i) => (
                <th key={`h-${i}`} scope="col" className="table-header whitespace-nowrap">
                  <Inline tokens={cell} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={`r-${r}`}>
                {row.map((cell, c) => (
                  <td
                    key={`c-${r}-${c}`}
                    className={cn(
                      'table-cell',
                      NUMERIC_CELL_RE.test(cellText(cell).trim()) && 'text-right tabular-nums',
                    )}
                  >
                    <Inline tokens={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // Parágrafo: cada linha do markdown vira uma linha na tela (o modelo usa a quebra simples
  // para separar itens curtos).
  return (
    <p className="text-sm text-slate-700">
      {block.lines.map((line, i) => (
        <Fragment key={`l-${i}`}>
          {i > 0 && <br />}
          <Inline tokens={line} />
        </Fragment>
      ))}
    </p>
  );
}

interface MarkdownMessageProps {
  text: string;
  className?: string;
}

export default function MarkdownMessage({ text, className }: Readonly<MarkdownMessageProps>) {
  const blocks = parseMarkdownLite(text);

  // Nada reconhecido (resposta só com espaços, por exemplo): mostra o texto cru em vez de um
  // balão vazio — degradar visível é melhor que sumir com o conteúdo.
  if (blocks.length === 0) {
    return <p className={cn('text-sm whitespace-pre-wrap text-slate-700', className)}>{text}</p>;
  }

  return (
    <div className={cn('space-y-2', className)}>
      {blocks.map((block, i) => (
        <Block key={`b-${i}`} block={block} />
      ))}
    </div>
  );
}
