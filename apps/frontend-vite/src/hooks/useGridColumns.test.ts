import { describe, it, expect, vi } from 'vitest';
import type { FinancialAccountControl } from '@sheild/shared';
import { getConsultaColumns } from './useGridColumns';

// Colunas de /consulta: metadados puros (sem render de React). O foco aqui é a coluna
// "Empresa" (company.trade_name via FK sk_company) e a POSIÇÃO pedida pelo usuário —
// visível após "Emissão" e antes de "Fornecedor".

const columns = () => getConsultaColumns(vi.fn(), vi.fn());

const row = (over: Partial<FinancialAccountControl> = {}) =>
  ({ id: 1, ...over }) as FinancialAccountControl;

describe('getConsultaColumns — coluna Empresa', () => {
  it('existe e renderiza company.trade_name', () => {
    const col = columns().find((c) => c.key === 'company');
    expect(col?.header).toBe('Empresa');
    expect(col?.render?.(row({ company: { trade_name: 'LEBIANCO' } }))).toBe('LEBIANCO');
  });

  it('sem empresa embutida → travessão (não quebra)', () => {
    const col = columns().find((c) => c.key === 'company');
    expect(col?.render?.(row())).toBe('—');
    expect(col?.render?.(row({ company: null }))).toBe('—');
  });

  it('fica DEPOIS de Emissão e ANTES de Fornecedor', () => {
    const headers = columns().map((c) => c.header);
    const emissao = headers.indexOf('Emissão');
    const empresa = headers.indexOf('Empresa');
    const fornecedor = headers.indexOf('Fornecedor');
    expect(emissao).toBeGreaterThanOrEqual(0);
    expect(empresa).toBe(emissao + 1);
    expect(fornecedor).toBe(empresa + 1);
  });

  it('ordena server-side pelo embed do PostgREST (mesmo padrão do fornecedor)', () => {
    const cols = columns();
    expect(cols.find((c) => c.key === 'company')?.sortKey).toBe('company(trade_name)');
    expect(cols.find((c) => c.key === 'supplier_name')?.sortKey).toBe('supplier(trade_name)');
  });

  it('Empresa e Fornecedor são colunas distintas — a conta pode ser da LEBIANCO com fornecedor OTIMOTEX', () => {
    const r = row({
      company: { trade_name: 'LEBIANCO' },
      supplier: { trade_name: 'OTIMOTEX', legal_name: null, cnpj: null, cpf: null },
    });
    const cols = columns();
    expect(cols.find((c) => c.key === 'company')?.render?.(r)).toBe('LEBIANCO');
    expect(cols.find((c) => c.key === 'supplier_name')?.render?.(r)).toBe('OTIMOTEX');
  });
});
