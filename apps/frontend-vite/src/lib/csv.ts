// src/lib/csv.ts
// Helpers de exportação CSV. Centraliza a montagem segura de célula — usado pelo
// export de /consulta. Conteúdo de e-mail hostil (description/email_body_excerpt/…)
// sai do navegador para o Excel/Sheets, então a célula precisa ser à prova de
// CSV/formula injection.

// Caracteres que disparam avaliação de fórmula em Excel/LibreOffice/Sheets quando
// iniciam uma célula: = + - @ (e os de controle tab/CR).
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * Monta UMA célula CSV segura: neutraliza injeção de fórmula (prefixa `'` quando o valor
 * começa com = + - @ / tab / CR), escapa aspas (`"`→`""`) e remove quebras de linha
 * internas (manteriam a linha do CSV). Retorna o valor já entre aspas. Aceita os tipos
 * de valor de coluna (string/número/nulo) — não objetos arbitrários.
 */
export function csvCell(value: string | number | null | undefined): string {
  let s = String(value ?? '');
  if (FORMULA_TRIGGER.test(s)) s = "'" + s;
  // split/join: escapa todas as aspas e colapsa quebras de linha sem depender de
  // String#replaceAll (não disponível no lib alvo) nem de replace com /g.
  const escaped = s.split('"').join('""').split(/[\r\n]+/).join(' ');
  return `"${escaped}"`;
}
