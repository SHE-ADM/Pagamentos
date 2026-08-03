// lib/stableOrder.ts
// Ordenação ESTÁVEL para toda listagem paginada por offset (PostgREST).
//
// Por que existe (não regredir): `ORDER BY coluna` sem desempate NÃO define uma ordem
// total quando há linhas empatadas — o PostgreSQL pode devolvê-las em qualquer ordem, e
// a ordem muda conforme o plano de execução. Com paginação por `offset`, cada página é
// uma consulta NOVA: uma linha empatada pode cair no fim da página N e reaparecer no
// início da N+1 (DUPLICADA na tela) e outra pode ser pulada nas duas (SOME da tela).
//
// Medido nesta base (2026-08-03): a mesma página (offset 100, limit 50) por
// `due_date desc` devolveu conjuntos diferentes conforme o plano — 1 linha entrou e 1
// saiu. Empates são a norma, não a exceção: ordenar por Situação empata 682 de 682
// linhas (maior grupo: 493); por tipo de documento, 677; por vencimento, 647.
//
// A correção é acrescentar SEMPRE uma coluna de desempate ÚNICA (a PK) ao final do
// `order`. Com ela a ordem passa a ser total e a paginação vira determinística.
//
// O sumiço silencioso é o pior dos dois sintomas: uma conta a pagar que não aparece na
// tela não gera erro nenhum — só deixa de ser paga.

type SortDirection = 'asc' | 'desc';

interface StableOrderSpec {
  /** Coluna pedida pelo usuário (clique no cabeçalho). Ausente → usa `fallback`. */
  column?: string | null;
  /** Direção pedida; ausente assume `asc` quando há coluna. */
  dir?: SortDirection | null;
  /** Ordenação padrão do recurso, no formato PostgREST (ex.: `created_at.desc`). */
  fallback: string;
  /** Coluna ÚNICA de desempate — a PK da tabela (ex.: `id`, `sk_supplier`). */
  tiebreak: string;
}

/**
 * Monta o valor do parâmetro `order` do PostgREST com desempate determinístico.
 *
 * @example
 * stableOrder({ column: 'due_date', dir: 'desc', fallback: 'created_at.desc', tiebreak: 'id' })
 * // => 'due_date.desc,id.desc'
 * stableOrder({ fallback: 'created_at.desc', tiebreak: 'id' })
 * // => 'created_at.desc,id.desc'
 */
export function stableOrder({ column, dir, fallback, tiebreak }: StableOrderSpec): string {
  const primary = column ? `${column}.${dir ?? 'asc'}` : fallback;
  // O desempate acompanha a direção da ordenação principal — dentro de um grupo
  // empatado, `desc` mostra os registros mais recentes primeiro (leitura natural).
  const primaryDir: SortDirection = primary.endsWith('.desc') ? 'desc' : 'asc';
  // Já ordenado pela própria PK → a ordem já é total; repetir a coluna seria inócuo,
  // mas polui a query e confunde quem lê o log do PostgREST.
  if (primaryColumnOf(primary) === tiebreak) return primary;
  return `${primary},${tiebreak}.${primaryDir}`;
}

/**
 * Nome da coluna de um termo `coluna.direcao` do PostgREST.
 * Cobre a sintaxe de recurso embutido (`status_dim(status_name).asc`), em que o ponto
 * do separador NÃO é o primeiro caractere de ponto do termo.
 */
function primaryColumnOf(term: string): string {
  const cut = term.lastIndexOf('.');
  return cut === -1 ? term : term.slice(0, cut);
}
