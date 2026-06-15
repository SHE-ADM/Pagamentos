// Runner axe-core configurado para WCAG 2.1 Nível AA (inclui A).
// Usado pelos testes *.a11y.test.tsx: `expect(await axe(container)).toHaveNoViolations()`.
//
// Limitação conhecida: a regra `color-contrast` não é avaliada em jsdom (não há
// layout/render real). A garantia de contraste AA completa exige axe em navegador
// (Playwright). Esta camada cobre as regras estruturais AA.
import { configureAxe } from 'jest-axe';

export const axe = configureAxe({
  runOnly: {
    type: 'tag',
    values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
  },
  // color-contrast não é confiável em jsdom (sem layout/render) — desabilitada
  // aqui para evitar falso-incompleto; cobertura de contraste fica para axe em
  // navegador (Playwright), conforme follow-up.
  rules: {
    'color-contrast': { enabled: false },
  },
});

// Augmentação do expect do Vitest com o matcher do jest-axe (o @types/jest-axe
// só estende o expect do Jest; aqui declaramos para o Vitest).
interface AxeMatchers<R = unknown> {
  toHaveNoViolations(): R;
}

declare module 'vitest' {
  // O parâmetro de tipo deve casar com a declaração do Vitest (T = any).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type
  interface Assertion<T = any> extends AxeMatchers<T> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}
