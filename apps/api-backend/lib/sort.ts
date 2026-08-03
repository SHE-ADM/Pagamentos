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

/** Ordem default do recurso, aplicada quando o cliente não pede coluna válida. */
interface DefaultOrder {
  column: string;
  ascending: boolean;
  nullsFirst?: boolean;
}

/** Subconjunto do query builder do supabase-js que este helper precisa. */
interface Orderable {
  order(column: string, options: { ascending: boolean; nullsFirst?: boolean }): this;
}

/**
 * Aplica a ordenação do recurso SEMPRE seguida de um desempate único (a PK).
 *
 * Por que o desempate é obrigatório (não regredir): `ORDER BY coluna` não define ordem
 * total quando há empates, e a ordem efetiva muda com o plano de execução. Como a
 * paginação é por `range()` (offset), cada página é uma consulta nova — uma linha
 * empatada pode repetir entre páginas e outra pode ser PULADA, sumindo da tela sem
 * erro nenhum. Medido nesta base: a mesma página por `due_date desc` devolveu conjuntos
 * diferentes conforme o plano (1 linha entrou, 1 saiu).
 *
 * Centralizado aqui de propósito: cada service chamando `.order()` na mão é exatamente
 * como o desempate foi esquecido nos 8 recursos paginados.
 *
 * @param query Query do supabase-js já filtrada.
 * @param sorted Resultado de `resolveSort` (null → usa `fallback`).
 * @param fallback Ordem default do recurso.
 * @param tiebreak Coluna ÚNICA de desempate — a PK da tabela.
 */
export function applyOrder<Q extends Orderable>(
  query: Q,
  sorted: ResolvedSort | null,
  fallback: DefaultOrder,
  tiebreak: string,
): Q {
  const primary: DefaultOrder = sorted
    ? { column: sorted.column, ascending: sorted.ascending, nullsFirst: false }
    : fallback;
  const ordered = query.order(primary.column, {
    ascending: primary.ascending,
    ...(primary.nullsFirst === undefined ? {} : { nullsFirst: primary.nullsFirst }),
  });
  // Já ordenado pela própria PK → a ordem já é total.
  if (primary.column === tiebreak) return ordered;
  // O desempate acompanha a direção principal (dentro do empate, `desc` = mais recentes
  // primeiro). O que importa é ser determinístico e IGUAL em todas as páginas.
  return ordered.order(tiebreak, { ascending: primary.ascending });
}

/** Extrai `sort`/`order` dos query params da rota (order restrito a asc|desc). */
export function parseSortParams(sp: URLSearchParams): { sort?: string; order?: SortOrder } {
  const sort = sp.get('sort') ?? undefined;
  const rawOrder = sp.get('order');
  let order: SortOrder | undefined;
  if (rawOrder === 'asc' || rawOrder === 'desc') order = rawOrder;
  return { sort, order };
}
