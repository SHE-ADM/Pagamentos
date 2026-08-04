import { describe, it, expect } from 'vitest';
import { fmtDate, fmtDateTime, fmtMoney, fmtCnpj, fmtCpf, fmtCostCenter, fmtChartAccount, fmtChartAccountFull, fmtSupplierName } from './format';
import type { FinancialAccountControl } from '@sheild/shared';

describe('format', () => {
  it('fmtDate: YYYY-MM-DD → dd/mm/aaaa; vazio → —', () => {
    expect(fmtDate('2026-06-26')).toBe('26/06/2026');
    expect(fmtDate(null)).toBe('—');
  });

  it('fmtDateTime: ISO → dd/mm/aaaa hh:mm; vazio → —', () => {
    // Componha um ISO local para não depender do fuso do CI na asserção de data.
    const out = fmtDateTime('2026-06-26T10:30:00');
    expect(out).toMatch(/26\/06\/2026/);
    expect(out).toMatch(/\d{2}:\d{2}/);
    expect(fmtDateTime(null)).toBe('—');
  });

  it('fmtMoney: número → BRL; null → —', () => {
    expect(fmtMoney(1250.5)).toMatch(/1\.250,50/);
    expect(fmtMoney(null)).toBe('—');
  });

  it('fmtCnpj: 14 dígitos → máscara; fora do formato → original/—', () => {
    expect(fmtCnpj('11222333000181')).toBe('11.222.333/0001-81');
    expect(fmtCnpj('123')).toBe('123');
    expect(fmtCnpj(null)).toBe('—');
  });

  it('fmtCpf: 11 dígitos → máscara; fora do formato → original/—', () => {
    expect(fmtCpf('12345678901')).toBe('123.456.789-01');
    expect(fmtCpf(null)).toBe('—');
  });

  it('fmtCostCenter/fmtChartAccount: id 0 (sentinela) → —; com embed → código — descrição', () => {
    const base = { cost_center_id: 0, chart_account_id: 0 } as unknown as FinancialAccountControl;
    expect(fmtCostCenter(base)).toBe('—');
    expect(fmtChartAccount(base)).toBe('—');

    const withEmbed = {
      cost_center_id: 5,
      cost_center: { cost_center_code: 'CC1', cost_center_description: 'Administrativo' },
      chart_account_id: 10,
      chart_account: { account_code: '1.1', account_description: 'Caixa' },
    } as unknown as FinancialAccountControl;
    expect(fmtCostCenter(withEmbed)).toBe('CC1 — Administrativo');
    expect(fmtChartAccount(withEmbed)).toBe('1.1 — Caixa');
  });

  it('fmtChartAccountFull: concatena plano + grupo + subgrupo + centro de custo (partes ausentes omitidas)', () => {
    const full = {
      cost_center_id: 5,
      cost_center: { cost_center_code: 'CC1', cost_center_description: 'Administrativo' },
      chart_account_id: 10,
      chart_account: {
        account_code: '1.1.01',
        account_description: 'Fornecedores',
        group: { group_code: '1', group_description: 'Passivo' },
        subgroup: { subgroup_code: '1.1', subgroup_description: 'Circulante' },
      },
    } as unknown as FinancialAccountControl;
    expect(fmtChartAccountFull(full)).toBe(
      '1.1.01 — Fornecedores · 1 — Passivo · 1.1 — Circulante · CC1 — Administrativo',
    );

    // Sem plano nem centro (id 0) → '—'.
    const none = { cost_center_id: 0, chart_account_id: 0 } as unknown as FinancialAccountControl;
    expect(fmtChartAccountFull(none)).toBe('—');

    // Plano sem grupo/subgrupo (embeds ausentes) + centro presente → só as partes existentes.
    const partial = {
      cost_center_id: 5,
      cost_center: { cost_center_code: 'CC1', cost_center_description: 'Administrativo' },
      chart_account_id: 10,
      chart_account: { account_code: '1.1', account_description: 'Caixa' },
    } as unknown as FinancialAccountControl;
    expect(fmtChartAccountFull(partial)).toBe('1.1 — Caixa · CC1 — Administrativo');
  });
});

describe('fmtSupplierName — fantasia + razão social quando divergem', () => {
  it('concatena quando os nomes são distintos (caso PEGAMIL / ITW PPF)', () => {
    expect(
      fmtSupplierName({ trade_name: 'PEGAMIL', legal_name: 'ITW PPF BRASIL ADESIVOS LTDA' }),
    ).toBe('PEGAMIL · ITW PPF BRASIL ADESIVOS LTDA');
  });

  it('mostra só o fantasia quando um nome CONTÉM o outro', () => {
    // Repetir "CIPATEX" dentro da razão social seria poluição sem ganho.
    expect(
      fmtSupplierName({
        trade_name: 'CIPATEX',
        legal_name: 'CIPATEX IMPREGNADORA DE PAPEIS E TECIDOS LTDA',
      }),
    ).toBe('CIPATEX');
  });

  it('trata nomes idênticos como um só', () => {
    expect(
      fmtSupplierName({ trade_name: 'ARLETE TRANSPORTES LTDA', legal_name: 'ARLETE TRANSPORTES LTDA' }),
    ).toBe('ARLETE TRANSPORTES LTDA');
  });

  it('ignora acento, caixa e pontuação na comparação', () => {
    // "S/A" × "SA" e maiúsculas/minúsculas não podem contar como nomes diferentes.
    expect(fmtSupplierName({ trade_name: 'Seguros Sura', legal_name: 'SEGUROS SURA S/A' })).toBe(
      'Seguros Sura',
    );
    expect(fmtSupplierName({ trade_name: 'CONFECÇÕES', legal_name: 'Confeccoes' })).toBe('CONFECÇÕES');
  });

  it('usa o nome existente quando só um está preenchido', () => {
    expect(fmtSupplierName({ trade_name: 'ACME', legal_name: null })).toBe('ACME');
    expect(fmtSupplierName({ trade_name: null, legal_name: 'ACME LTDA' })).toBe('ACME LTDA');
    expect(fmtSupplierName({ trade_name: '   ', legal_name: 'ACME LTDA' })).toBe('ACME LTDA');
  });

  it('devolve — sem fornecedor', () => {
    expect(fmtSupplierName(null)).toBe('—');
    expect(fmtSupplierName(undefined)).toBe('—');
    expect(fmtSupplierName({ trade_name: null, legal_name: null })).toBe('—');
  });

  it('não engole a razão social quando o fantasia é só pontuação', () => {
    // Normalização vazia cairia em includes('') === true e esconderia a razão social.
    expect(fmtSupplierName({ trade_name: '- -', legal_name: 'ACME LTDA' })).toBe('- - · ACME LTDA');
  });
});
