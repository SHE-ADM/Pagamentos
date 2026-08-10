import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Flat config type-aware do pacote compartilhado (@sheild/shared) — apenas
// schemas Zod/TS, sem React. `tsconfigRootDir` ancora o parser ao tsconfig do
// pacote (evita "No tsconfigRootDir was set"). O glob restringe a `**/*.ts`, então
// o próprio `eslint.config.mjs` não entra no lint type-aware (não está no tsconfig).
export default tseslint.config(
  // `coverage` é obrigatório aqui: o lcov-report do istanbul traz `/* eslint-disable */` no topo
  // dos arquivos GERADOS, e o `reportUnusedDisableDirectives` (ligado por padrão no ESLint 9+) os
  // acusa como diretiva inútil — derrubando a regra de "0 erros e 0 warnings". Não some apagando
  // a pasta: o workflow do SonarCloud roda `--coverage` a cada PR e a recria.
  { ignores: ['dist', 'coverage'] },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
