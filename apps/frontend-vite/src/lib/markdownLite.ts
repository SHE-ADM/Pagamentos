// src/lib/markdownLite.ts
// Parser de um SUBCONJUNTO de markdown, usado para renderizar a resposta do chat de IA.
//
// POR QUE UM PARSER PRÓPRIO E NÃO react-markdown
// O SYSTEM_PROMPT do gateway pede "tabela markdown enxuta", e o backend devolve só texto — a
// tabela existe apenas no markdown de `answer`. O que o modelo produz na prática é um subconjunto
// pequeno e previsível (parágrafo, lista, tabela GFM, negrito, código), então este módulo cobre
// exatamente isso sem trazer dependência nova para o bundle.
//
// SEGURANÇA: o parser devolve ESTRUTURA, nunca HTML. Quem renderiza é o MarkdownMessage, com JSX
// puro — não há `dangerouslySetInnerHTML` em nenhum ponto do caminho, então texto vindo do modelo
// não pode injetar markup.
//
// DEGRADAÇÃO: linha que não casa nenhum bloco vira parágrafo com o texto cru. O pior caso é o
// usuário ver um asterisco ou um pipe na tela — nunca perder conteúdo.

/** Trecho de texto de uma linha, já classificado. */
export type InlineToken =
  | { type: 'text'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'code'; text: string };

export type MarkdownBlock =
  /** Parágrafo. `lines` preserva as quebras simples (o modelo usa quebra para separar itens). */
  | { type: 'paragraph'; lines: InlineToken[][] }
  | { type: 'heading'; content: InlineToken[] }
  | { type: 'list'; ordered: boolean; items: InlineToken[][] }
  /** Tabela GFM. `header` são as células do cabeçalho; `rows`, as células de cada linha. */
  | { type: 'table'; header: InlineToken[][]; rows: InlineToken[][][] };

const HEADING_RE = /^ {0,3}#{1,6}\s+(.*)$/;
const BULLET_RE = /^ {0,3}[-*+]\s+(.*)$/;
const ORDERED_RE = /^ {0,3}\d{1,3}[.)]\s+(.*)$/;
/** Linha de tabela: começa com `|` (o modelo sempre fecha as bordas). */
const TABLE_ROW_RE = /^ {0,3}\|.*\|?\s*$/;
/** Separador GFM: `| --- | :--: |` — é ele que confirma que as linhas com pipe são uma tabela. */
const TABLE_SEP_RE = /^ {0,3}\|[\s|:-]*-[\s|:-]*\|?\s*$/;
/** `**negrito**` ou `` `código` `` — a ordem das alternativas define a precedência. */
const INLINE_RE = /\*\*(.+?)\*\*|`([^`]+)`/g;

/** Divide a linha da tabela em células, descartando as bordas vazias. */
function splitCells(line: string): string[] {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.map((c) => c.trim());
}

/** Quebra uma linha em tokens de negrito/código/texto. */
export function parseInline(line: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;

  // `matchAll` e não `exec` em laço: o regex é de módulo e tem a flag `g`, então `exec` avança o
  // `lastIndex` COMPARTILHADO — um `return` no meio (ou uma futura chamada reentrante) deixaria o
  // regex sujo para o próximo chamador. `matchAll` opera sobre um clone e não toca no original,
  // eliminando o estado mutável em vez de precisar zerá-lo por disciplina.
  for (const m of line.matchAll(INLINE_RE)) {
    // `index` é opcional no tipo (regex sem `d`), mas sempre presente em match de string.
    const at = m.index;
    if (at > last) tokens.push({ type: 'text', text: line.slice(last, at) });
    if (m[1] !== undefined) tokens.push({ type: 'strong', text: m[1] });
    else if (m[2] !== undefined) tokens.push({ type: 'code', text: m[2] });
    last = at + m[0].length;
  }

  if (last < line.length) tokens.push({ type: 'text', text: line.slice(last) });
  // Linha vazia dentro de uma célula de tabela: devolve um token vazio em vez de [] para o
  // renderizador não precisar tratar o caso especial.
  return tokens.length ? tokens : [{ type: 'text', text: line }];
}

function isBlockStart(line: string): boolean {
  return (
    HEADING_RE.test(line)
    || BULLET_RE.test(line)
    || ORDERED_RE.test(line)
    || TABLE_ROW_RE.test(line)
  );
}

/** Consome a tabela a partir de `start`; devolve o bloco e o índice da próxima linha. */
function readTable(lines: string[], start: number): { block: MarkdownBlock; next: number } {
  const header = splitCells(lines[start]).map(parseInline);
  const rows: InlineToken[][][] = [];
  let i = start + 2; // pula cabeçalho + separador

  while (i < lines.length && TABLE_ROW_RE.test(lines[i]) && !TABLE_SEP_RE.test(lines[i])) {
    rows.push(splitCells(lines[i]).map(parseInline));
    i += 1;
  }

  return { block: { type: 'table', header, rows }, next: i };
}

/** Consome itens de lista consecutivos do mesmo tipo. */
function readList(lines: string[], start: number, ordered: boolean): { block: MarkdownBlock; next: number } {
  const re = ordered ? ORDERED_RE : BULLET_RE;
  const items: InlineToken[][] = [];
  let i = start;

  while (i < lines.length) {
    const match = re.exec(lines[i]);
    if (!match) break;
    items.push(parseInline(match[1]));
    i += 1;
  }

  return { block: { type: 'list', ordered, items }, next: i };
}

/** Consome linhas de parágrafo até uma linha vazia ou o início de outro bloco. */
function readParagraph(lines: string[], start: number): { block: MarkdownBlock; next: number } {
  const collected: InlineToken[][] = [];
  let i = start;

  while (i < lines.length && lines[i].trim() !== '' && (i === start || !isBlockStart(lines[i]))) {
    collected.push(parseInline(lines[i].trim()));
    i += 1;
  }

  return { block: { type: 'paragraph', lines: collected }, next: i };
}

/** Consome o título da linha `start`. */
function readHeading(lines: string[], start: number): { block: MarkdownBlock; next: number } {
  // O `matches` do dispatch já garantiu o casamento; o `?? ''` só satisfaz o tipo.
  const text = HEADING_RE.exec(lines[start])?.[1] ?? '';
  return {
    block: { type: 'heading', content: parseInline(text.replace(/\s*#+\s*$/, '')) },
    next: start + 1,
  };
}

/**
 * Tabela de blocos, em ordem de PRECEDÊNCIA — o primeiro `matches` que casar decide.
 *
 * Substitui a cadeia de `if`s que fazia o dispatch: cada bloco novo passa a ser uma LINHA aqui, em
 * vez de mais um ramo aninhado dentro do laço (que é como a complexidade cognitiva de uma função de
 * parsing cresce até ninguém mais conseguir revisá-la com segurança). Mesmo padrão de tabela de
 * fontes usado no pipeline Python (`_BODY_INVOICE_SOURCES`).
 *
 * O parágrafo NÃO está aqui: é o fallback, e um `matches` que devolve sempre `true` no fim da lista
 * esconderia isso.
 */
const BLOCK_READERS: {
  matches: (lines: string[], i: number) => boolean;
  read: (lines: string[], i: number) => { block: MarkdownBlock; next: number };
}[] = [
  {
    matches: (lines, i) => HEADING_RE.test(lines[i]),
    read: readHeading,
  },
  {
    // Tabela só quando a linha SEGUINTE é o separador GFM. Sem essa exigência, uma frase que por
    // acaso comece com `|` viraria uma tabela de uma coluna.
    matches: (lines, i) => TABLE_ROW_RE.test(lines[i]) && TABLE_SEP_RE.test(lines[i + 1] ?? ''),
    read: readTable,
  },
  {
    matches: (lines, i) => BULLET_RE.test(lines[i]),
    read: (lines, i) => readList(lines, i, false),
  },
  {
    matches: (lines, i) => ORDERED_RE.test(lines[i]),
    read: (lines, i) => readList(lines, i, true),
  },
];

/**
 * Converte o texto do modelo em blocos renderizáveis. Nunca lança; texto vazio devolve `[]`.
 */
export function parseMarkdownLite(text: string): MarkdownBlock[] {
  if (!text?.trim()) return [];

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i].trim() === '') {
      i += 1;
      continue;
    }

    // Todo reader avança pelo menos uma linha (o parágrafo consome a linha inicial mesmo quando ela
    // parece início de outro bloco), então o laço sempre progride.
    const reader = BLOCK_READERS.find((r) => r.matches(lines, i));
    const { block, next } = (reader?.read ?? readParagraph)(lines, i);
    blocks.push(block);
    i = next;
  }

  return blocks;
}
