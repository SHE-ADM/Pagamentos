import { describe, it, expect, vi } from 'vitest';
import type { FinancialAccountControl } from '@sheild/shared';
import { getConsultaColumns } from './useGridColumns';

// Colunas de /consulta: metadados puros (sem render de React). O foco aqui é a coluna
// "Empresa" (company.trade_name via FK sk_company) e a POSIÇÃO pedida pelo usuário —
// logo APÓS "Fornecedor" (mesma ordem do card de detalhe e do ContaForm).

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

  it('fica logo DEPOIS de Fornecedor', () => {
    const headers = columns().map((c) => c.header);
    const emissao = headers.indexOf('Emissão');
    const fornecedor = headers.indexOf('Fornecedor');
    const empresa = headers.indexOf('Empresa');
    expect(emissao).toBeGreaterThanOrEqual(0);
    expect(fornecedor).toBe(emissao + 1);
    expect(empresa).toBe(fornecedor + 1);
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

  // WIRING da coluna Fornecedor com fmtSupplierName. Sem um caso de nomes DIVERGENTES, o
  // render podia voltar a mostrar só o fantasia sem nada ficar vermelho: as fixturas acima
  // usam legal_name null ou igual ao fantasia, e nesses casos o código novo e o antigo dão
  // o MESMO resultado. Medido: o mutante `fmtSupplierName(r.supplier).split(' · ')[0]`
  // passava 748/748 testes e typecheck limpo. Os testes de format.test.ts não cobrem isto —
  // são da função pura; este é o call site.
  it('Fornecedor mostra fantasia + razão social quando DIVERGEM (marca × razão social)', () => {
    const r = row({
      supplier: {
        trade_name: 'PEGAMIL',
        legal_name: 'ITW PPF BRASIL ADESIVOS LTDA',
        cnpj: null,
        cpf: null,
      },
    });
    expect(columns().find((c) => c.key === 'supplier_name')?.render?.(r)).toBe(
      'PEGAMIL · ITW PPF BRASIL ADESIVOS LTDA',
    );
  });

  it('Fornecedor NÃO repete a razão social quando um nome contém o outro', () => {
    const r = row({
      supplier: {
        trade_name: 'CIPATEX',
        legal_name: 'CIPATEX IMPREGNADORA DE PAPEIS E TECIDOS LTDA',
        cnpj: null,
        cpf: null,
      },
    });
    expect(columns().find((c) => c.key === 'supplier_name')?.render?.(r)).toBe('CIPATEX');
  });
});
