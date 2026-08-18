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

/**
 * Ausência de dado — vazio ou traço. `—`/`-` é a grafia usual de "sem valor" numa tabela (as
 * funções de `analytics` devolvem NULL de propósito), e isso NÃO é texto: se votasse, uma única
 * linha sem dado jogaria a coluna inteira de volta para a esquerda — exatamente o defeito que o
 * alinhamento por coluna existe para corrigir.
 */
const BLANK_CELL_RE = /^[-–—]*$/;

// Alinhamento é decisão de COLUNA, não de célula: alinhar só a célula deixa o rótulo do cabeçalho
// (`text-left` herdado de `table-header`) do lado oposto do número que ele nomeia — foi o defeito
// visível na tabela do chat. Célula sem dado não desqualifica a coluna; ela só não vota.
function numericColumns(header: InlineToken[][], rows: InlineToken[][][]): boolean[] {
  const width = Math.max(header.length, ...rows.map((r) => r.length), 0);

  return Array.from({ length: width }, (_, col) => {
    let hasValue = false;

    for (const row of rows) {
      const text = row[col] ? cellText(row[col]).trim() : '';
      if (BLANK_CELL_RE.test(text)) continue;
      if (!NUMERIC_CELL_RE.test(text)) return false;
      hasValue = true;
    }

    return hasValue;
  });
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
    const alignRight = numericColumns(block.header, block.rows);

    return (
      // Tabela larga rola DENTRO do próprio contêiner — o corpo do chat nunca rola na horizontal.
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {block.header.map((cell, i) => (
                <th
                  key={`h-${i}`}
                  scope="col"
                  className={cn('table-header whitespace-nowrap', alignRight[i] && 'text-right')}
                >
                  <Inline tokens={cell} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={`r-${r}`}>
                {/* Linha mais curta que o cabeçalho é preenchida à direita: sem isso a última
                    célula sobe para a coluna errada e a tabela inteira parece desalinhada. */}
                {Array.from({ length: alignRight.length }, (_, c) => (
                  <td
                    key={`c-${r}-${c}`}
                    className={cn('table-cell', alignRight[c] && 'text-right tabular-nums')}
                  >
                    {row[c] ? <Inline tokens={row[c]} /> : null}
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
