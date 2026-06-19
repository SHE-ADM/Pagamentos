import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

// Tags WCAG 2.1 Nível A + AA — mesma cobertura do runner jsdom (tests/axe.ts),
// mas aqui o axe roda no Chromium real, então AVALIA color-contrast (1.4.3/1.4.11),
// ordem de foco e demais regras que dependem de layout/render.
export const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Escaneia a página atual com axe-core e falha se houver qualquer violação AA.
 * A mensagem de erro lista regra · impacto · nº de nós · seletores — para
 * "levantar os problemas" de forma legível no relatório.
 */
export async function expectNoA11yViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();

  const report = violations.map(
    (v) =>
      `[${v.impact ?? 'n/a'}] ${v.id}: ${v.help} (${v.nodes.length} nó(s))\n` +
      v.nodes.map((n) => `    · ${n.target.join(' ')}`).join('\n'),
  );

  expect(report, `Violações WCAG AA encontradas:\n${report.join('\n')}`).toEqual([]);
}
