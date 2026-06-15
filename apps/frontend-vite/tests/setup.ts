// Registra os matchers do jest-dom no expect do Vitest e aplica a augmentação
// de tipos (toBeInTheDocument, toHaveTextContent, etc.).
import '@testing-library/jest-dom/vitest';

// Matcher de acessibilidade (jest-axe) — habilita expect(...).toHaveNoViolations().
import { expect } from 'vitest';
import { toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

// jsdom não implementa window.matchMedia — necessário para hooks de breakpoint
// (useBreakpoint/DataGrid). matches=true mantém o breakpoint 'lg' (tabela completa)
// nos testes, equivalente ao viewport padrão do jsdom (1024px).
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
});
