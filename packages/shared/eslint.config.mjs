import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Flat config type-aware do pacote compartilhado (@sheild/shared) — apenas
// schemas Zod/TS, sem React. `tsconfigRootDir` ancora o parser ao tsconfig do
// pacote (evita "No tsconfigRootDir was set"). O glob restringe a `**/*.ts`, então
// o próprio `eslint.config.mjs` não entra no lint type-aware (não está no tsconfig).
export default tseslint.config(
  { ignores: ['dist'] },
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
