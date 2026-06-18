import { describe, it, expect } from 'vitest';
import { parsePaginationTotal } from './supabase';

describe('parsePaginationTotal', () => {
  it('usa a contagem exata do Content-Range (count=exact)', () => {
    expect(parsePaginationTotal('0-19/247', 0, 20, 20)).toEqual({
      total: 247,
      totalIsEstimate: false,
    });
  });

  it('em página interna, mantém a contagem exata', () => {
    expect(parsePaginationTotal('40-59/247', 40, 20, 20)).toEqual({
      total: 247,
      totalIsEstimate: false,
    });
  });

  it('estima "há mais páginas" quando o count é "*/*" e a página veio cheia', () => {
    // offset 0 + 20 itens + 20 (página cheia → projeta a próxima) = 40.
    expect(parsePaginationTotal('*/*', 0, 20, 20)).toEqual({
      total: 40,
      totalIsEstimate: true,
    });
  });

  it('estima quando o count é "0-19/*" (range sem total) e a página veio cheia', () => {
    expect(parsePaginationTotal('0-19/*', 0, 20, 20)).toEqual({
      total: 40,
      totalIsEstimate: true,
    });
  });

  it('na última página (parcial), não projeta página extra', () => {
    // 10 itens (< pageSize) → total = offset 0 + 10, sem +pageSize.
    expect(parsePaginationTotal('0-9/*', 0, 20, 10)).toEqual({
      total: 10,
      totalIsEstimate: true,
    });
  });

  it('sem header Content-Range, estima a partir do offset corrente', () => {
    expect(parsePaginationTotal(null, 40, 20, 20)).toEqual({
      total: 80,
      totalIsEstimate: true,
    });
  });
});
