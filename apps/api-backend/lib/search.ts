// lib/search.ts
// Helpers de busca compartilhados pelos CRUDs de cadastro (grupo Tabelas). Resolve
// os ids de uma tabela relacionada (embed de JOIN) cujo(s) campo(s) textual(is) casam
// o termo — necessário porque o PostgREST não filtra a linha-pai por coluna de embed
// diretamente. Mesmo padrão da busca por fornecedor em /consulta
// (services/supabase.ts → findSupplierIdsByTerm): resolve ids e injeta `col.in.(...)`.

import { getSupabaseAdmin } from './supabase-admin';

/**
 * Resolve os ids de `table` cujo(s) `searchColumns` casam `term` (ilike, OR entre eles).
 * Usado para estender a busca do grid às colunas que vêm de JOIN (embed).
 * @param term termo JÁ sanitizado pelo chamador (sem os chars de controle do filtro).
 * @returns ids numéricos que casam (vazio se nada casar ou em erro — best-effort).
 */
export async function resolveMatchingIds(
  table: string,
  idColumn: string,
  searchColumns: readonly string[],
  term: string,
): Promise<number[]> {
  const orExpr = searchColumns.map((c) => `${c}.ilike.%${term}%`).join(',');
  const { data } = await getSupabaseAdmin().from(table).select(idColumn).or(orExpr);
  return ((data ?? []) as unknown as Record<string, unknown>[])
    .map((row) => Number(row[idColumn]))
    .filter((n) => Number.isFinite(n));
}

/**
 * Converte um termo em número quando ele é um valor numérico (formato BR `1.234,56`
 * ou simples `1234.56`/`391`); caso contrário retorna null. Usado para casar colunas
 * numéricas (saldo, tipo de pagamento) por igualdade exata na busca do grid.
 */
export function parseNumericTerm(term: string): number | null {
  const cleaned = term.replace(/\s/g, '');
  if (!/^\d{1,3}(\.\d{3})*(,\d+)?$|^\d+(\.\d+)?$/.test(cleaned)) return null;
  const normalized = cleaned.includes(',') ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}
