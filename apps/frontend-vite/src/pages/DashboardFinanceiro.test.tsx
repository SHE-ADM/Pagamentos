// src/pages/DashboardFinanceiro.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Lookup do filtro "Empresa" (useCompanyOptions) — evita rede no teste.
const listCompaniesMock = vi.fn();
vi.mock('../services/lookups', () => ({
  listCompanies: () => listCompaniesMock(),
}));

import DashboardFinanceiro from './DashboardFinanceiro';
import * as supabase from '../services/supabase';
import type { FinancialDashboardData } from '../services/supabase';

const MOCK: FinancialDashboardData = {
  month: new Date().getMonth(),
  year: new Date().getFullYear(),
  scope: 'month',
  kpis: {
    totalCount: 90, totalValue: 32000,
    pagoCount: 30, pagoValue: 8000,
    aVencerCount: 52, aVencerValue: 20000,
    vencendoCount: 9, vencendoValue: 5000,
    vencidasCount: 8, vencidasValue: 4000,
  },
  despesaFixaBreakdown: [
    { label: 'Folha de Pagamento', count: 30, value: 10000 },
  ],
  despesaVariavelBreakdown: [
    { label: 'Transporte', count: 40, value: 18000 },
    { label: 'Despesas com Serviços', count: 20, value: 4000 },
  ],
  custoMercadoriasBreakdown: [
    { label: 'Custos', count: 10, value: 6000 },
  ],
  custoImportacaoBreakdown: [
    { label: 'Importações', count: 5, value: 4000 },
  ],
  tipoBreakdown: [
    { label: 'Despesas Variáveis', count: 55, value: 22000 },
    { label: 'Despesas Fixas', count: 35, value: 10000 },
    { label: 'Custos de Mercadorias', count: 10, value: 6000 },
  ],
  // 🔴 As `key` do ranking casam os `chart_account_subgroup_id` de `detailRows` (22 e 31) DE
  // PROPÓSITO: `openDrill` não abre o modal com 0 linhas, então uma key sem linha
  // correspondente faria o clique do teste de drill não fazer NADA — e o `findByRole`
  // seguinte estouraria por timeout, num erro que não se parece com a causa.
  subgroupRanking: [
    { key: 'sg:22', name: 'Transportadoras', value: 12000, count: 8, pct: 80 },
    { key: 'sg:31', name: 'Mercadorias', value: 3000, count: 2, pct: 20 },
  ],
  // A 1ª conta (subgrupo 22) é a que o clique no ranking filtra — o card de detalhe mostra o
  // fornecedor dela. A 2ª (CUSTO, subgrupo tipo 7) prova que o donut "Custos de Mercadorias"
  // passa typeGroupId=7 (o drill devolve SÓ ela, nunca a de tipo 6). A 3ª (subgrupo tipo 9)
  // prova o mesmo para o donut "Custos de Importação" — wiring, não só a função pura
  // `filterExpenseDetailRows`.
  detailRows: [
    {
      id: 1, amount: 500, status_id: 3, due_date: '2026-07-10',
      supplier: { trade_name: 'Fornecedor ABC', legal_name: null },
      chart_account: {
        account_code: '4.5.01', account_description: 'Fretes',
        group: { group_description: 'Transporte', type_group_id: 2 },
        subgroup: {
          chart_account_subgroup_id: 22, subgroup_code: '4.5', subgroup_description: 'Transportadoras',
          type_group: { type_group_id: 6, type_group_description: 'Despesas Variáveis' },
        },
      },
    },
    {
      id: 2, amount: 700, status_id: 3, due_date: '2026-07-12',
      supplier: { trade_name: 'Fornecedor CM', legal_name: null },
      chart_account: {
        account_code: '3.1.01', account_description: 'Compras de Mercadorias',
        group: { group_description: 'Custos', type_group_id: 8 },
        subgroup: {
          chart_account_subgroup_id: 31, subgroup_code: '3.1', subgroup_description: 'Mercadorias',
          type_group: { type_group_id: 7, type_group_description: 'Custos de Mercadorias' },
        },
      },
    },
    {
      id: 3, amount: 400, status_id: 3, due_date: '2026-07-14',
      supplier: { trade_name: 'Fornecedor IMP', legal_name: null },
      chart_account: {
        account_code: '23.2.02', account_description: 'Assessoria em Importação',
        group: { group_description: 'Importações', type_group_id: 8 },
        subgroup: {
          chart_account_subgroup_id: 98, subgroup_code: '23.2', subgroup_description: 'Serviços de Importação',
          type_group: { type_group_id: 9, type_group_description: 'Custos de Importação' },
        },
      },
    },
  ],
};

describe('DashboardFinanceiro', () => {
  beforeEach(() => {
    vi.spyOn(supabase, 'getFinancialDashboardData').mockResolvedValue(MOCK);
    listCompaniesMock.mockReset();
    listCompaniesMock.mockResolvedValue([
      { sk_company: 1, trade_name: 'OTIMOTEX TECIDOS' },
      { sk_company: 2, trade_name: 'LEBIANCO' },
    ]);
  });

  it('abre no mês atual, filtrado por "A vencer em 7 dias", e renderiza os KPIs de despesa', async () => {
    render(<DashboardFinanceiro />);
    expect(await screen.findByText('Despesas no mês')).toBeInTheDocument();
    expect(screen.getByText('Vencidas')).toBeInTheDocument();
    // Default de abertura = KPI "A vencer em 7 dias" (decisão do usuário 2026-08-15; antes
    // era 'aVencer'). O card do filtro mais amplo "A vencer" NÃO fica marcado.
    expect(supabase.getFinancialDashboardData).toHaveBeenCalledWith(new Date().getMonth(), new Date().getFullYear(), 'month', 'vencendo7', undefined);
    expect(screen.getByText(/filtrando: A vencer em 7 dias/i)).toBeInTheDocument();
    // O card do filtro MAIS AMPLO ("A vencer", sem os 7 dias) NÃO fica marcado — é o que
    // distingue o default novo do antigo. Casa pelo texto do card, não pelo nome acessível
    // (que concatena rótulo + valor + contagem).
    const aVencerAmplo = screen
      .getAllByRole('button')
      .filter((b) => b.hasAttribute('aria-pressed'))
      .find((b) => /A vencer(?! em 7)/.test(b.textContent ?? ''));
    expect(aVencerAmplo).toBeDefined();
    expect(aVencerAmplo).toHaveAttribute('aria-pressed', 'false');
  });

  it('o card "A vencer em 7 dias" já ABRE visualmente marcado como ativo', async () => {
    render(<DashboardFinanceiro />);
    await screen.findByText('Despesas no mês');
    // Isola os 5 KpiCards pela INTERSEÇÃO: têm aria-pressed (como os botões de mês/ano/escopo
    // do cabeçalho) E "conta(s)" (como os botões de ranking/legenda de donut). Só os KPIs têm
    // os dois — cada filtro sozinho pega botões demais.
    const cards = screen
      .getAllByRole('button')
      .filter((b) => b.hasAttribute('aria-pressed') && /conta\(s\)/.test(b.textContent ?? ''));
    expect(cards).toHaveLength(5);

    const marcados = cards.filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(marcados).toHaveLength(1); // exatamente um card ativo na abertura
    const vencendo7 = marcados[0];
    expect(vencendo7.textContent).toMatch(/A vencer em 7 dias/);
    expect(vencendo7).toHaveAttribute('title', 'Limpar filtro');
    expect(vencendo7.className).toContain('ring-brand'); // anel de destaque (não o de foco)
    expect(vencendo7.textContent).toContain('filtrando'); // sinal não-cromático (WCAG 1.4.1)
  });

  it('o ✕ do cabeçalho limpa o filtro inicial "A vencer em 7 dias"', async () => {
    render(<DashboardFinanceiro />);
    fireEvent.click(await screen.findByText(/filtrando: A vencer em 7 dias/i));
    await vi.waitFor(() =>
      expect(supabase.getFinancialDashboardData).toHaveBeenLastCalledWith(
        expect.any(Number), expect.any(Number), 'month', 'total', undefined,
      ),
    );
    expect(screen.queryByText(/filtrando:/i)).not.toBeInTheDocument();
  });

  it('clicar num KPI aplica o filtro e clicar de novo o limpa', async () => {
    render(<DashboardFinanceiro />);
    const pagas = await screen.findByRole('button', { name: /Pagas/i });

    fireEvent.click(pagas);
    expect(await screen.findByText(/filtrando: Pagos/i)).toBeInTheDocument();
    expect(supabase.getFinancialDashboardData).toHaveBeenLastCalledWith(
      new Date().getMonth(), new Date().getFullYear(), 'month', 'pago', undefined,
    );
    expect(pagas).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(pagas);
    expect(supabase.getFinancialDashboardData).toHaveBeenLastCalledWith(
      new Date().getMonth(), new Date().getFullYear(), 'month', 'total', undefined,
    );
    expect(pagas).toHaveAttribute('aria-pressed', 'false');
  });

  it('escolher LEBIANCO recarrega com skCompany=2', async () => {
    render(<DashboardFinanceiro />);
    await screen.findByRole('option', { name: 'LEBIANCO' });
    fireEvent.change(screen.getByLabelText('Filtrar por empresa'), { target: { value: '2' } });
    await vi.waitFor(() =>
      expect(supabase.getFinancialDashboardData).toHaveBeenLastCalledWith(
        expect.any(Number), expect.any(Number), 'month', 'vencendo7', 2,
      ),
    );
  });

  // A grade é 3 linhas × 2 colunas e a ordem VISUAL é a ordem do DOM (sem `order-*`), então
  // travar a sequência COMPLETA das 6 headings é o que prova o layout pedido — inclusive que
  // o "Ranking de contas" divide a 3ª linha com o donut "Despesas Variáveis". Um `.slice(0,5)`
  // continuaria verde com o ranking em qualquer posição, provando só metade.
  it('renderiza os 6 cards na ordem do layout 3×2 (ranking na 3ª linha, ao lado de Variáveis)', async () => {
    render(<DashboardFinanceiro />);
    expect(await screen.findByRole('heading', { name: 'Classificação Financeira' })).toBeInTheDocument();
    const titulos = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(titulos).toEqual([
      'Classificação Financeira', 'Custos de Mercadorias',   // linha 1
      'Despesas Fixas', 'Custos de Importação',              // linha 2
      'Despesas Variáveis', 'Ranking de contas',             // linha 3
    ]);
    // Os 6 cards vivem na MESMA grade — é o que permite donut e ranking dividirem a linha 3.
    const grade = screen.getByRole('heading', { name: 'Ranking de contas' }).closest('.grid');
    expect(grade).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Classificação Financeira' }).closest('.grid')).toBe(grade);
    // `self-start` SÓ no donut que divide a linha com o ranking: sem ele o `stretch` do grid
    // esticaria a moldura até a altura do ranking, deixando ~150px de branco sob o anel.
    // (jsdom não faz layout — o que dá para travar é a presença da classe, que impede a
    // remoção silenciosa; o efeito visual é conferido no navegador.)
    const cardDe = (t: string): HTMLElement | null =>
      screen.getByRole('heading', { name: t }).closest<HTMLElement>('.card');
    expect(cardDe('Despesas Variáveis')?.className).toContain('self-start');
    expect(cardDe('Despesas Fixas')?.className).not.toContain('self-start');
    // fatias das legendas (cada donut com o seu recorte)
    expect(screen.getByText('Folha de Pagamento')).toBeInTheDocument();
    expect(screen.getByText('Transporte')).toBeInTheDocument();
    expect(screen.getByText('Custos')).toBeInTheDocument();
    expect(screen.getByText('Importações')).toBeInTheDocument();
  });

  it('os 5 anéis usam o MESMO diâmetro — o gerado para o maior valor (R$) do conjunto', async () => {
    // Correção 2026-07-22: a 1ª versão escalava CADA donut proporcionalmente ao seu próprio
    // total, o que com valores próximos (ex.: 340k vs 324k) produzia uma diferença de ~1px —
    // visualmente incoerente. Agora todos os 5 usam o diâmetro do MAIOR total (aqui o de
    // "Classificação Financeira", superset dos demais) — nunca assimétrico, nunca por acaso.
    render(<DashboardFinanceiro />);
    await screen.findByRole('heading', { name: 'Classificação Financeira' });
    const ringOf = (title: string): HTMLElement | null =>
      screen.getByRole('heading', { name: title }).closest<HTMLElement>('.card')
        ?.querySelector<HTMLElement>('.relative.shrink-0') ?? null;
    const tipo = ringOf('Classificação Financeira');
    const custoMerc = ringOf('Custos de Mercadorias');
    const custoImp = ringOf('Custos de Importação');
    const fixa = ringOf('Despesas Fixas');
    const variavel = ringOf('Despesas Variáveis');
    // tipoBreakdown soma 38000 (22000+10000+6000) — é o MAIOR total dos 5 → diâmetro no MÁXIMO.
    expect(tipo?.style.width).toBe('124px');
    // Os outros quatro — de totais BEM diferentes entre si (4000/6000/10000/22000) — recebem
    // o MESMO diâmetro do maior, não um valor proporcional ao próprio total.
    expect(custoMerc?.style.width).toBe('124px');
    expect(custoImp?.style.width).toBe('124px');
    expect(fixa?.style.width).toBe('124px');
    expect(variavel?.style.width).toBe('124px');
    // Furo (inset) também igual — acompanha o diâmetro, que agora é único.
    const holeOf = (el: HTMLElement | null): string | undefined =>
      el?.closest<HTMLElement>('.relative')?.querySelector<HTMLElement>('.rounded-full.bg-white')?.style.inset;
    expect(holeOf(custoMerc)).toBe(holeOf(tipo));
    expect(holeOf(custoImp)).toBe(holeOf(tipo));
    expect(holeOf(fixa)).toBe(holeOf(tipo));
    expect(holeOf(variavel)).toBe(holeOf(tipo));
  });

  it('o subtítulo do donut "Classificação Financeira" mostra mês + KPI (sem "Por tipo…")', async () => {
    render(<DashboardFinanceiro />);
    // Abre filtrado → subtítulo = "<mês> - A vencer em 7 dias", SEM o prefixo antigo.
    const sub = await screen.findByText(/ - A vencer em 7 dias$/);
    expect(sub.textContent).not.toMatch(/Por tipo/);
    // Limpar o filtro (✕) → volta a 'total' → só o mês, sem sufixo de KPI.
    fireEvent.click(screen.getByText(/filtrando: A vencer em 7 dias/i));
    await vi.waitFor(() => expect(screen.queryByText(/ - A vencer em 7 dias$/)).toBeNull());
  });

  // O card "Ranking de centros de custo" foi REMOVIDO em 2026-08-15 (decisão do usuário).
  it('renderiza o ranking de contas — e NÃO o de centros de custo, removido', async () => {
    render(<DashboardFinanceiro />);
    expect(await screen.findByText('Ranking de contas')).toBeInTheDocument();
    expect(screen.getByText('Transportadoras')).toBeInTheDocument();
    expect(screen.getByText('Mercadorias')).toBeInTheDocument();

    expect(screen.queryByText('Ranking de centros de custo')).not.toBeInTheDocument();
  });

  it('o ranking de contas mostra % de contas (não mais "N conta(s)") em linhas compactas', async () => {
    render(<DashboardFinanceiro />);
    const subgroupCard = (await screen.findByText('Ranking de contas')).closest<HTMLElement>('.card');
    if (!subgroupCard) throw new Error('card não encontrado');

    // Célula da direita = percentual do total de contas do escopo, não mais a contagem crua.
    expect(within(subgroupCard).getByText('80%')).toBeInTheDocument();
    expect(within(subgroupCard).getByText('20%')).toBeInTheDocument();
    // "conta(s)" não aparece mais DENTRO deste card (segue existindo alhures na página,
    // ex.: os cards de KPI — por isso o escopo é o card, não a página inteira).
    expect(within(subgroupCard).queryByText(/conta\(s\)/)).not.toBeInTheDocument();

    // `dense`: as linhas do ranking usam py-px (1px) — não `py-0.5` (2px, o normal).
    expect(screen.getByRole('button', { name: /Transportadoras/ }).className).toContain('py-px');
    expect(screen.getByRole('button', { name: /Transportadoras/ }).className).not.toContain('py-0.5');
    // A MOLDURA do card de ranking usa o mesmo padding dos donuts (`dense` → p-2.5): eles
    // agora são vizinhos na MESMA grade, e 2px de diferença apareceriam lado a lado.
    expect(subgroupCard.className).toContain('p-2.5');
  });

  it('não exibe mais as contas críticas e prioritárias', async () => {
    render(<DashboardFinanceiro />);
    await screen.findByText('Ranking de contas');
    expect(screen.queryByText('Contas críticas e prioritárias')).not.toBeInTheDocument();
  });

  it('clicar numa linha do ranking abre o card de detalhe com as contas do balde', async () => {
    render(<DashboardFinanceiro />);
    await screen.findByText('Ranking de contas');
    // O modal fica oculto até o clique.
    expect(screen.queryByRole('heading', { name: /Conta · Transportadoras/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Transportadoras/ }));

    expect(await screen.findByRole('heading', { name: 'Conta · Transportadoras' })).toBeInTheDocument();
    expect(screen.getByText('Fornecedor ABC')).toBeInTheDocument();       // fornecedor da conta filtrada
    expect(screen.getByText('4.5.01 — Fretes')).toBeInTheDocument();      // plano de conta
    expect(screen.getByText('1 conta(s) · Total R$ 500,00')).toBeInTheDocument();
  });

  it('clicar numa fatia da legenda de um donut abre o card de detalhe', async () => {
    render(<DashboardFinanceiro />);
    await screen.findByRole('heading', { name: 'Despesas Variáveis' });
    // A fatia "Transporte" do donut de despesas variáveis é um botão da legenda.
    fireEvent.click(screen.getByRole('button', { name: /Transporte/ }));
    expect(await screen.findByRole('heading', { name: 'Despesas Variáveis · Transporte' })).toBeInTheDocument();
  });

  it('o donut "Custos de Mercadorias" filtra o detalhe por typeGroupId=7 (não vaza tipo 6)', async () => {
    render(<DashboardFinanceiro />);
    await screen.findByRole('heading', { name: 'Custos de Mercadorias' });
    // A fatia 'Custos' do donut CM (nome acessível concatena SEM espaço: "CustosR$…";
    // a fatia da Classificação é "Custos de MercadoriasR$…" e não casa este regex).
    fireEvent.click(screen.getByRole('button', { name: /^CustosR\$/ }));
    expect(await screen.findByRole('heading', { name: 'Custos de Mercadorias · Custos' })).toBeInTheDocument();
    // Só a conta de subgrupo tipo 7 entra; a de tipo 6 (Fornecedor ABC) fica fora.
    expect(screen.getByText('Fornecedor CM')).toBeInTheDocument();
    expect(screen.queryByText('Fornecedor ABC')).toBeNull();
  });

  // 🔴 Achado de 2026-08-14: o donut novo precisa ser provado pelo WIRING da tela (clique →
  // drill), não só pela função pura `filterExpenseDetailRows` — é a mesma lição da Regra 2 do
  // CLAUDE.md que o achado `fmtSupplierName` deixou registrada (função pura correta não prova
  // que o call site passa o `typeGroupId` certo).
  it('o donut "Custos de Importação" filtra o detalhe por typeGroupId=9', async () => {
    render(<DashboardFinanceiro />);
    await screen.findByRole('heading', { name: 'Custos de Importação' });
    fireEvent.click(screen.getByRole('button', { name: /^ImportaçõesR\$/ }));
    expect(await screen.findByRole('heading', { name: 'Custos de Importação · Importações' })).toBeInTheDocument();
    // Só a conta de subgrupo tipo 9 entra; as de tipo 6/7 (Fornecedor ABC/CM) ficam fora.
    expect(screen.getByText('Fornecedor IMP')).toBeInTheDocument();
    expect(screen.queryByText('Fornecedor ABC')).toBeNull();
    expect(screen.queryByText('Fornecedor CM')).toBeNull();
  });
});
