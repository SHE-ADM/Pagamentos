import { test } from '@playwright/test';
import { expectNoA11yViolations } from './axe';

// Páginas de autenticação — acessíveis sem login. É onde vivem as paletas
// customizadas (loginGreen / auth gradient), exatamente o ponto cego da suíte
// jsdom para contraste real.
const PUBLIC_PAGES = [
  { path: '/auth/login', name: 'Login (loginGreen)' },
  { path: '/auth/forgot-password', name: 'Esqueci a senha (auth gradient)' },
  { path: '/auth/reset-password', name: 'Redefinir senha (auth gradient)' },
];

test.describe('Acessibilidade WCAG AA — páginas públicas (navegador real)', () => {
  for (const p of PUBLIC_PAGES) {
    test(`${p.name} — ${p.path}`, async ({ page }) => {
      await page.goto(p.path);
      // O app monta de forma assíncrona; aguarda o formulário aparecer.
      await page.locator('form').first().waitFor({ state: 'visible' });
      await expectNoA11yViolations(page);
    });
  }
});
