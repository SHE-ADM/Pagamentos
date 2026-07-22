import { describe, it, expect, vi } from 'vitest';
import { TYPE_GROUP_ID_DESPESA_FIXA, TYPE_GROUP_ID_DESPESA_VARIAVEL, TYPE_GROUP_ID_CUSTO_MERCADORIAS } from '@sheild/shared';

// O módulo importa o client (auth) no topo — mock leve, os testes aqui são 100% puros.
vi.mock('../lib/supabaseClient', () => ({
  supabase: { auth: { getSession: vi.fn() } },
}));

import { filterExpenseDetailRows, topBucketLabels, type ExpenseDetailRow } from './supabase';

type Opts = {
  ccId?: number; ccDesc?: string; ccCode?: string;
  sgId?: number | null; sgDesc?: string; sgCode?: string;
  tipoId?: number; tipoDesc?: string;
  groupDesc?: string;
};

// Constrói uma linha de despesa (group.type_group_id=2 = Natureza Despesas) para o matcher.
let seq = 0;
const mkRow = (amount: number, o: Opts = {}): ExpenseDetailRow => ({
  id: ++seq,
  amount,
  status_id: 3,
  due_date: '2026-07-10',
  cost_center_id: o.ccId ?? 0,
  supplier: { trade_name: 'Fornecedor X', legal_name: null },
  cost_center: o.ccId
    ? { cost_center_code: o.ccCode ?? String(o.ccId), cost_center_description: o.ccDesc ?? `Centro ${o.ccId}` }
    : { cost_center_code: null, cost_center_description: null },
  chart_account: {
    account_code: '1.1', account_description: 'Conta',
    group: { group_description: o.groupDesc ?? 'Grupo', type_group_id: 2 },
    subgroup: o.sgId == null ? null : {
      chart_account_subgroup_id: o.sgId,
      subgroup_code: o.sgCode ?? String(o.sgId),
      subgroup_description: o.sgDesc ?? `Subgrupo ${o.sgId}`,
      type_group: {
        type_group_id: o.tipoId ?? TYPE_GROUP_ID_DESPESA_FIXA,
        type_group_description: o.tipoDesc ?? 'Despesas Fixas',
      },
    },
  },
});

const F = TYPE_GROUP_ID_DESPESA_FIXA;       // 5
const V = TYPE_GROUP_ID_DESPESA_VARIAVEL;   // 6
const CM = TYPE_GROUP_ID_CUSTO_MERCADORIAS; // 7

describe('filterExpenseDetailRows — donut "Tipo"', () => {
  it('retorna só as linhas do type_group_description clicado', () => {
    const rows = [
      mkRow(100, { tipoId: F, tipoDesc: 'Despesas Fixas', sgId: 1 }),
      mkRow(200, { tipoId: V, tipoDesc: 'Despesas Variáveis', sgId: 2 }),
      mkRow(50, { tipoId: F, tipoDesc: 'Despesas Fixas', sgId: 1 }),
    ];
    const fixas = filterExpenseDetailRows(rows, { chart: 'tipo', label: 'Despesas Fixas' });
    expect(fixas.map((r) => r.amount)).toEqual([100, 50]);
  });
});

describe('filterExpenseDetailRows — donuts por GRUPO recortados pelo tipo (grupoTipo)', () => {
  const rows = [
    mkRow(100, { tipoId: F, groupDesc: 'Folha', sgId: 1 }),
    mkRow(300, { tipoId: F, groupDesc: 'Serviços', sgId: 2 }),
    mkRow(999, { tipoId: V, groupDesc: 'Folha', sgId: 3 }), // MESMO grupo, mas VARIÁVEL
    mkRow(777, { tipoId: CM, groupDesc: 'Custos', sgId: 4, tipoDesc: 'Custos de Mercadorias' }),
  ];
  it('FIXA: só o grupo clicado E do tipo 5 (não vaza a linha variável de mesmo grupo)', () => {
    const out = filterExpenseDetailRows(rows, { chart: 'grupoTipo', typeGroupId: F, label: 'Folha' });
    expect(out.map((r) => r.amount)).toEqual([100]);
  });
  it('VARIÁVEL: só o grupo clicado E do tipo 6', () => {
    const out = filterExpenseDetailRows(rows, { chart: 'grupoTipo', typeGroupId: V, label: 'Folha' });
    expect(out.map((r) => r.amount)).toEqual([999]);
  });
  it('CUSTO DE MERCADORIAS: só o grupo clicado E do tipo 7', () => {
    const out = filterExpenseDetailRows(rows, { chart: 'grupoTipo', typeGroupId: CM, label: 'Custos' });
    expect(out.map((r) => r.amount)).toEqual([777]);
  });
  it('sem typeGroupId, não casa nada (guarda contra alvo malformado)', () => {
    // A linha SEM subgrupo é o caso que fura sem a guarda: tipoOf() devolve undefined e
    // `undefined === undefined` casaria — o ramo "outros" devolveria as não-classificadas.
    const comSemSubgrupo = [...rows, mkRow(555, { sgId: null, groupDesc: 'Folha' })];
    expect(filterExpenseDetailRows(comSemSubgrupo, { chart: 'grupoTipo', label: 'Folha' })).toEqual([]);
    expect(filterExpenseDetailRows(comSemSubgrupo, { chart: 'grupoTipo', label: 'outros' })).toEqual([]);
  });
});

describe('filterExpenseDetailRows — ranking de centros de custo (bucketKey)', () => {
  const rows = [
    mkRow(100, { ccId: 1, ccDesc: 'Compras', sgId: 1 }),
    mkRow(200, { ccId: 4, ccDesc: 'Logística', sgId: 1 }),
    mkRow(30, { ccId: 0, sgId: 1 }),  // sentinela → '∅'
  ];
  it('casa a linha pelo bucketKey cc:<id>', () => {
    expect(filterExpenseDetailRows(rows, { chart: 'costCenter', bucketKey: 'cc:1' }).map((r) => r.amount)).toEqual([100]);
    expect(filterExpenseDetailRows(rows, { chart: 'costCenter', bucketKey: 'cc:4' }).map((r) => r.amount)).toEqual([200]);
  });
  it('bucketKey "∅" casa a linha do sentinela (id 0)', () => {
    expect(filterExpenseDetailRows(rows, { chart: 'costCenter', bucketKey: '∅' }).map((r) => r.amount)).toEqual([30]);
  });
});

describe('filterExpenseDetailRows — ranking de contas / subgrupo (bucketKey)', () => {
  const rows = [
    mkRow(100, { sgId: 11, sgDesc: 'Compras de Mercadorias' }),
    mkRow(200, { sgId: 22, sgDesc: 'Transportadoras' }),
    mkRow(30, { sgId: 0 }),      // sentinela → '∅'
    mkRow(40, { sgId: null }),   // sem subgrupo → '∅'
    mkRow(50, { sgId: 33, sgDesc: '   ' }), // descrição vazia → '∅' (mesma regra do rankEntry)
  ];
  it('casa a linha pelo bucketKey sg:<id>', () => {
    expect(filterExpenseDetailRows(rows, { chart: 'subgroup', bucketKey: 'sg:11' }).map((r) => r.amount)).toEqual([100]);
  });
  it('bucketKey "∅" casa sentinela id 0, subgrupo ausente E descrição vazia', () => {
    expect(filterExpenseDetailRows(rows, { chart: 'subgroup', bucketKey: '∅' }).map((r) => r.amount ?? 0).sort((a, b) => a - b)).toEqual([30, 40, 50]);
  });
});

describe('topBucketLabels + fatia "outros" (DONUT_TOP_N=6 — no máx. 7 linhas visíveis)', () => {
  // 6 grupos com 2 contas (tipo FIXA) + 3 grupos com 1 conta cada → os de MENOR valor
  // (G7/G8/G9 — aqui valor e contagem coincidem, mesmo r$ por linha) caem em "outros".
  // Top-6 + 1 fatia "outros" = 7 linhas, nunca mais que isso.
  const rows: ExpenseDetailRow[] = [];
  for (let g = 1; g <= 6; g++) { rows.push(mkRow(10, { tipoId: F, groupDesc: `G${g}`, sgId: g }), mkRow(10, { tipoId: F, groupDesc: `G${g}`, sgId: g })); }
  for (let g = 7; g <= 9; g++) { rows.push(mkRow(10, { tipoId: F, groupDesc: `G${g}`, sgId: g })); }

  it('topBucketLabels devolve os 6 rótulos de maior VALOR (G7/G8/G9 ficam de fora)', () => {
    const top = topBucketLabels(rows, (r) => r.chart_account?.group?.group_description ?? null);
    expect(top.size).toBe(6);
    expect(top.has('G1')).toBe(true);
    expect(top.has('G7')).toBe(false);
  });
  it('clicar numa fatia própria retorna só aquele grupo', () => {
    expect(filterExpenseDetailRows(rows, { chart: 'grupoTipo', typeGroupId: F, label: 'G1' })).toHaveLength(2);
  });
  it('clicar em "outros" retorna o COMPLEMENTO (os grupos fora do top-6)', () => {
    const outros = filterExpenseDetailRows(rows, { chart: 'grupoTipo', typeGroupId: F, label: 'outros' });
    expect(outros).toHaveLength(3);
    expect(outros.map((r) => r.chart_account?.group?.group_description).sort()).toEqual(['G7', 'G8', 'G9']);
  });
});

describe('topBucketLabels — seleção é por VALOR (R$), NUNCA por contagem (bug real corrigido 2026-07-22)', () => {
  // Reproduz o caso real: grupo "Serviços Gerais" com POUCAS contas (2) de valor ALTO
  // (R$ 20.000) contra 6 grupos com MUITAS contas (5 cada) de valor BAIXO (R$ 1.000 cada).
  // Por CONTAGEM, "Serviços Gerais" (2) perderia para os 6 grupos (5 cada) e cairia em
  // "outros" — o bug real: a conta da PANIFICADORA BELGA (fornecedor, R$ 20.100,80, grupo
  // "Serviços Gerais" / subgrupo "Copa e Cozinha", corretamente classificado como Despesas
  // Fixas) aparecia em "outros" só por isso, não por erro de relacionamento/join. Por VALOR
  // (o critério correto — o donut ordena/dimensiona as fatias por R$), "Serviços Gerais"
  // deve SOBREVIVER ao corte do top-6.
  const rows: ExpenseDetailRow[] = [
    mkRow(10000, { tipoId: F, groupDesc: 'Serviços Gerais', sgId: 70 }),
    mkRow(10000, { tipoId: F, groupDesc: 'Serviços Gerais', sgId: 70 }),
  ];
  for (let g = 1; g <= 6; g++) {
    for (let i = 0; i < 5; i++) rows.push(mkRow(200, { tipoId: F, groupDesc: `Grupo Barato ${g}`, sgId: 100 + g }));
  }

  it('"Serviços Gerais" (2 contas, R$ 20 mil) entra no top-6 — NÃO cai em "outros"', () => {
    const pick = (r: ExpenseDetailRow): string | null => r.chart_account?.group?.group_description ?? null;
    const top = topBucketLabels(rows, pick);
    expect(top.has('Serviços Gerais')).toBe(true);
  });

  it('o drill de "Serviços Gerais" devolve as 2 contas — não fica escondido em "outros"', () => {
    const out = filterExpenseDetailRows(rows, { chart: 'grupoTipo', typeGroupId: F, label: 'Serviços Gerais' });
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.chart_account?.group?.group_description === 'Serviços Gerais')).toBe(true);
  });
});
