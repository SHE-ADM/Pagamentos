import { describe, expect, it } from 'vitest';
import { stableOrder } from './stableOrder';

describe('stableOrder', () => {
  it('acrescenta a PK como desempate quando o usuário ordena por uma coluna', () => {
    expect(stableOrder({ column: 'due_date', dir: 'desc', fallback: 'created_at.desc', tiebreak: 'id' }))
      .toBe('due_date.desc,id.desc');
  });

  it('acrescenta a PK também na ordenação PADRÃO (sem clique do usuário)', () => {
    expect(stableOrder({ fallback: 'created_at.desc', tiebreak: 'id' })).toBe('created_at.desc,id.desc');
  });

  it('assume asc quando a direção não é informada', () => {
    expect(stableOrder({ column: 'amount', fallback: 'created_at.desc', tiebreak: 'id' }))
      .toBe('amount.asc,id.asc');
  });

  it('o desempate acompanha a direção da coluna principal', () => {
    expect(stableOrder({ column: 'amount', dir: 'asc', fallback: 'created_at.desc', tiebreak: 'id' }))
      .toBe('amount.asc,id.asc');
    expect(stableOrder({ column: 'amount', dir: 'desc', fallback: 'created_at.desc', tiebreak: 'id' }))
      .toBe('amount.desc,id.desc');
  });

  // O grid de /consulta ordena a coluna "Situação" pelo NOME da dimensão, via a sintaxe
  // de recurso embutido do PostgREST. O ponto do separador NÃO é o primeiro do termo.
  it('preserva a sintaxe de embed e ainda assim desempata', () => {
    expect(stableOrder({
      column: 'status_dim(status_name)', dir: 'asc', fallback: 'created_at.desc', tiebreak: 'id',
    })).toBe('status_dim(status_name).asc,id.asc');
  });

  it('não repete a coluna quando já se ordena pela própria PK', () => {
    expect(stableOrder({ column: 'id', dir: 'desc', fallback: 'created_at.desc', tiebreak: 'id' }))
      .toBe('id.desc');
    expect(stableOrder({ fallback: 'sk_supplier.desc', tiebreak: 'sk_supplier' })).toBe('sk_supplier.desc');
  });

  it('aceita PK que não se chama id', () => {
    expect(stableOrder({ column: 'trade_name', dir: 'asc', fallback: 'sk_supplier.desc', tiebreak: 'sk_supplier' }))
      .toBe('trade_name.asc,sk_supplier.asc');
  });

  // Guarda do INVARIANTE, não do formato: qualquer saída deve conter a PK, senão a
  // paginação por offset volta a ser não-determinística (linha duplicada / linha sumida).
  it('TODA saída carrega a coluna de desempate', () => {
    const casos: Parameters<typeof stableOrder>[0][] = [
      { column: 'due_date', dir: 'desc', fallback: 'created_at.desc', tiebreak: 'id' },
      { column: null, dir: null, fallback: 'created_at.desc', tiebreak: 'id' },
      { column: 'status_dim(status_name)', dir: 'asc', fallback: 'created_at.desc', tiebreak: 'id' },
      { column: 'id', dir: 'asc', fallback: 'created_at.desc', tiebreak: 'id' },
    ];
    for (const caso of casos) {
      const termos = stableOrder(caso).split(',');
      const colunas = termos.map((t) => t.slice(0, t.lastIndexOf('.')));
      expect(colunas).toContain(caso.tiebreak);
    }
  });
});
