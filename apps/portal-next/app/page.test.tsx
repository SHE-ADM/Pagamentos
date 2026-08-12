import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Home from './page';

// Smoke test do portal público (placeholder). Renderiza via server (sem hooks) porque a
// página não tem interação — NÃO por causa do antigo conflito de versões do React, que
// deixou de existir com o React unificado em 19. Ver o cabeçalho de vitest.config.ts.
describe('Home (portal público)', () => {
  const html = renderToStaticMarkup(<Home />);

  it('renderiza o título do projeto', () => {
    expect(html).toContain('pagamentos');
  });

  it('exibe o aviso de "em construção"', () => {
    expect(html).toContain('Em construção');
  });
});
