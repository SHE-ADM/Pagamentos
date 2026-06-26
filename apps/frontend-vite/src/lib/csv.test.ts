import { describe, it, expect } from 'vitest';
import { csvCell } from './csv';

describe('csvCell', () => {
  it('neutraliza injeção de fórmula (= + - @) prefixando com aspa simples', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell('+1+1')).toBe('"\'+1+1"');
    expect(csvCell('-2')).toBe('"\'-2"');
    expect(csvCell('@SUM(A1)')).toBe('"\'@SUM(A1)"');
  });

  it('mantém valor legítimo intacto (sem prefixo)', () => {
    expect(csvCell('Nota 123')).toBe('"Nota 123"');
    expect(csvCell(1250.5)).toBe('"1250.5"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });

  it('escapa aspas e remove quebras de linha internas', () => {
    expect(csvCell('a "b" c')).toBe('"a ""b"" c"');
    expect(csvCell('linha1\r\nlinha2')).toBe('"linha1 linha2"');
  });
});
