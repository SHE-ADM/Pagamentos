// lib/sort.guard.test.ts
// Guarda ESTRUTURAL: toda listagem paginada da Next API ordena com desempate único.
//
// O teste unitário de `applyOrder` prova que o helper funciona; ele NÃO prova que os
// services o usam — e foi exatamente esse o defeito: 8 recursos paginados chamando
// `.order()` na mão, cada um esquecendo o desempate. Uma guarda que lê o código é o que
// impede o 9º recurso de repetir o erro.
//
// Ancorado em `import.meta.dirname` (não `process.cwd()`, que muda conforme o vitest é
// invocado da raiz do monorepo ou do app).

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const LIB_DIR = import.meta.dirname;

/** Módulos da lib, exceto testes e o próprio helper. */
function libSources(): { file: string; code: string }[] {
  return readdirSync(LIB_DIR)
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.') && f !== 'sort.ts')
    .map((f) => ({ file: f, code: readFileSync(join(LIB_DIR, f), 'utf8') }));
}

/**
 * Recorta o statement que termina em `.range(` — do `return` mais próximo acima até a
 * chamada. É esse trecho que precisa conter a ordenação aplicada.
 */
function statementsEndingInRange(code: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = code.indexOf('.range(', from);
    if (at === -1) return out;
    const start = code.lastIndexOf('return', at);
    out.push(code.slice(start === -1 ? Math.max(0, at - 300) : start, at));
    from = at + 1;
  }
}

describe('guarda: paginação da Next API sempre ordena com desempate', () => {
  const paginados = libSources()
    .flatMap(({ file, code }) => statementsEndingInRange(code).map((stmt) => ({ file, stmt })));

  // Sanidade do parser: se o recorte parar de casar, os `it` abaixo passariam sobre uma
  // lista vazia — verdes para sempre, provando nada. Hoje são 8 recursos paginados.
  it('o parser encontra as listagens paginadas (sanidade)', () => {
    expect(paginados.length).toBeGreaterThanOrEqual(8);
  });

  it.each(paginados.map((p) => [p.file, p.stmt] as const))(
    '%s: a listagem paginada passa por applyOrder',
    (_file, stmt) => {
      expect(stmt).toContain('applyOrder(');
    },
  );

  it.each(paginados.map((p) => [p.file, p.stmt] as const))(
    '%s: a listagem paginada não chama .order() direto (perderia o desempate)',
    (_file, stmt) => {
      expect(stmt).not.toMatch(/\.order\(/);
    },
  );
});
