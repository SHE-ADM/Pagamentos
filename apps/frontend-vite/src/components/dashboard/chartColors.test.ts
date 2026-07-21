// src/components/dashboard/chartColors.test.ts
// Cobertura das cores dos donuts — as funções existiam desde a criação dos dashboards sem
// nenhum teste. Não cobre a fatia "Sem Definição" (revertida em 04bbd53): `tipoColor` não
// existe mais.
import { describe, it, expect } from 'vitest';
import { statusColor, paletteColor } from './chartColors';

describe('statusColor', () => {
  it('mapeia cada status conhecido para a sua cor semântica', () => {
    expect(statusColor('pago')).toBe('var(--color-status-success-fg)');
    expect(statusColor('a vencer')).toBe('var(--color-status-info-fg)');
    expect(statusColor('vencido')).toBe('var(--color-status-error-solid)');
    expect(statusColor('protestado')).toBe('var(--color-status-error-fg)');
  });

  // Status novo na dimensão (o cadastro cresce sem o front saber) não pode quebrar o donut.
  it('cai no cinza neutro para status desconhecido', () => {
    expect(statusColor('status que ainda não existe')).toBe('var(--color-slate-300)');
    expect(statusColor('')).toBe('var(--color-slate-300)');
  });
});

describe('paletteColor', () => {
  it('percorre a paleta pelo índice da fatia', () => {
    expect(paletteColor('Transporte', 0)).toBe('var(--color-status-info-fg)');
    expect(paletteColor('Folha', 1)).toBe('var(--color-status-success-fg)');
  });

  // Donut com mais fatias que a paleta reusa as cores em vez de devolver undefined.
  it('é cíclica', () => {
    expect(paletteColor('X', 8)).toBe(paletteColor('X', 0));
    expect(paletteColor('X', 9)).toBe(paletteColor('X', 1));
  });

  // "outros" e "não informado" são baldes de resto (breakdownBy) — não competem
  // visualmente com as categorias reais.
  it('reserva o cinza para os baldes de resto, em qualquer posição', () => {
    expect(paletteColor('outros', 1)).toBe('var(--color-slate-300)');
    expect(paletteColor('não informado', 5)).toBe('var(--color-slate-300)');
  });

  // Toda cor sai como token do @theme: hex hardcoded fura o design system e escapa dos
  // guardas de contraste, que leem os tokens do index.css.
  it('devolve sempre um token var(--color-*), nunca hex', () => {
    const amostras = [...Array(10).keys()].map((i) => paletteColor(`c${i}`, i));
    for (const c of [...amostras, statusColor('pago'), statusColor('desconhecido')]) {
      expect(c).toMatch(/^var\(--color-[a-z0-9-]+\)$/);
    }
  });
});
