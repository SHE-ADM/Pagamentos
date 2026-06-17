import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Home from './page';

// Smoke test do portal público (placeholder). Renderiza via server (sem hooks),
// evitando o conflito de versões do React no monorepo — ver vitest.config.ts.
describe('Home (portal público)', () => {
  const html = renderToStaticMarkup(<Home />);

  it('renderiza o título do projeto', () => {
    expect(html).toContain('pagamentos');
  });

  it('exibe o aviso de "em construção"', () => {
    expect(html).toContain('Em construção');
  });
});
