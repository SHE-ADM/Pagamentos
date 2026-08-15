// src/services/dashboard.test.ts
// KPIs do dashboard de VENCIMENTOS (getDashboardData). Existia teste só do dashboard
// financeiro; como os dois passaram a compartilhar `computeKpis`, um erro na regra
// quebraria as duas telas — este arquivo cobre o helper pelo segundo consumidor.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { STATUS_ID_PAGO, STATUS_ID_A_VENCER, STATUS_ID_VENCIDO } from '@sheild/shared';
import { isoDaysFromToday } from '../lib/format';

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'tok' } } }) },
  },
}));

import { getDashboardData } from './supabase';

// Datas relativas a HOJE: o KPI "a vencer em 7 dias" compara com a data corrente, então
// fixar '2026-01-10' faria o teste passar hoje e falhar amanhã.
const iso = (offsetDias: number): string =>
  new Date(Date.now() + offsetDias * 86400000).toISOString().slice(0, 10);

type Row = {
  id: number; amount: number; status_id: number; due_date: string;
  document_type: string | null; payment_method: string | null; description: string | null;
  supplier: { trade_name: string | null; legal_name: string | null } | null;
};

const row = (id: number, amount: number, status_id: number, due_date: string): Row => ({
  id, amount, status_id, due_date,
  document_type: 'boleto', payment_method: 'boleto', description: null,
  supplier: { trade_name: 'Fornecedor', legal_name: null },
});

const ROWS: Row[] = [
  row(1, 100, STATUS_ID_PAGO, iso(-10)),
  row(2, 200, STATUS_ID_A_VENCER, iso(3)), // dentro da janela de 7 dias
  row(3, 400, STATUS_ID_A_VENCER, iso(20)), // a vencer, FORA da janela
  row(4, 50, STATUS_ID_VENCIDO, iso(-2)),
];

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(ROWS) })));
});

describe('getDashboardData — KPIs', () => {
  it('soma valor e contagem por situação', async () => {
    const d = await getDashboardData(new Date().getMonth(), new Date().getFullYear());
    expect(d.kpis).toMatchObject({
      totalCount: 4, totalValue: 750,
      pagoCount: 1, pagoValue: 100,
      aVencerCount: 2, aVencerValue: 600,
      vencidasCount: 1, vencidasValue: 50,
    });
  });

  // A regra mais fácil de quebrar: exige situação "a vencer" E vencimento na janela.
  // Um vencido de ontem não entra (situação errada) e um a vencer em 20 dias também não.
  it('"a vencer em 7 dias" é subconjunto de "a vencer", limitado pela janela', async () => {
    const d = await getDashboardData(new Date().getMonth(), new Date().getFullYear());
    expect(d.kpis.vencendoCount).toBe(1);
    expect(d.kpis.vencendoValue).toBe(200);
    expect(d.kpis.vencendoCount).toBeLessThanOrEqual(d.kpis.aVencerCount);
  });

  // Clicar num card filtra os GRÁFICOS, nunca os cards — senão o dashboard se zeraria a
  // cada clique. Comportamento compartilhado com o dashboard financeiro.
  it('o filtro de KPI não altera os cards', async () => {
    const semFiltro = await getDashboardData(new Date().getMonth(), new Date().getFullYear(), 'month', 'total');
    const filtrado = await getDashboardData(new Date().getMonth(), new Date().getFullYear(), 'month', 'pago');
    expect(filtrado.kpis).toEqual(semFiltro.kpis);
    // ...mas o gráfico de situação passa a ter só a fatia filtrada.
    expect(filtrado.statusBreakdown.map((s) => s.status)).toEqual(['pago']);
  });
});

/**
 * BORDA da janela "a vencer em 7 dias" — o que os casos acima NÃO travavam.
 *
 * Medido por mutante contra a versão anterior deste arquivo: deslocar a janela inteira em
 * +1 dia (o efeito exato do viés de fuso) ou alargar a borda superior de +7 para +19
 * deixava os 3 casos VERDES. Eles fixam a largura grosseira da janela e nada mais, porque
 * as fixtures usam offsets −10/+3/+20/−2 — nenhum na borda — e derivam da MESMA aritmética
 * que a função sob teste (`toISOString()` + `Date.now() + n*86400000`).
 *
 * Duas metades, e as duas são necessárias:
 *  • as BORDAS (0, +7, +8, −1) travam erro de largura em QUALQUER fuso;
 *  • o RELÓGIO FIXADO às 23h30 locais é o que expõe o viés de fuso — nesse instante a data
 *    em UTC já é a de amanhã em qualquer fuso negativo (o da máquina de dev é UTC−3).
 *
 * ⚠️ Num runner em UTC as duas implementações coincidem por construção, então lá este caso
 * não distingue fuso — o que ele continua travando em qualquer lugar são as bordas. Não é
 * buraco silencioso: é o limite honesto do que dá para observar sem forçar `TZ` no runner.
 */
describe('getDashboardData — borda da janela "a vencer em 7 dias"', () => {
  // Valores em potências de 2: qualquer subconjunto tem soma única, então `vencendoValue`
  // identifica EXATAMENTE quais linhas entraram. A contagem sozinha não serve — uma janela
  // deslocada um dia perde a de hoje e ganha a de hoje+8, mantendo o total em 2.
  const DENTRO_HOJE = 10;
  const DENTRO_D7 = 20;

  let borda: Row[] = [];

  beforeEach(() => {
    // `toFake: ['Date']` de propósito: fingir os timers inteiros penduraria os `await` de
    // `getDashboardData`, que é async.
    vi.useFakeTimers({ toFake: ['Date'] });
    const noite = new Date();
    noite.setHours(23, 30, 0, 0); // 23h30 LOCAL, seja qual for o fuso do runner
    vi.setSystemTime(noite);

    // Construídas DEPOIS de fixar o relógio, e com o helper LOCAL — nunca com a aritmética
    // da função sob teste, senão fixture e código erram juntos e o teste fica cego.
    borda = [
      row(1, DENTRO_HOJE, STATUS_ID_A_VENCER, isoDaysFromToday(0)),  // vence HOJE  → DENTRO
      row(2, DENTRO_D7, STATUS_ID_A_VENCER, isoDaysFromToday(7)),    // último dia  → DENTRO
      row(3, 40, STATUS_ID_A_VENCER, isoDaysFromToday(8)),           // 1 dia além  → FORA
      row(4, 80, STATUS_ID_A_VENCER, isoDaysFromToday(-1)),          // venceu ontem→ FORA
    ];
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(borda) })));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('inclui o que vence HOJE e o 7º dia; exclui o 8º dia e o de ontem', async () => {
    const d = await getDashboardData(new Date().getMonth(), new Date().getFullYear());
    expect(d.kpis.vencendoCount).toBe(2);
    // O discriminador: 30 = hoje + 7º dia. Uma janela deslocada +1 dia daria 60
    // (7º dia + 8º dia) com a MESMA contagem 2.
    expect(d.kpis.vencendoValue).toBe(DENTRO_HOJE + DENTRO_D7);
  });

  it('o filtro de KPI "vencendo7" recorta os gráficos pela mesma janela dos cards', async () => {
    const d = await getDashboardData(new Date().getMonth(), new Date().getFullYear(), 'month', 'vencendo7');
    // `matchesKpiFilter` e `computeKpis` consomem a MESMA janela: card e gráfico não podem
    // divergir. É o caminho que o default das duas telas passou a exercitar na abertura.
    const somaGrafico = d.statusBreakdown.reduce((s, x) => s + x.value, 0);
    expect(somaGrafico).toBe(DENTRO_HOJE + DENTRO_D7);
    expect(somaGrafico).toBe(d.kpis.vencendoValue);
  });
});
