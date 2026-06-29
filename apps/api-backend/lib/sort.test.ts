import { describe, it, expect } from 'vitest';
import { resolveSort, parseSortParams } from './sort';

const ALLOWED = ['bank_code', 'bank_name'] as const;

describe('resolveSort', () => {
  it('resolve coluna do allowlist (asc por padrão)', () => {
    expect(resolveSort('bank_code', undefined, ALLOWED)).toEqual({ column: 'bank_code', ascending: true });
  });

  it('aplica a direção desc', () => {
    expect(resolveSort('bank_name', 'desc', ALLOWED)).toEqual({ column: 'bank_name', ascending: false });
  });

  it('coluna fora do allowlist → null (usa ordem default)', () => {
    expect(resolveSort('drop_table', 'asc', ALLOWED)).toBeNull();
  });

  it('sort ausente → null', () => {
    expect(resolveSort(undefined, 'asc', ALLOWED)).toBeNull();
  });
});

describe('parseSortParams', () => {
  it('extrai sort + order válidos', () => {
    expect(parseSortParams(new URLSearchParams('sort=bank_code&order=desc'))).toEqual({
      sort: 'bank_code',
      order: 'desc',
    });
  });

  it('order inválido vira undefined', () => {
    expect(parseSortParams(new URLSearchParams('sort=bank_code&order=xyz'))).toEqual({
      sort: 'bank_code',
      order: undefined,
    });
  });

  it('sem params → ambos undefined', () => {
    expect(parseSortParams(new URLSearchParams(''))).toEqual({ sort: undefined, order: undefined });
  });
});
