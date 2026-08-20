import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Só `listUsedChartAccountDescriptions` vai à rede; as demais funções deste arquivo são
// puras. O mock existe para o `authHeaders` não precisar de sessão real.
vi.mock('../lib/supabaseClient', () => ({
  supabase: { auth: { getSession: () => Promise.resolve({ data: { session: { access_token: 'tok' } } }) } },
}));

import {
  STATUS_ID_A_VENCER,
  STATUS_ID_CANCELADO,
  STATUS_ID_PAGO,
} from '@sheild/shared';
import { todayISO, isoDaysFromToday } from '../lib/format';
import {
  parsePaginationTotal,
  parseBrlAmount,
  isCurrencyValueSearch,
  applyFinancialFilters,
  getFinancialStats,
  groupDocumentTypeLabel,
  isTaxDocumentType,
  withChartAccountJoin,
  listUsedChartAccountDescriptions,
  SELECT_WITH_EMBEDS,
} from './supabase';

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

describe('applyFinancialFilters — busca inclui classificação contábil', () => {
  it('termo textual monta or com texto + fornecedor + classificação (centro/plano)', () => {
    const params = new URLSearchParams();
    applyFinancialFilters(params, { supplier: 'ICMS-ST' }, {
      supplierIds: [10, 11],
      costCenterIds: [3],
      chartAccountIds: [33, 34],
    });
    const or = params.get('or') ?? '';
    expect(or).toContain('invoice_number.ilike.');
    expect(or).toContain('subject.ilike.');
    expect(or).toContain('sender_email.ilike.');
    expect(or).toContain('sk_supplier.in.(10,11)');
    expect(or).toContain('cost_center_id.in.(3)');
    expect(or).toContain('chart_account_id.in.(33,34)');
  });

  it('arrays vazios não geram cláusulas in.() inválidas', () => {
    const params = new URLSearchParams();
    applyFinancialFilters(params, { supplier: 'ACME' }, {
      supplierIds: [],
      costCenterIds: [],
      chartAccountIds: [],
    });
    const or = params.get('or') ?? '';
    expect(or).not.toContain('cost_center_id.in.');
    expect(or).not.toContain('chart_account_id.in.');
    expect(or).not.toContain('sk_supplier.in.');
    expect(or).toContain('subject.ilike.');
  });

  it('sem IDs passados (default) usa só texto', () => {
    const params = new URLSearchParams();
    applyFinancialFilters(params, { supplier: 'ACME' });
    const or = params.get('or') ?? '';
    expect(or).toContain('invoice_number.ilike.');
    expect(or).not.toContain('cost_center_id.in.');
  });

  it('busca por valor ("R$ …") ignora os IDs — só amount exato', () => {
    const params = new URLSearchParams();
    applyFinancialFilters(params, { supplier: 'R$ 167,15' }, {
      supplierIds: [1],
      costCenterIds: [3],
      chartAccountIds: [33],
    });
    expect(params.get('amount')).toBe('eq.167.15');
    expect(params.get('or')).toBeNull();
  });
});

describe('groupDocumentTypeLabel — guias tributárias colapsam em "Tributos"', () => {
  it('agrupa todos os tipos tributários num único rótulo', () => {
    // 'dar / dare' é uma entrada ÚNICA desde a migration 133 — DAR e DARE nomeiam a
    // mesma guia estadual e o acrônimo impresso varia por estado.
    for (const t of ['darf', 'gps', 'das', 'gru', 'dae', 'dar / dare', 'gnre', 'ipva', 'iptu', 'dam / duam', 'iss', 'itbi', 'gare', 'tributo']) {
      expect(groupDocumentTypeLabel(t)).toBe('Tributos');
    }
  });

  it('é robusto a variação de caixa', () => {
    expect(groupDocumentTypeLabel('DARF')).toBe('Tributos');
    expect(groupDocumentTypeLabel('GNRE')).toBe('Tributos');
    expect(groupDocumentTypeLabel('DAR / DARE')).toBe('Tributos');
  });

  it('preserva tipos não-tributários e null', () => {
    expect(groupDocumentTypeLabel('boleto')).toBe('boleto');
    expect(groupDocumentTypeLabel('recibo')).toBe('recibo');
    expect(groupDocumentTypeLabel('cte')).toBe('cte');
    expect(groupDocumentTypeLabel(null)).toBeNull();
  });
});

describe('isTaxDocumentType — predicado de guia tributária', () => {
  it('true para tipos tributários (robusto a caixa)', () => {
    expect(isTaxDocumentType('darf')).toBe(true);
    expect(isTaxDocumentType('GNRE')).toBe(true);
    expect(isTaxDocumentType('dam / duam')).toBe(true);
  });

  it('false para não-tributário e null', () => {
    expect(isTaxDocumentType('boleto')).toBe(false);
    expect(isTaxDocumentType('multa')).toBe(false);
    expect(isTaxDocumentType(null)).toBe(false);
  });
});

describe('applyFinancialFilters — filtro de EMPRESA (sk_company)', () => {
  it('empresa escolhida vira sk_company=eq.N', () => {
    const params = new URLSearchParams();
    applyFinancialFilters(params, { skCompany: 2 });
    expect(params.get('sk_company')).toBe('eq.2');
  });

  it('sem empresa (undefined) NÃO filtra — mostra as duas', () => {
    const params = new URLSearchParams();
    applyFinancialFilters(params, {});
    expect(params.has('sk_company')).toBe(false);
  });

  it('filtra pela FK e não pelo embed (o company(trade_name) é só exibição)', () => {
    const params = new URLSearchParams();
    applyFinancialFilters(params, { skCompany: 1 });
    expect(params.toString()).not.toContain('trade_name');
  });

  it('combina com os demais filtros sem sobrescrevê-los', () => {
    const params = new URLSearchParams();
    applyFinancialFilters(params, { skCompany: 2, docType: 'boleto', statusId: 8 });
    expect(params.get('sk_company')).toBe('eq.2');
    expect(params.get('document_type')).toBe('eq.boleto');
    expect(params.get('status_id')).toBe('eq.8');
  });
});

describe('applyFinancialFilters — situação por status_id (fonte única)', () => {
  it('filtro explícito de situação vira status_id=eq.N', () => {
    const params = new URLSearchParams();
    applyFinancialFilters(params, { statusId: 8 }); // 8 = pago
    expect(params.get('status_id')).toBe('eq.8');
  });

  it('sem filtro e sem includeCancelled → exclui cancelado por id (neq.9)', () => {
    const params = new URLSearchParams();
    applyFinancialFilters(params, {});
    expect(params.get('status_id')).toBe('neq.9'); // 9 = cancelado
  });

  it('includeCancelled=true (grid) NÃO filtra situação quando não há filtro explícito', () => {
    const params = new URLSearchParams();
    applyFinancialFilters(params, {}, undefined, true);
    expect(params.get('status_id')).toBeNull();
  });

  it('filtro explícito prevalece mesmo com includeCancelled', () => {
    const params = new URLSearchParams();
    applyFinancialFilters(params, { statusId: 9 }, undefined, true);
    expect(params.get('status_id')).toBe('eq.9');
  });
});

// ── Filtros de classificação contábil (2ª linha de /consulta) ──────────────────
// Centro de custo é FK DIRETA da conta; plano/grupo/subgrupo vivem em
// financial_chart_of_account e exigem filtro em RECURSO EMBUTIDO com !inner.
//
// Os valores esperados abaixo foram medidos contra o banco real em 2026-08-04 (ver o
// comentário de CHART_EMBED em supabase.ts): sem !inner o filtro devolve a tabela
// INTEIRA (706) respondendo HTTP 200; com !inner devolve 198 para o grupo 24, que é o
// que o SQL equivalente dá. É uma falha silenciosa — daí a bateria abaixo.
describe('applyFinancialFilters — classificação contábil', () => {
  it('centro de custo é FK direta: filtra sem tocar no select (nada de join)', () => {
    const params = new URLSearchParams();
    params.set('select', 'amount');
    applyFinancialFilters(params, { costCenterId: 4 });
    expect(params.get('cost_center_id')).toBe('eq.4');
    expect(params.get('select')).toBe('amount'); // sem !inner: não precisa de join
  });

  it('grupo filtra pelo embed E promove o select a !inner', () => {
    const params = new URLSearchParams();
    params.set('select', SELECT_WITH_EMBEDS);
    applyFinancialFilters(params, { chartAccountGroupId: 24 });
    expect(params.get('chart_account.chart_account_group_id')).toBe('eq.24');
    expect(params.get('select')).toContain('chart_account:financial_chart_of_account!inner(');
  });

  it('subgrupo filtra pelo embed E promove o select a !inner', () => {
    const params = new URLSearchParams();
    params.set('select', SELECT_WITH_EMBEDS);
    applyFinancialFilters(params, { chartAccountSubgroupId: 93 });
    expect(params.get('chart_account.chart_account_subgroup_id')).toBe('eq.93');
    expect(params.get('select')).toContain('!inner(');
  });

  // REGRESSÃO CRÍTICA: aspas em `eq.` isolado NÃO são interpretadas pelo PostgREST —
  // medido: eq."Serviços Gerais" devolve 0 linhas e eq.Serviços Gerais devolve as 2
  // corretas. Citar o valor (como se faz DENTRO de or=/in.(), via ilikeContains)
  // quebraria TODO filtro de plano, em silêncio.
  it('descrição do plano vai CRUA, sem aspas', () => {
    const params = new URLSearchParams();
    params.set('select', SELECT_WITH_EMBEDS);
    applyFinancialFilters(params, { chartAccountDescription: 'Serviços Gerais' });
    expect(params.get('chart_account.account_description')).toBe('eq.Serviços Gerais');
  });

  it('descrição com vírgula/parênteses também vai crua (9 planos reais têm)', () => {
    const params = new URLSearchParams();
    params.set('select', SELECT_WITH_EMBEDS);
    applyFinancialFilters(params, { chartAccountDescription: 'Amostras, Brindes e Divulgação' });
    expect(params.get('chart_account.account_description')).toBe('eq.Amostras, Brindes e Divulgação');
  });

  it('grupo + subgrupo juntos promovem o select UMA vez só (idempotente)', () => {
    const params = new URLSearchParams();
    params.set('select', SELECT_WITH_EMBEDS);
    applyFinancialFilters(params, { chartAccountGroupId: 24, chartAccountSubgroupId: 93 });
    const select = params.get('select') ?? '';
    expect(select.match(/!inner/g)).toHaveLength(1);
  });

  // O guarda de NÃO-REGRESSÃO da abertura da página: sem filtro contábil a URL do grid
  // tem de sair exatamente como saía antes desta feature.
  it('SEM filtro contábil, o select fica INTOCADO e não há chave chart_account.*', () => {
    const params = new URLSearchParams();
    params.set('select', SELECT_WITH_EMBEDS);
    applyFinancialFilters(params, { docType: 'boleto' });
    expect(params.get('select')).toBe(SELECT_WITH_EMBEDS);
    expect([...params.keys()].some((k) => k.startsWith('chart_account.'))).toBe(false);
  });

  it('caminho dos KPIs (select=amount) recebe o embed MÍNIMO', () => {
    const params = new URLSearchParams();
    params.set('select', 'amount');
    applyFinancialFilters(params, { chartAccountGroupId: 24 });
    expect(params.get('select')).toBe('amount,chart_account:financial_chart_of_account!inner(chart_account_id)');
  });

  // O slot `or=` é ÚNICO e é da busca livre. Os filtros contábeis são params escalares
  // em chaves próprias — não podem competir por ele.
  it('convive com a busca livre sem consumir o slot or=', () => {
    const params = new URLSearchParams();
    params.set('select', SELECT_WITH_EMBEDS);
    applyFinancialFilters(
      params,
      { supplier: 'ICMS', chartAccountGroupId: 24, costCenterId: 4 },
      { supplierIds: [10], costCenterIds: [], chartAccountIds: [] },
    );
    expect(params.get('or')).toContain('sk_supplier.in.(10)');
    expect(params.get('chart_account.chart_account_group_id')).toBe('eq.24');
    expect(params.get('cost_center_id')).toBe('eq.4');
  });

  // 0 é o sentinela "não informado" — um id legítimo. `!= null` (e não truthy) é o que
  // impede descartá-lo em silêncio, mesmo que hoje os lookups não o ofereçam.
  it('id 0 (sentinela "não informado") é filtrável, não é descartado como falsy', () => {
    const params = new URLSearchParams();
    params.set('select', SELECT_WITH_EMBEDS);
    applyFinancialFilters(params, { costCenterId: 0, chartAccountGroupId: 0 });
    expect(params.get('cost_center_id')).toBe('eq.0');
    expect(params.get('chart_account.chart_account_group_id')).toBe('eq.0');
  });
});

// ── Colunas de data: o INTERVALO e o PERÍODO são independentes ────────────────
// `rangeDateField` (seletor ao lado dos campos De/Até) governa o intervalo explícito;
// `dateField` (seletor da linha dos meses) governa o range derivado de mês/ano. Antes
// de 2026-08-05 havia UMA variável servindo aos dois ramos — os testes abaixo são o que
// impede a volta desse acoplamento, que não produz erro nenhum: a consulta responde 200
// filtrando pela coluna errada, e a tela mostra um conjunto plausível.
describe('applyFinancialFilters — coluna de data do intervalo × do período', () => {
  it('o intervalo De/Até usa rangeDateField, não a coluna do período', () => {
    const params = new URLSearchParams();
    applyFinancialFilters(params, {
      dateFrom: '2026-07-01',
      dateTo: '2026-07-31',
      rangeDateField: 'payment_date',
      dateField: 'due_date',
    });
    expect(params.getAll('payment_date')).toEqual(['gte.2026-07-01', 'lte.2026-07-31']);
    expect(params.has('due_date')).toBe(false);
  });

  // Espelho do anterior — é este par que prova a INDEPENDÊNCIA. Um teste de mão única
  // continuaria verde se um dos seletores escrevesse nos dois campos.
  it('o range de mês/ano usa dateField, sem contaminação do rangeDateField', () => {
    const params = new URLSearchParams();
    applyFinancialFilters(params, {
      month: 6, // julho (0-indexed)
      year: 2026,
      dateField: 'issue_date',
      rangeDateField: 'payment_date',
    });
    expect(params.getAll('issue_date')).toEqual(['gte.2026-07-01', 'lte.2026-07-31']);
    expect(params.has('payment_date')).toBe(false);
  });

  // A precedência é o que mantém os dois ramos mutuamente exclusivos. Trocar o `else if`
  // por `if` faria as duas colunas serem filtradas ao mesmo tempo (AND), devolvendo um
  // conjunto quase sempre vazio — sem erro.
  it('com intervalo E mês/ano preenchidos, só o intervalo filtra', () => {
    const params = new URLSearchParams();
    applyFinancialFilters(params, {
      dateFrom: '2026-07-10',
      dateTo: '2026-07-20',
      rangeDateField: 'issue_date',
      month: 0,
      year: 2026,
      dateField: 'due_date',
    });
    expect(params.getAll('issue_date')).toEqual(['gte.2026-07-10', 'lte.2026-07-20']);
    expect(params.has('due_date')).toBe(false);
  });

  // O mutante mais provável de acontecer sem querer é `rangeDateField ?? dateField`:
  // preserva todas as referências, passa no typecheck e no lint, e só se manifesta
  // quando os dois seletores divergem.
  it('sem rangeDateField, o intervalo cai em due_date — NUNCA no dateField', () => {
    const params = new URLSearchParams();
    applyFinancialFilters(params, { dateFrom: '2026-07-01', dateField: 'issue_date' });
    expect(params.getAll('due_date')).toEqual(['gte.2026-07-01']);
    expect(params.has('issue_date')).toBe(false);
  });

  // Documenta o no-op inerente ao pedido: sem datas preenchidas o seletor do intervalo
  // não tem sobre o que agir.
  it('rangeDateField sem intervalo preenchido não filtra data nenhuma', () => {
    const params = new URLSearchParams();
    applyFinancialFilters(params, { rangeDateField: 'payment_date' });
    expect(params.has('payment_date')).toBe(false);
    expect(params.has('due_date')).toBe(false);
    expect(params.has('issue_date')).toBe(false);
  });

  it('só data inicial ou só final aplica um dos limites', () => {
    const somenteAte = new URLSearchParams();
    applyFinancialFilters(somenteAte, { dateTo: '2026-07-31', rangeDateField: 'issue_date' });
    expect(somenteAte.getAll('issue_date')).toEqual(['lte.2026-07-31']);
  });
});

// ── Opções do filtro de plano de contas: só o que EXISTE em contas ────────────
// O filtro listava o cadastro inteiro (611 linhas) e escolher um plano sem conta nenhuma
// devolvia grid vazio — indistinguível de filtro quebrado. Medido no banco real: 611
// planos cadastrados contra 84 descrições distintas de fato em uso.
describe('listUsedChartAccountDescriptions', () => {
  const chamadas: string[] = [];

  const responderCom = (paginas: { account_description: string | null }[][]) => {
    let i = 0;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      chamadas.push(String(url));
      const corpo = paginas[i] ?? [];
      i++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(corpo) } as Response);
    }));
  };

  beforeEach(() => { chamadas.length = 0; });
  afterEach(() => { vi.unstubAllGlobals(); });

  // 🔴 O `!inner` é o coração: sem ele o embed vira LEFT JOIN e a consulta devolve o
  // cadastro INTEIRO com HTTP 200 — o filtro voltaria a oferecer planos sem conta e nada
  // acusaria. É a mesma armadilha silenciosa já registrada em applyFinancialFilters.
  it('consulta pelo CADASTRO com embed !inner, e não pelo fato', async () => {
    responderCom([[{ account_description: 'Aluguel' }]]);
    await listUsedChartAccountDescriptions();

    const url = new URL(chamadas[0]);
    expect(url.pathname).toContain('/financial_chart_of_account');
    expect(url.searchParams.get('select')).toBe('account_description,financial_account_control!inner(id)');
    // O sentinela id 0 tem descrição NULL — não é opção de filtro.
    expect(url.searchParams.get('account_description')).toBe('not.is.null');
    // Desempate pela PK — obrigatório em TODA listagem paginada por offset (lib/stableOrder.ts).
    // `account_description` não é única (é o que o caso de dedup abaixo exercita), então sem a
    // PK a ordem não é total e a página seguinte pode pular uma linha: a opção sumiria do
    // filtro com HTTP 200 e sem erro. Asserção sobre o valor INTEIRO, não `toContain`: um
    // `order` que perdesse a coluna primária também passaria num `toContain('chart_account_id')`.
    expect(url.searchParams.get('order')).toBe('account_description.asc,chart_account_id.asc');
    // Sem recorte de período/situação: a lista é a mesma independentemente dos filtros
    // em tela, que é o que o requisito pede ("busca geral independente do filtro").
    expect(url.searchParams.has('due_date')).toBe(false);
    expect(url.searchParams.has('status_id')).toBe(false);
  });

  it('deduplica a descrição repetida entre centros de custo e ordena em pt-BR', async () => {
    responderCom([[
      { account_description: 'Órgãos Públicos' },
      { account_description: 'Aluguel' },
      { account_description: 'Aluguel' }, // mesma descrição, outro centro
      { account_description: null },
    ]]);

    expect(await listUsedChartAccountDescriptions()).toEqual(['Aluguel', 'Órgãos Públicos']);
  });

  // O teto do PostgREST ("Max rows") corta a resposta e devolve HTTP 200 — sumiria opção
  // do filtro sem erro nenhum. Hoje o grão é o cadastro (611 linhas, teto estrutural), mas
  // a consulta DECIDE o que o usuário consegue filtrar; a paginação custa uma condição.
  it('pagina enquanto a página vier cheia', async () => {
    const cheia = Array.from({ length: 1000 }, (_, i) => ({ account_description: `P${i}` }));
    responderCom([cheia, [{ account_description: 'Ultimo' }]]);

    const out = await listUsedChartAccountDescriptions();

    expect(chamadas).toHaveLength(2);
    expect(new URL(chamadas[0]).searchParams.get('offset')).toBe('0');
    expect(new URL(chamadas[1]).searchParams.get('offset')).toBe('1000');
    expect(out).toHaveLength(1001);
  });

  it('para na primeira página incompleta (não pagina à toa)', async () => {
    responderCom([[{ account_description: 'Aluguel' }]]);
    await listUsedChartAccountDescriptions();
    expect(chamadas).toHaveLength(1);
  });
});

describe('getFinancialStats', () => {
  const chamadas: string[] = [];

  const responderCom = (paginas: { amount: number; status_id: number; due_date: string | null }[][]) => {
    let i = 0;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      chamadas.push(String(url));
      const corpo = paginas[i] ?? [];
      i++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(corpo) } as Response);
    }));
  };
  const linha = (over = {}) => ({ amount: 10, status_id: STATUS_ID_A_VENCER, due_date: null, ...over });

  beforeEach(() => { chamadas.length = 0; });
  afterEach(() => { vi.unstubAllGlobals(); });

  // 🔴 O defeito que este bloco trava: a versão anterior pedia `limit: 1000` e contava
  // `all.length`. Medido por HTTP em 2026-08-08, o PostgREST desta instalação corta em
  // 1.000 e devolve **HTTP 200** (email_control: 1.303 linhas, `limit=10000` → 1.000).
  // Com 742 contas e ~22/dia, os CINCO cards passariam a subnotificar em ~12 dias, sem
  // erro nenhum. Não é hipótese: é o mesmo teto que a Onda 3 já mediu nos scripts Python.
  it('pagina enquanto a página vier cheia (o teto de 1.000 corta sem erro)', async () => {
    const cheia = Array.from({ length: 1000 }, () => linha());
    responderCom([cheia, [linha(), linha()]]);

    const st = await getFinancialStats();

    expect(chamadas).toHaveLength(2);
    expect(new URL(chamadas[0]).searchParams.get('offset')).toBe('0');
    expect(new URL(chamadas[1]).searchParams.get('offset')).toBe('1000');
    // 1002, não 1000: é a asserção que falha se alguém voltar ao fetch único.
    expect(st.totalRecords).toBe(1002);
    expect(st.totalValue).toBe(10020);
  });

  it('para na primeira página incompleta (não pagina à toa)', async () => {
    responderCom([[linha()]]);
    await getFinancialStats();
    expect(chamadas).toHaveLength(1);
  });

  // Desempate determinístico: sem `order`, o PostgREST não garante a mesma ordem entre
  // requisições e o offset PULA linha — a conta sumiria do KPI com HTTP 200 (mesma causa
  // do scroll infinito duplicando linha, ver lib/stableOrder.ts).
  it('ordena por id para a paginação por offset ser determinística', async () => {
    responderCom([[linha()]]);
    await getFinancialStats();
    expect(new URL(chamadas[0]).searchParams.get('order')).toBe('id.asc');
  });

  it('repassa o filtro recebido para a consulta dos KPIs', async () => {
    responderCom([[linha()]]);
    await getFinancialStats({ skCompany: 2, costCenterId: 4 });

    const p = new URL(chamadas[0]).searchParams;
    expect(p.get('sk_company')).toBe('eq.2');
    expect(p.get('cost_center_id')).toBe('eq.4');
  });

  // Sem filtro explícito de situação, cancelado fica fora dos KPIs (como o "Valor total").
  it('exclui cancelado por padrão', async () => {
    responderCom([[linha()]]);
    await getFinancialStats();
    expect(new URL(chamadas[0]).searchParams.get('status_id')).toBe(`neq.${STATUS_ID_CANCELADO}`);
  });

  // "A vencer em 7 dias" conta só o que está EM ABERTO na janela — é o predicado que o
  // clique no card precisa reproduzir (ver next7DaysRange em Consulta.tsx).
  it('conta em "vencendo" apenas as a-vencer dentro da janela de 7 dias', async () => {
    const hoje = todayISO();
    responderCom([[
      linha({ due_date: hoje }),                                    // dentro
      linha({ due_date: isoDaysFromToday(7) }),                     // borda: dentro
      linha({ due_date: isoDaysFromToday(8) }),                     // fora
      linha({ due_date: isoDaysFromToday(-1) }),                    // fora (passado)
      linha({ due_date: hoje, status_id: STATUS_ID_PAGO }),         // fora (já paga)
      linha({ due_date: null }),                                    // fora (sem vencimento)
    ]]);

    const st = await getFinancialStats();
    expect(st.vencendo).toBe(2);
    expect(st.aVencer).toBe(5);
  });
});

describe('withChartAccountJoin', () => {
  // GUARDA CROSS-LAYER: prova que a promoção acerta o SELECT_WITH_EMBEDS REAL. Se o
  // alias do embed for renomeado lá, o helper deixaria de casar e passaria a ANEXAR um
  // segundo embed — filtro e exibição apontando para embeds diferentes, sem erro algum.
  it('promove o embed do SELECT_WITH_EMBEDS real NO LUGAR, sem anexar um segundo', () => {
    const out = withChartAccountJoin(SELECT_WITH_EMBEDS);
    expect(out).toContain('chart_account:financial_chart_of_account!inner(');
    expect(out).not.toContain('!inner(chart_account_id)'); // não anexou o embed mínimo
    // Conta o EMBED (alias + tabela), não a substring "financial_chart_of_account" — que
    // também aparece em ..._group e ..._subgroup, os embeds aninhados.
    expect(out.match(/chart_account:financial_chart_of_account/g)).toHaveLength(1);
  });

  it('preserva as colunas e os embeds ANINHADOS de grupo/subgrupo', () => {
    const out = withChartAccountJoin(SELECT_WITH_EMBEDS);
    expect(out).toContain('group:financial_chart_of_account_group(');
    expect(out).toContain('subgroup:financial_chart_of_account_subgroup(');
    expect(out).toContain('account_description');
  });

  // Sanidade do parser: se o token procurado sumisse do select, os testes acima
  // continuariam "passando" por caminhos errados — este falha alto.
  it('sanidade: o SELECT_WITH_EMBEDS realmente contém o embed procurado', () => {
    expect(SELECT_WITH_EMBEDS).toContain('chart_account:financial_chart_of_account(');
  });

  it('é idempotente', () => {
    const once = withChartAccountJoin(SELECT_WITH_EMBEDS);
    expect(withChartAccountJoin(once)).toBe(once);
  });

  it('anexa o embed mínimo quando o select não embute o plano', () => {
    expect(withChartAccountJoin('id')).toBe('id,chart_account:financial_chart_of_account!inner(chart_account_id)');
  });

  // Select vazio NÃO pode virar "só o embed": o PostgREST responderia 200 com linhas sem
  // nenhuma coluna de topo e o grid renderizaria vazio, sem erro. Hoje as 3 rotas setam o
  // select antes — este caso protege a 4ª, cuja falha seria silenciosa.
  it('select vazio cai em `*` antes do embed, nunca só no embed', () => {
    expect(withChartAccountJoin('')).toBe('*,chart_account:financial_chart_of_account!inner(chart_account_id)');
  });
});
