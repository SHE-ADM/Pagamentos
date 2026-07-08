import { test } from '@playwright/test';
import { expectNoA11yViolations } from './axe';

// Rotas internas exigem sessão (Supabase Auth). Sem auto-cadastro: o admin cria um
// usuário de teste no Supabase e exporta as credenciais antes de rodar:
//   $env:A11Y_TEST_EMAIL='...'; $env:A11Y_TEST_PASSWORD='...'; npm run test:e2e
// Sem as variáveis, todo este bloco é pulado (não falha a suíte).
const EMAIL = process.env.A11Y_TEST_EMAIL;
const PASSWORD = process.env.A11Y_TEST_PASSWORD;

const PROTECTED_PAGES = [
  { path: '/consulta', name: 'Consulta' },
  { path: '/emails', name: 'Emails' },
  { path: '/erros', name: 'Erros' },
  // Dashboard incluído (achado A3-8): é o único ponto que avalia color-contrast em
  // render real — sem ele as violações de contraste do Dashboard não eram escaneadas.
  { path: '/dashboard', name: 'Dashboard' },
];

test.describe('Acessibilidade WCAG AA — páginas protegidas (navegador real)', () => {
  test.skip(
    !EMAIL || !PASSWORD,
    'Defina A11Y_TEST_EMAIL e A11Y_TEST_PASSWORD (usuário de teste no Supabase) para escanear as rotas protegidas.',
  );

  test.beforeEach(async ({ page }) => {
    await page.goto('/auth/login');
    // exact:true — sem isso, getByLabel('Senha') também casa o botão "Mostrar senha"
    // (match por substring) e dá strict mode violation.
    await page.getByLabel('Email ou usuário', { exact: true }).fill(EMAIL ?? '');
    await page.getByLabel('Senha', { exact: true }).fill(PASSWORD ?? '');
    await page.getByRole('button', { name: 'Login' }).click();
    // Login bem-sucedido redireciona para /consulta.
    await page.waitForURL('**/consulta');
  });

  for (const p of PROTECTED_PAGES) {
    test(`${p.name} — ${p.path}`, async ({ page }) => {
      await page.goto(p.path);
      await page.waitForLoadState('networkidle');
      await expectNoA11yViolations(page);
    });
  }
});
