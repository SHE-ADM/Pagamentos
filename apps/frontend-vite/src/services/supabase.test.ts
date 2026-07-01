import { describe, it, expect } from 'vitest';
import { parsePaginationTotal, parseBrlAmount, isCurrencyValueSearch } from './supabase';

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

describe('parseBrlAmount', () => {
  it('interpreta valor BR com vírgula decimal', () => {
    expect(parseBrlAmount('463,21')).toBe('463.21');
  });

  it('interpreta valor BR com separador de milhar', () => {
    expect(parseBrlAmount('44.406,08')).toBe('44406.08');
    expect(parseBrlAmount('1.481.187,28')).toBe('1481187.28');
  });

  it('interpreta número inteiro simples', () => {
    expect(parseBrlAmount('391')).toBe('391');
  });

  it('interpreta ponto como separador decimal', () => {
    expect(parseBrlAmount('463.21')).toBe('463.21');
  });

  it('ignora espaços ao redor', () => {
    expect(parseBrlAmount('  463,21  ')).toBe('463.21');
  });

  it('aceita o símbolo "R$" (3 formas) como busca por valor', () => {
    expect(parseBrlAmount('R$ 1.999,99')).toBe('1999.99'); // com milhar
    expect(parseBrlAmount('R$ 1999,99')).toBe('1999.99'); // sem milhar
    expect(parseBrlAmount('R$1999,99')).toBe('1999.99'); // sem espaço
    expect(parseBrlAmount('R$ 391')).toBe('391'); // inteiro
  });

  it('retorna null para termo não-numérico', () => {
    expect(parseBrlAmount('ACME')).toBeNull();
    expect(parseBrlAmount('00019/112')).toBeNull();
    expect(parseBrlAmount('')).toBeNull();
    expect(parseBrlAmount('R$')).toBeNull(); // só o símbolo, sem número
    expect(parseBrlAmount('R$ abc')).toBeNull();
  });
});

describe('isCurrencyValueSearch', () => {
  it('true quando há "R$" e um valor válido (busca por valor do documento)', () => {
    expect(isCurrencyValueSearch('R$ 1.999,99')).toBe(true);
    expect(isCurrencyValueSearch('R$1999,99')).toBe(true);
    expect(isCurrencyValueSearch('r$ 391')).toBe(true);
  });

  it('false sem "R$" (mesmo numérico) ou sem valor válido', () => {
    expect(isCurrencyValueSearch('1999,99')).toBe(false); // número sem R$ → busca textual+valor
    expect(isCurrencyValueSearch('R$ abc')).toBe(false); // R$ sem número
    expect(isCurrencyValueSearch('ACME')).toBe(false);
  });
});
