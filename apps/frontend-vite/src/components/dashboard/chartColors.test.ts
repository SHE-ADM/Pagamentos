// src/components/dashboard/chartColors.test.ts
import { describe, it, expect } from 'vitest';
import { statusColor, paletteColor, tipoColor } from './chartColors';
import { UNCLASSIFIED_LABEL } from './constants';

describe('statusColor', () => {
  it('mapeia o status pela cor semântica e cai no cinza no desconhecido', () => {
    expect(statusColor('pago')).toBe('var(--color-status-success-fg)');
    expect(statusColor('vencido')).toBe('var(--color-status-error-solid)');
    expect(statusColor('status inexistente')).toBe('var(--color-slate-300)');
  });
});

describe('paletteColor', () => {
  it('cicla a paleta e reserva o cinza para "outros"/"não informado"', () => {
    expect(paletteColor('Transporte', 0)).toBe('var(--color-status-info-fg)');
    expect(paletteColor('X', 8)).toBe(paletteColor('X', 0)); // cíclica
    expect(paletteColor('outros', 1)).toBe('var(--color-slate-300)');
    expect(paletteColor('não informado', 2)).toBe('var(--color-slate-300)');
  });
});

describe('tipoColor', () => {
  // O destaque das contas a classificar depende DESTA cor — se ela mudar, a fatia deixa de
  // saltar aos olhos e o donut perde o propósito.
  it('pinta "Sem Definição" de vermelho vivo, em qualquer posição', () => {
    expect(tipoColor(UNCLASSIFIED_LABEL, 0)).toBe('var(--color-status-error-solid)');
    expect(tipoColor(UNCLASSIFIED_LABEL, 5)).toBe('var(--color-status-error-solid)');
  });

  it('não altera as demais fatias (delega à paleta cíclica)', () => {
    expect(tipoColor('Despesas Fixas', 0)).toBe(paletteColor('Despesas Fixas', 0));
    expect(tipoColor('Despesas Variáveis', 1)).toBe(paletteColor('Despesas Variáveis', 1));
    expect(tipoColor('outros', 3)).toBe('var(--color-slate-300)');
  });

  // Com poucas fatias (Fixas/Variáveis/Sem Definição) a paleta não chega ao índice do
  // vermelho escuro — garante que só existe UM vermelho no donut.
  it('não gera um segundo vermelho nas 3 primeiras posições', () => {
    const outras = [0, 1, 2].map((i) => tipoColor('categoria', i));
    expect(outras).not.toContain('var(--color-status-error-solid)');
    expect(outras).not.toContain('var(--color-status-error-fg)');
  });
});
