// Guarda de contraste WCAG 2.1 AA para as cores DEFAULT do Tailwind usadas como
// texto/ícone na aplicação (gray/slate/zinc/amber/orange/red/purple…), sobre os
// fundos onde aparecem de fato.
//
// Por que existe: o guarda de tokens (contrast.a11y.test.ts) só cobre as paletas
// próprias do projeto (loginGreen-*, status-*). Mas os componentes pintam muito
// texto secundário com a escala default do Tailwind direto na className
// (text-gray-400, text-slate-400…), que ninguém media — e o axe em jsdom NÃO
// avalia color-contrast. Este arquivo fecha essa lacuna calculando o ratio real
// dos pares (cor, fundo) realmente usados.
//
// Thresholds AA (1.4.3 / 1.4.11): texto normal ≥4.5:1 · texto grande, ícone e
// componente de UI ≥3:1.
//
// IMPORTANTE — "violações conhecidas": os pares que HOJE reprovam estão isolados
// em KNOWN_VIOLATIONS e verificados com `it.fails` (a suíte segue VERDE, mas a
// violação fica registrada). Funciona como ratchet: ao corrigir a cor de um par,
// o `it.fails` correspondente passa a FALHAR — sinal para movê-lo ao bloco de
// aprovados. Não relaxe os thresholds para "esverdear"; corrija a cor.
//
// Nota: os hex default abaixo são os equivalentes sRGB documentados da escala
// Tailwind. A auditoria de contraste sob render real (oklch/P3, foco, autofill)
// continua sendo follow-up via axe em navegador (Playwright/Lighthouse).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

// --- Tokens próprios do projeto (lidos do @theme em src/index.css) ------------
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
const colorVars = new Map<string, string>();
for (const m of css.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
  colorVars.set(m[1], m[2]);
}

// --- Escala default do Tailwind usada na aplicação (sRGB) ---------------------
const TW: Record<string, string> = {
  white: '#ffffff',
  'gray-50': '#f9fafb',
  'gray-400': '#9ca3af',
  'gray-500': '#6b7280',
  'gray-600': '#4b5563',
  'slate-50': '#f8fafc',
  'slate-400': '#94a3b8',
  'slate-500': '#64748b',
  'slate-800': '#1e293b',
  'zinc-50': '#fafafa',
  'amber-50': '#fffbeb',
  'zinc-400': '#a1a1aa',
  'zinc-500': '#71717a',
  'amber-500': '#f59e0b',
  'amber-600': '#d97706',
  'orange-500': '#f97316',
  'orange-600': '#ea580c',
  'red-500': '#ef4444',
  'purple-500': '#a855f7',
};

// Resolve um nome para hex: tenta token do projeto (--color-NAME), depois escala
// default do Tailwind, depois literal #hex.
const hex = (name: string): string => {
  if (name.startsWith('#')) return name;
  return colorVars.get(name) ?? TW[name] ?? raise(`cor desconhecida: ${name}`);
};
const raise = (msg: string): never => {
  throw new Error(msg);
};

const channel = (ch: number): number => {
  const s = ch / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (h: string): number => {
  const n = Number.parseInt(h.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
const ratio = (fg: string, bg: string): number => {
  const a = luminance(hex(fg));
  const b = luminance(hex(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
};

interface Pair {
  fg: string;
  bg: string;
  min: number; // 4.5 texto normal · 3.0 ícone/UI/texto grande
  where: string;
}

// Pares que JÁ cumprem AA — asserção dura (não podem regredir). Cobrem as cores
// para onde as antigas violações foram corrigidas (-400 → -500, amber/orange-500
// → -600, ink-muted → ink-secondary).
const COMPLIANT: Pair[] = [
  { fg: 'gray-500', bg: 'white', min: 4.5, where: 'estado vazio/subtítulos/células (Erros, Emails, Forms, ProtectedRoute)' },
  // Linha erro_api de /erros: o fundo fica em bg-status-error-bg (#fef2f2) em repouso E no hover
  // (o hover passou a ser um ring, não escurece o fundo — o texto vermelho sobre o antigo hover
  // #fecaca dava só 4,47:1). Ambas as células de texto passam AA sobre #fef2f2:
  { fg: 'gray-600', bg: 'status-error-bg', min: 4.5, where: 'nome de arquivo (source_file) na linha erro_api (/erros)' },
  { fg: 'status-error-fg', bg: 'status-error-bg', min: 4.5, where: 'mensagem de erro na linha erro_api (/erros)' },
  { fg: 'slate-500', bg: 'white', min: 4.5, where: 'subtítulo/labels/botões (Consulta, AttachmentViewer, ColumnVisibilityMenu, GridToolbar)' },
  { fg: 'zinc-500', bg: 'white', min: 4.5, where: 'labels e título do painel de detalhe (/emails)' },
  { fg: 'ink-secondary', bg: 'white', min: 4.5, where: 'StatusBadge vazio "—" + fallback de Suspense (App.tsx)' },
  { fg: 'slate-500', bg: 'slate-50', min: 4.5, where: 'texto "Carregando anexo…" sobre o corpo do modal (AttachmentViewer)' },
  // Card de KPI dos dashboards (KpiCard/kpiCard.variants). O hover escurece o card para
  // `bg-slate-50`, então TODO texto do card precisa passar sobre ele — é o que limita a
  // escolha do tom: com `bg-slate-100` o slate-500 cairia a 4,34 e reprovaria.
  { fg: 'slate-500', bg: 'slate-50', min: 4.5, where: 'rótulo/"conta(s)" do card de KPI no hover (dashboards)' },
  { fg: 'slate-800', bg: 'slate-50', min: 4.5, where: 'valor do card de KPI neutro no hover (dashboards)' },
  { fg: 'status-success-fg', bg: 'slate-50', min: 4.5, where: 'valor do card de KPI "Pagas" no hover (dashboards)' },
  { fg: 'status-error-fg', bg: 'slate-50', min: 4.5, where: 'valor do card de KPI "Vencidas" no hover (dashboards)' },
  // Selo "filtrando" do card ativo. Tintar o CARD todo de brand-light foi descartado:
  // derrubaria slate-500 (4,19) e status-success-fg (4,42) abaixo de AA.
  { fg: 'brand-dark', bg: 'brand-light', min: 4.5, where: 'selo "filtrando" do card de KPI ativo (dashboards)' },
  // Anéis do card de KPI — componente de UI (1.4.11, ≥3). São CORES DIFERENTES de
  // propósito: com o mesmo anel nos dois estados, o foco por teclado ficaria invisível
  // sobre o card já ativo (2.4.7).
  { fg: 'brand', bg: 'white', min: 3, where: 'anel do card de KPI ATIVO (dashboards)' },
  { fg: 'brand-dark', bg: 'white', min: 3, where: 'anel de FOCO do card de KPI (dashboards)' },
  { fg: 'amber-600', bg: 'white', min: 3, where: 'ícone KPI "Sem valor" (Erros)' },
  { fg: 'amber-600', bg: 'amber-50', min: 3, where: 'ícone FileWarning "anexo não encontrado" (AttachmentViewer)' },
  { fg: 'orange-600', bg: 'white', min: 3, where: 'ícone KPI "Sem fornecedor" (Erros)' },
];

// Ratchet para dívida futura: ao introduzir (conscientemente) uma cor default de
// baixo contraste, registre-a num array `KNOWN_VIOLATIONS: Pair[]` e verifique-a
// com `it.fails.each(...)` — a suíte segue verde, mas a dívida fica visível e, ao
// corrigir a cor, o `it.fails` passa a falhar, forçando mover o par para COMPLIANT.
// Hoje o array está vazio (todas as violações conhecidas foram corrigidas), então
// o bloco é omitido para não deixar um `it.fails.each([])` morto.

describe('Contraste WCAG AA — cores default do Tailwind em uso (texto/ícone)', () => {
  it.each(COMPLIANT.map((p) => [`${p.fg} / ${p.bg} ≥ ${p.min} — ${p.where}`, p] as const))(
    '%s',
    (_label, p) => {
      expect(ratio(p.fg, p.bg)).toBeGreaterThanOrEqual(p.min);
    },
  );
});
