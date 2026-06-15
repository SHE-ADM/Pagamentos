// Guarda automatizada de contraste WCAG 2.1 AA para as paletas do projeto.
// Complementa os testes *.a11y.test.tsx: o axe em jsdom NÃO avalia color-contrast
// (sem layout/render), então esta suíte calcula os ratios diretamente dos tokens
// reais (lidos de tailwind.config.ts) e falha se algum par cair abaixo do mínimo AA.
// Thresholds AA: texto normal ≥4.5:1 · texto grande/componentes de UI ≥3:1.
import { describe, it, expect } from 'vitest';
import config from '../tailwind.config';

// `satisfies Config` preserva o tipo literal — acesso direto, sem casts.
const lg = config.theme.extend.colors.loginGreen;
const status = config.theme.extend.colors.status;

const channel = (c: number): number => {
  const s = c / 255;
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
    ['ink / branco', lg.ink, WHITE, 4.5],
    ['ink / campo', lg.ink, lg.field, 4.5],
    ['inkMid / branco (lembrar-me)', lg.inkMid, WHITE, 4.5],
    ['inkMuted / branco (links sociais)', lg.inkMuted, WHITE, 4.5],
    ['accent / branco (link)', lg.accent, WHITE, 4.5],
    ['branco / accent (botão)', WHITE, lg.accent, 4.5],
    ['placeholder / campo (texto)', lg.placeholder, lg.field, 4.5],
    ['placeholder / campo em foco', lg.placeholder, lg.fieldFocus, 4.5],
    ['inkFaint (ícone olho) / campo (UI 1.4.11)', lg.inkFaint, lg.field, 3.0],
    ['inkFaint (ícone olho) / campo em foco', lg.inkFaint, lg.fieldFocus, 3.0],
  ])('%s', (_label, fg, bg, min) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(min);
  });
});

describe('Contraste WCAG AA — paleta status (badges/banners)', () => {
  it.each([
    ['error fg / bg', status.error.fg, status.error.bg, 4.5],
    ['success fg / bg', status.success.fg, status.success.bg, 4.5],
    ['warning fg / bg', status.warning.fg, status.warning.bg, 4.5],
    ['info fg / bg', status.info.fg, status.info.bg, 4.5],
    ['source fg / bg', status.source.fg, status.source.bg, 4.5],
    ['neutral fg / bg', status.neutral.fg, status.neutral.bg, 4.5],
    ['branco / error solid (badge crítico)', WHITE, status.error.solid, 4.5],
  ])('%s', (_label, fg, bg, min) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(min);
  });
});
