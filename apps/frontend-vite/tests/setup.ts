// Registra os matchers do jest-dom no expect do Vitest e aplica a augmentação
// de tipos (toBeInTheDocument, toHaveTextContent, etc.).
import '@testing-library/jest-dom/vitest';

// Matcher de acessibilidade (jest-axe) — habilita expect(...).toHaveNoViolations().
import { expect } from 'vitest';
import { toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);
