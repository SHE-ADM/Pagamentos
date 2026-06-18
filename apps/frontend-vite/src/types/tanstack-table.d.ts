// Augment do TanStack Table v8: estende `ColumnMeta` com os campos customizados
// do nosso `ColumnDef<T>` (useGridColumns), preservados na migração do DataGrid.
// O DataGrid mapeia cada coluna própria → coluna TanStack guardando estes campos
// em `meta`, e o render os lê de volta (responsividade, sort, truncagem, tema).
//
// IMPORTANTE: os parâmetros de tipo `<TData extends RowData, TValue>` devem ser
// IDÊNTICOS à declaração original do TanStack — caso contrário o TS recusa o
// merge (TS2428 "All declarations must have identical type parameters").
import '@tanstack/react-table';

declare module '@tanstack/react-table' {
  // TData/TValue não são usados nos campos abaixo, mas devem existir e bater com a
  // assinatura original do TanStack para o merge de declaração (TS2428).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Breakpoints em que a coluna some da linha principal (sm=mobile, md=tablet). */
    hideOn?: Array<'sm' | 'md'>;
    /** Se true, ao ficar oculta a coluna desce para a sub-linha de detalhe. */
    secondLine?: boolean;
    /** Rótulo exibido ao lado do valor na linha secundária. */
    secondLineLabel?: string;
    /** Campo enviado ao Supabase para ordenação (mapeia ao SORT_COLS da página). */
    sortKey?: string;
    /** Alinhamento horizontal da célula. */
    align?: 'left' | 'right' | 'center';
    /** Trunca texto longo na célula (com `title`) — evita estourar largura no mobile. */
    truncate?: boolean;
    /** Classes extras aplicadas à célula (td). */
    className?: string;
  }
}
