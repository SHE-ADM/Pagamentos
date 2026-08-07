import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { SENTINEL_AUTHOR_ID } from './sentinelAuthor';

// GUARDA CROSS-LAYER: a constante do frontend × o DEFAULT real no banco.
//
// O par é uma fonte de verdade duplicada por necessidade — o banco não é alcançável do teste,
// e o valor precisa existir no bundle. O risco de divergir é REAL e SILENCIOSO: nada quebra,
// a tela só deixa de reconhecer o sentinela e passa a exibir "Última edição por: <e-mail>" em
// centenas de contas que ninguém editou. Sem este guarda, a única forma de descobrir seria
// alguém estranhar o painel.
//
// A régua é a MIGRATION, não uma constante repetida aqui: é ela que define o DEFAULT aplicado
// ao banco. E é sempre a MAIS RECENTE que define o DEFAULT — migrations são cumulativas, então
// se um dia a 120 trocar o sentinela de novo, este teste passa a exigir que o frontend a
// acompanhe, em vez de continuar validando contra a 110.
//
// Ancorado em `import.meta.dirname`, não em `process.cwd()`: o cwd muda conforme o vitest é
// invocado (raiz do monorepo × workspace), e o teste passaria a não achar o arquivo.
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../../../supabase/migrations');

/** `ALTER COLUMN created_by SET DEFAULT '<uuid>'::uuid` — em uma linha ou quebrado em várias. */
const DEFAULT_CRIADOR_RE =
  /ALTER\s+COLUMN\s+created_by\s+SET\s+DEFAULT\s+'([0-9a-f-]{36})'::uuid/i;

describe('sentinela de autoria — constante do frontend × DEFAULT do banco', () => {
  const arquivos = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // numeração 001.. é zero-padded, então a ordem lexicográfica é a cronológica

  it('a migration mais recente que define o DEFAULT usa o mesmo UUID da constante', () => {
    const comDefault = arquivos
      .map((f) => ({ f, m: DEFAULT_CRIADOR_RE.exec(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')) }))
      .filter((x) => x.m !== null);

    // 🔴 Sanidade do parser — sem isto, um regex que parasse de casar (por reformatação do SQL,
    // por outra sintaxe de ALTER, por rename da coluna) transformaria o teste em `0 === 0`:
    // verde para sempre, exatamente quando deixou de verificar qualquer coisa.
    expect(comDefault.length).toBeGreaterThan(0);

    const ultima = comDefault[comDefault.length - 1];
    expect(ultima.m?.[1]).toBe(SENTINEL_AUTHOR_ID);
  });

  // As quatro colunas de sentinela têm de apontar para o MESMO usuário. Divergirem seria pior
  // que estarem erradas juntas: a conta nasceria com um autor e o anexo dela com outro, e a
  // tela ocultaria a autoria de um e não do outro.
  it('todos os DEFAULT de sentinela da migration mais recente são o mesmo UUID', () => {
    const ultimaComDefault = [...arquivos]
      .reverse()
      .find((f) => DEFAULT_CRIADOR_RE.test(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')));
    expect(ultimaComDefault).toBeDefined();

    const sql = readFileSync(path.join(MIGRATIONS_DIR, ultimaComDefault as string), 'utf8');
    const uuids = [
      ...sql.matchAll(
        /ALTER\s+COLUMN\s+(created_by|updated_by|status_changed_by|uploaded_by)\s+SET\s+DEFAULT\s+'([0-9a-f-]{36})'::uuid/gi,
      ),
    ];

    expect(uuids.length).toBe(4); // sanidade: as quatro colunas foram encontradas
    for (const [, coluna, uuid] of uuids) {
      expect(uuid, `coluna ${coluna}`).toBe(SENTINEL_AUTHOR_ID);
    }
  });

  // O fallback da RPC é o ponto onde a divergência tem a pior consequência: se ele apontar
  // para um usuário inexistente, TODO INSERT de conta cujo remetente não seja usuário do
  // sistema viola a FK e o pipeline para de gravar — longe da causa.
  it('o fallback de resolve_user_for_account usa o mesmo UUID', () => {
    const arquivoRpc = [...arquivos]
      .reverse()
      .find((f) =>
        /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.resolve_user_for_account/i.test(
          readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'),
        ),
      );
    expect(arquivoRpc).toBeDefined();

    const sql = readFileSync(path.join(MIGRATIONS_DIR, arquivoRpc as string), 'utf8');
    const fallback = /COALESCE\([\s\S]*?'([0-9a-f-]{36})'::uuid\)/i.exec(sql);
    expect(fallback).not.toBeNull();
    expect(fallback?.[1]).toBe(SENTINEL_AUTHOR_ID);
  });
});
