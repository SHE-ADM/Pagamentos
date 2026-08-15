import { test, expect, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './axe';

// Rotas internas exigem sessão (Supabase Auth). Sem auto-cadastro: o admin cria um
// usuário de teste no Supabase e exporta as credenciais antes de rodar:
//   $env:A11Y_TEST_EMAIL='...'; $env:A11Y_TEST_PASSWORD='...'; npm run test:e2e
// Sem as variáveis, todo este bloco é pulado (não falha a suíte).
const EMAIL = process.env.A11Y_TEST_EMAIL;
const PASSWORD = process.env.A11Y_TEST_PASSWORD;

/**
 * Um ESTADO extra da mesma rota: uma tela cujo DOM muda por interação escaneia, no estado de
 * abertura, só metade do que ela renderiza. Cada estado vira um `test` próprio — assim a falha
 * diz QUAL estado quebrou, em vez de apontar para a rota inteira.
 *
 * `enter` precisa ser TOLERANTE À AUSÊNCIA do gatilho (o default da tela pode mudar) e
 * INTOLERANTE À PERMANÊNCIA do estado que ele promete sair: um `enter` que falha em silêncio
 * faria o teste escanear o MESMO DOM duas vezes e reportar verde, que é pior que não existir —
 * a suíte declararia uma cobertura que não tem.
 */
type PageState = {
  name: string;
  enter: (page: Page) => Promise<void>;
};

/**
 * Volta o dashboard à visão SEM recorte de KPI. Desde 2026-08-15 as duas telas abrem filtradas
 * em "A vencer em 7 dias" (`useDashboardFilters('vencendo7')`), e o filtro exige situação "a
 * vencer" — enquanto a linha crítica do `PriorityList` exige "vencido". São mutuamente
 * exclusivos POR CONSTRUÇÃO, então, sem limpar o filtro, o ramo tintado daquele componente
 * (`bg-status-error-bg` + `border-l-status-error-solid` + selo `status-error-fg`) deixou de ser
 * renderizado em navegador — em NENHUMA base de dados. É contraste que só esta camada mede: o
 * jsdom tem `color-contrast` desligado, e o ratchet de tokens cobre aquele fundo em apenas dois
 * pares.
 *
 * ⚠️ O que este estado restaura é a COBERTURA anterior à mudança, não uma garantia de dado: se
 * o mês corrente não tiver nenhuma conta vencida, não há linha crítica para escanear — como já
 * era antes. Assertar a presença dela acoplaria o CI ao dado de produção e faria a suíte falhar
 * por um mês tranquilo, que é o oposto de um bom guarda.
 */
const limparFiltroDeKpi = async (page: Page): Promise<void> => {
  // Regex, não o rótulo do KPI: o chip diz "filtrando: <KPI> ✕" e o default já mudou duas vezes
  // (total → aVencer → vencendo7). Casar o prefixo sobrevive à próxima troca.
  const chip = page.getByRole('button', { name: /^filtrando:/ });
  if (await chip.count()) {
    await chip.click();
    // O clique limpa o filtro e REFAZ a leitura; escanear antes de ela voltar mediria a tela
    // em estado de carregamento, não a visão completa que este estado existe para cobrir.
    await page.waitForLoadState('networkidle');
  }
  await expect(
    chip,
    'o chip "filtrando: …" continua na tela — o estado "sem filtro de KPI" não foi alcançado e '
      + 'o scan abaixo repetiria o DOM do estado de abertura',
  ).toHaveCount(0);
};

const PROTECTED_PAGES: { path: string; name: string; states?: PageState[] }[] = [
  { path: '/consulta', name: 'Consulta' },
  { path: '/emails', name: 'Emails' },
  { path: '/erros', name: 'Erros' },
  // Dashboard incluído (achado A3-8): é o único ponto que avalia color-contrast em
  // render real — sem ele as violações de contraste do Dashboard não eram escaneadas.
  {
    path: '/dashboard_vencimentos',
    name: 'Dashboard',
    states: [{ name: 'sem filtro de KPI', enter: limparFiltroDeKpi }],
  },
];

/**
 * Abre a rota e espera a SPA montar de fato — `networkidle` sozinho prova que a rede sossegou,
 * não que o React renderizou. `.first()` de propósito: o strict mode do Playwright faria o
 * `waitFor` EXPLODIR numa página com dois `h1`, transformando um detalhe de marcação num erro
 * que não menciona acessibilidade em lugar nenhum — e aqui o `h1` é só o sinal de "montou".
 */
const abrir = async (page: Page, path: string): Promise<void> => {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1 }).first().waitFor();
};

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
    // Estado de ABERTURA — o que o usuário vê ao entrar na rota.
    test(`${p.name} — ${p.path}`, async ({ page }) => {
      await abrir(page, p.path);
      await expectNoA11yViolations(page);
    });

    // Estados extras da MESMA rota, um teste cada (ver o tipo PageState).
    for (const s of p.states ?? []) {
      test(`${p.name} — ${p.path} (${s.name})`, async ({ page }) => {
        await abrir(page, p.path);
        await s.enter(page);
        await expectNoA11yViolations(page);
      });
    }
  }

  // Assistente de IA: é um <dialog> em modal, então o painel só existe no DOM (e no top layer)
  // depois do clique — o scan das páginas acima cobre apenas o botão flutuante. NÃO envia
  // pergunta: a resposta viria da Claude API (chamada paga e não-determinística); o que este
  // teste escaneia é o chrome do painel, onde vive o contraste sob render real.
  test('Assistente de IA — painel aberto', async ({ page }) => {
    await abrir(page, '/consulta');

    // 🔴 PRÉ-CONDIÇÃO DE PERMISSÃO, não de acessibilidade (Onda 8, migration 120): desde o gate
    // por grupo, o `Layout` só monta o botão flutuante quando `user_group.ai_chat_enabled` é true.
    // Sem esta checagem o `.click()` abaixo falharia por TIMEOUT — um erro que não menciona
    // permissão em lugar nenhum e manda quem investiga procurar no seletor ou no lazy chunk.
    // Ver a receita do usuário do CI em e2e/README.md.
    const botao = page.getByRole('button', { name: /abrir assistente/i });
    await expect(
      botao,
      'o botão do assistente não foi montado — o grupo do usuário do CI provavelmente está sem '
        + 'ai_chat_enabled (migration 120); ver e2e/README.md',
    ).toBeVisible();

    await botao.click();
    await page.getByLabel('Sua pergunta').waitFor();
    await expectNoA11yViolations(page);
  });
});
