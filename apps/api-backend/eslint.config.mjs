import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Ancora a raiz do projeto TS para o parser type-aware — evita
  // "Parsing error: No tsconfigRootDir was set" no editor.
  {
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Relatório de cobertura (gerado por `vitest --coverage`, que o workflow do SonarCloud
    // roda a cada PR). Os arquivos do lcov-report do istanbul trazem um `/* eslint-disable */`
    // no topo, e o `reportUnusedDisableDirectives` (default do ESLint 9) o acusa como
    // diretiva inútil — warning em código GERADO, que a regra de lint limpo do projeto
    // (0 erros/0 warnings) não deve carregar. Espelha o `ignores` do frontend-vite.
    "coverage/**",
  ]),
]);

export default eslintConfig;
