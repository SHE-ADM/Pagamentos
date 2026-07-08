// Guarda automatizada de contraste WCAG 2.1 AA para as paletas do projeto.
// Complementa os testes *.a11y.test.tsx: o axe em jsdom NÃO avalia color-contrast
// (sem layout/render), então esta suíte calcula os ratios diretamente dos tokens
// reais e falha se algum par cair abaixo do mínimo AA.
// Fonte de verdade (Tailwind v4 CSS-first): as variáveis `--color-*` do bloco @theme
// em src/index.css — lidas do arquivo para não depender do formato do config.
// Thresholds AA: texto normal ≥4.5:1 · texto grande/componentes de UI ≥3:1.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

// cwd do vitest = raiz do workspace (apps/frontend-vite); o @theme vive em src/index.css.
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

// Mapa token → valor a partir das declarações `--color-NAME: #hex;` do @theme.
const colorVars = new Map<string, string>();
for (const m of css.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
  colorVars.set(m[1], m[2]);
}

// Acesso por nome de token; lança (falha o teste) se o token sumir do @theme.
const c = (token: string): string => {
  const v = colorVars.get(token);
  if (!v) throw new Error(`token --color-${token} não encontrado em src/index.css (@theme)`);
  return v;
};

const channel = (ch: number): number => {
  const s = ch / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const luminance = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};

const ratio = (fg: string, bg: string): number => {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
};

const WHITE = '#ffffff';

describe('Contraste WCAG AA — paleta loginGreen (tela de auth)', () => {
  it.each([
    ['ink / branco', 'loginGreen-ink', WHITE, 4.5],
    ['ink / campo', 'loginGreen-ink', 'loginGreen-field', 4.5],
    ['inkMid / branco (lembrar-me)', 'loginGreen-inkMid', WHITE, 4.5],
    ['inkMuted / branco (links sociais)', 'loginGreen-inkMuted', WHITE, 4.5],
    ['accent / branco (link)', 'loginGreen-accent', WHITE, 4.5],
    ['branco / accent (botão)', WHITE, 'loginGreen-accent', 4.5],
    ['placeholder / campo (texto)', 'loginGreen-placeholder', 'loginGreen-field', 4.5],
    ['placeholder / campo em foco', 'loginGreen-placeholder', 'loginGreen-fieldFocus', 4.5],
    ['inkFaint (ícone olho) / campo (UI 1.4.11)', 'loginGreen-inkFaint', 'loginGreen-field', 3.0],
    ['inkFaint (ícone olho) / campo em foco', 'loginGreen-inkFaint', 'loginGreen-fieldFocus', 3.0],
  ])('%s', (_label, fg, bg, min) => {
    expect(ratio(fg.startsWith('#') ? fg : c(fg), bg.startsWith('#') ? bg : c(bg))).toBeGreaterThanOrEqual(min);
  });
});

describe('Contraste WCAG AA — paleta status (badges/banners)', () => {
  it.each([
    ['error fg / bg', 'status-error-fg', 'status-error-bg', 4.5],
    ['success fg / bg', 'status-success-fg', 'status-success-bg', 4.5],
    ['warning fg / bg', 'status-warning-fg', 'status-warning-bg', 4.5],
    ['info fg / bg', 'status-info-fg', 'status-info-bg', 4.5],
    ['source fg / bg', 'status-source-fg', 'status-source-bg', 4.5],
    ['neutral fg / bg', 'status-neutral-fg', 'status-neutral-bg', 4.5],
    ['branco / error solid (badge crítico)', WHITE, 'status-error-solid', 4.5],
  ])('%s', (_label, fg, bg, min) => {
    expect(ratio(fg.startsWith('#') ? fg : c(fg), bg.startsWith('#') ? bg : c(bg))).toBeGreaterThanOrEqual(min);
  });
});

describe('Contraste WCAG AA — botões brand sólidos (regressão A3-1)', () => {
  // Texto branco em botão deve assentar sobre brand-dark (AA), NUNCA sobre brand sólido
  // (só ~3,4:1). Trava a regressão do achado A3-1 (Dashboard/Consulta seletores + btn-primary).
  it('branco / brand-dark (botão) cumpre AA de texto normal (≥4.5:1)', () => {
    expect(ratio(WHITE, c('brand-dark'))).toBeGreaterThanOrEqual(4.5);
  });
  it('branco / brand sólido REPROVA AA — não usar como fundo de texto branco (<4.5:1)', () => {
    expect(ratio(WHITE, c('brand'))).toBeLessThan(4.5);
  });
});

describe('Contraste WCAG AA — cores gráficas do donut (Dashboard)', () => {
  // Preenchimento de segmento + swatch da legenda sobre card branco: objeto gráfico
  // (1.4.11) exige ≥3:1. Garante que prorrogado/baixado (sem par bg) cumpram o mínimo.
  it.each([
    ['prorrogado / branco', 'status-prorrogado-fg', WHITE, 3],
    ['baixado / branco', 'status-baixado-fg', WHITE, 3],
  ])('%s', (_label, fg, bg, min) => {
    expect(ratio(fg.startsWith('#') ? fg : c(fg), bg.startsWith('#') ? bg : c(bg))).toBeGreaterThanOrEqual(min);
  });
});
