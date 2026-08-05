import { describe, it, expect } from 'vitest';
import {
  parsePaginationTotal,
  parseBrlAmount,
  isCurrencyValueSearch,
  applyFinancialFilters,
  groupDocumentTypeLabel,
  isTaxDocumentType,
  withChartAccountJoin,
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
    for (const t of ['darf', 'gps', 'das', 'gru', 'dae', 'dare', 'gnre', 'ipva', 'iptu', 'dam / duam', 'iss', 'itbi', 'gare', 'tributo']) {
      expect(groupDocumentTypeLabel(t)).toBe('Tributos');
    }
  });

  it('é robusto a variação de caixa', () => {
    expect(groupDocumentTypeLabel('DARF')).toBe('Tributos');
    expect(groupDocumentTypeLabel('GNRE')).toBe('Tributos');
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
