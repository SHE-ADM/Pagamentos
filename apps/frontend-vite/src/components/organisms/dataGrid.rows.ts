// Achata as linhas do grid numa lista de "itens de render", onde CADA item é
// exatamente UM `<tr>`: a linha principal, a sub-linha responsiva (second), o
// rodapé sempre-visível (footer) e o painel de detalhe (detail). Isso permite
// virtualizar por item (1 tr = 1 índice medível), resolvendo o problema de uma
// linha de dados emitir múltiplos `<tr>`.
// Função pura (sem dependência do TanStack/React) — fácil de testar isoladamente.

type RenderItemKind = 'row' | 'second' | 'footer' | 'detail';

/** Descritor mínimo de uma linha para decidir quais `<tr>` ela gera. */
export interface RenderRowDescriptor {
  key: string;
  /** Há colunas que desceram para a sub-linha (breakpoint sm/md)? */
  hasSecondLine: boolean;
  /** O registro tem conteúdo de rodapé sempre-visível (ex.: informação adicional)? */
  hasFooter: boolean;
  /** A linha está selecionada (painel de detalhe aberto)? */
  isSelected: boolean;
}

/** Um `<tr>` a renderizar: o tipo + o índice da linha de origem + uma key estável. */
export interface RenderItem {
  kind: RenderItemKind;
  rowIndex: number;
  key: string;
}

/**
 * Expande os descritores de linha na sequência de `<tr>` a renderizar (na ordem):
 * linha principal → sub-linha (se houver) → rodapé (se houver) → detalhe (se
 * selecionada e há `renderDetail`).
 * @param rows Descritores na ordem de exibição (o índice vira `rowIndex`).
 * @param hasDetail Se o grid tem `renderDetail` (sem ele, nunca há item `detail`).
 */
export function buildRenderItems(rows: RenderRowDescriptor[], hasDetail: boolean): RenderItem[] {
  const items: RenderItem[] = [];
  rows.forEach((r, i) => {
    items.push({ kind: 'row', rowIndex: i, key: r.key });
    if (r.hasSecondLine) items.push({ kind: 'second', rowIndex: i, key: `${r.key}::second` });
    if (r.hasFooter) items.push({ kind: 'footer', rowIndex: i, key: `${r.key}::footer` });
    if (r.isSelected && hasDetail) items.push({ kind: 'detail', rowIndex: i, key: `${r.key}::detail` });
  });
  return items;
}
