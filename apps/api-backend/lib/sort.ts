// lib/sort.ts
// Ordenação server-side compartilhada pelos CRUDs de cadastro (grupo Tabelas +
// fornecedores). A coluna de ordenação é validada contra um allowlist por recurso —
// só colunas da própria tabela entram (embeds de JOIN são ordenação frágil no
// PostgREST, mesma regra do grid de /consulta). Coluna inválida/ausente → null,
// e o chamador aplica a ordem default do recurso.

export type SortOrder = 'asc' | 'desc';

interface ResolvedSort {
  column: string;
  ascending: boolean;
}

/**
 * Resolve a coluna de ordenação contra o allowlist do recurso.
 * @param sort Coluna pedida pelo cliente (query `sort`).
 * @param order Direção pedida (`asc`/`desc`); ausente assume `asc`.
 * @param allowed Colunas ordenáveis do recurso (própria tabela).
 * @returns `{ column, ascending }` quando válido; `null` para usar a ordem default.
 */
export function resolveSort(
  sort: string | undefined,
  order: SortOrder | undefined,
  allowed: readonly string[],
): ResolvedSort | null {
  if (!sort || !allowed.includes(sort)) return null;
  return { column: sort, ascending: order !== 'desc' };
}

/** Extrai `sort`/`order` dos query params da rota (order restrito a asc|desc). */
export function parseSortParams(sp: URLSearchParams): { sort?: string; order?: SortOrder } {
  const sort = sp.get('sort') ?? undefined;
  const rawOrder = sp.get('order');
  let order: SortOrder | undefined;
  if (rawOrder === 'asc' || rawOrder === 'desc') order = rawOrder;
  return { sort, order };
}
