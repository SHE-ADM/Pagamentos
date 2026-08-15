// src/pages/DashboardFinanceiro.tsx
// Dashboard financeiro escopado a DESPESAS + CUSTO (Indicadores de despesas — Naturezas do
// GRUPO type_group_id 2 e 8). Mesma casca do dashboard de vencimentos (pages/Dashboard.tsx)
// — 5 KPIs e filtros de empresa/mês/escopo/KPI (as DUAS telas ABREM em "A vencer em 7 dias")
// — mas sem o gráfico mês a mês e com os gráficos trocados para a dimensão contábil. São 6
// cards numa GRADE ÚNICA de 3 linhas × 2 colunas (5 donuts size="sm"+dense, top-6 + "outros"
// — no máximo 7 fatias visíveis cada — mais o ranking):
//   • donut "Classificação Financeira" — por Tipo do subgrupo (Fixa/Variável/Custos de
//     Mercadorias/Importação)
//   • donut "Custos de Mercadorias" — custos (Tipo 7) por GRUPO do plano de contas
//   • donut "Despesas Fixas" — despesas FIXAS (Tipo 5) por GRUPO
//   • donut "Custos de Importação" — custos de importação (Tipo 9) por GRUPO — acrescentado em
//     2026-08-14: existia no catálogo e contava certo no TOTAL do dashboard, mas não entrava em
//     nenhum donut de tipo (mesma classe de bug do CASE hardcoded de `demonstrativo_despesas`,
//     do lado do TypeScript — ver o comentário em services/supabase.ts)
//   • donut "Despesas Variáveis" — idem, só as VARIÁVEIS (Tipo 6)
//   • "Ranking de contas" — por SUBGRUPO do plano de contas, por VALOR (R$) — linhas `dense`
//     (mais compactas, cabem mais registros) e célula da direita em % do total de contas do
//     escopo (`SupplierRank.pct`, calculado em `rankBy`), não mais "N conta(s)" — só aqui: o
//     ranking de fornecedores de /dashboard_vencimentos não passa `dense` nem preenche `pct`
//     e continua com a contagem
// O card "Ranking de centros de custo" foi REMOVIDO em 2026-08-15 (decisão do usuário); com
// ele saíram `costCenterRanking`, o alvo de drill 'costCenter' e as colunas/embed de centro
// de custo da leitura — nada mais nesta tela os consumia.
// Dados reais via getFinancialDashboardData (filtra group.type_group_id ∈ {Despesas, Custo}).
// Estilo 100% Tailwind; primitivos de gráfico reusados de components/dashboard/.
import { useEffect, useState, useCallback } from 'react';
import { FileText, CheckCircle2, Clock, TrendingUp, AlertCircle, ListTree } from 'lucide-react';
import {
  TYPE_GROUP_ID_DESPESA_FIXA,
  TYPE_GROUP_ID_DESPESA_VARIAVEL,
  TYPE_GROUP_ID_CUSTO_MERCADORIAS,
  TYPE_GROUP_ID_CUSTO_IMPORTACAO,
} from '@sheild/shared';
import {
  getFinancialDashboardData,
  filterExpenseDetailRows,
  type FinancialDashboardData,
  type ExpenseDetailRow,
  type ExpenseDrillTarget,
} from '../services/supabase';
import { getErrorMessage } from '../lib/getErrorMessage';
import { useDashboardFilters } from '../hooks/useDashboardFilters';
import Alert from '../components/atoms/Alert';
import { MONTHS_FULL, kpiFilterSuffix } from '../components/dashboard/constants';
import { ChartCard } from '../components/dashboard/ChartCard';
import { DonutCard } from '../components/dashboard/DonutCard';
import { DashboardHeader } from '../components/dashboard/DashboardHeader';
import { KpiRow, type KpiEntry } from '../components/dashboard/KpiRow';
import { RankingList } from '../components/dashboard/RankingList';
import { ExpenseDetailModal } from '../components/dashboard/ExpenseDetailModal';

// Diâmetro (px) de um anel, escalado entre MIN e MAX conforme a razão value/maxValue —
// utilitário genérico; a POLÍTICA de como `value`/`maxValue` são escolhidos (uniforme entre
// os 5 donuts ou proporcional por donut) fica no call site (ver `donutDiameter` abaixo).
// `value===maxValue` (ratio=1) sempre devolve MAX; `maxValue<=0` (sem dado) devolve MIN.
const DONUT_MIN_PX = 84;
const DONUT_MAX_PX = 124;

function sumSliceValues(slices: readonly { value: number }[] | undefined): number {
  return (slices ?? []).reduce((s, x) => s + x.value, 0);
}

function scaledDonutDiameter(value: number, maxValue: number): number {
  if (maxValue <= 0) return DONUT_MIN_PX;
  const ratio = Math.min(1, Math.max(0, value / maxValue));
  return Math.round(DONUT_MIN_PX + ratio * (DONUT_MAX_PX - DONUT_MIN_PX));
}

export default function DashboardFinanceiro() {
  const filters = useDashboardFilters('vencendo7');
  const { month, year, scope, filter } = filters;
  const [data, setData] = useState<FinancialDashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Card de detalhe (drill-down): as contas de uma fatia/linha clicada, filtradas EM MEMÓRIA
  // a partir de data.detailRows (= as linhas que geraram os gráficos). Sem leitura extra.
  const [drill, setDrill] = useState<{ title: string; rows: ExpenseDetailRow[] } | null>(null);
  const openDrill = (target: ExpenseDrillTarget, title: string): void => {
    if (!data) return;
    const rows = filterExpenseDetailRows(data.detailRows, target);
    // Uma fatia/linha renderizada sempre tem ≥1 conta correspondente; abrir vazio só
    // ocorreria por identidade de balde inválida (ex.: bucketKey ausente) — não abre.
    if (!rows.length) return;
    setDrill({ title, rows });
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Fecha o card de detalhe ao recarregar: o modal guarda um SNAPSHOT de detailRows; se os
    // dados mudam (mês/empresa/KPI), o snapshot ficaria obsoleto. Hoje é defensivo (o
    // <dialog> modal deixa os controles inertes), mas cobre qualquer refetch futuro.
    setDrill(null);
    try {
      setData(await getFinancialDashboardData(month, year, scope, filter, filters.skCompany));
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [month, year, scope, filter, filters.skCompany]);


  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const k = data?.kpis;
  const kpis: KpiEntry[] = [
    { icon: FileText, label: scope === 'all' ? 'Total de despesas' : 'Despesas no mês', amount: k?.totalValue ?? 0, count: k?.totalCount ?? 0, tone: 'neutral', filter: 'total' },
    { icon: CheckCircle2, label: 'Pagas', amount: k?.pagoValue ?? 0, count: k?.pagoCount ?? 0, tone: 'success', filter: 'pago' },
    { icon: Clock, label: 'A vencer', amount: k?.aVencerValue ?? 0, count: k?.aVencerCount ?? 0, tone: 'muted', filter: 'aVencer' },
    { icon: TrendingUp, label: 'A vencer em 7 dias', amount: k?.vencendoValue ?? 0, count: k?.vencendoCount ?? 0, tone: 'muted', filter: 'vencendo7' },
    { icon: AlertCircle, label: 'Vencidas', amount: k?.vencidasValue ?? 0, count: k?.vencidasCount ?? 0, tone: 'danger', filter: 'vencidas' },
  ];

  // Rótulo do período, repetido no subtítulo dos donuts (extraído do JSX — ternário
  // inline repetido dispara S3358 no SonarLint).
  const periodo = scope === 'all' ? 'Todas as contas' : MONTHS_FULL[month];
  // Sufixo do KPI ativo no subtítulo do donut "Classificação Financeira" (ex.: mês +
  // "Julho - A vencer"). 'total' = sem filtro → só o mês, sem sufixo. O helper é
  // compartilhado com /dashboard_vencimentos — ver `kpiFilterSuffix` em constants.ts.
  const kpiSuffix = kpiFilterSuffix(filter);

  // Diâmetro ÚNICO para os 5 donuts: o tamanho que `scaledDonutDiameter` gera para o MAIOR
  // valor total (R$) entre eles, reaplicado IGUAL nos outros quatro (decisão do usuário
  // 2026-07-22 — corrige a 1ª tentativa de escala proporcional POR donut: com valores
  // próximos entre si — ex. Despesas Fixas R$340k vs Custos de Mercadorias R$324k — a
  // diferença de diâmetro ficava de ~1px, visualmente incoerente/aleatória, sem comunicar
  // nada). Continua "gerado dinamicamente" (não é uma constante hard-coded): varia com o
  // maior total do período/filtro; só não varia mais ENTRE os 5 cards na mesma tela.
  // Com `data` nulo (carregando) ou os 5 totais zerados, cai no MIN (scaledDonutDiameter).
  const maxDonutTotal = Math.max(
    sumSliceValues(data?.tipoBreakdown),
    sumSliceValues(data?.custoMercadoriasBreakdown),
    sumSliceValues(data?.custoImportacaoBreakdown),
    sumSliceValues(data?.despesaFixaBreakdown),
    sumSliceValues(data?.despesaVariavelBreakdown),
  );
  const donutDiameter = scaledDonutDiameter(maxDonutTotal, maxDonutTotal);

  return (
    <div className="flex flex-col h-full">
      <div className="h-0.5 bg-linear-to-r from-brand to-brand-dark" />
      <DashboardHeader
        title="Indicadores de despesas"
        subject="Despesas"
        idPrefix="dashboard-financeiro"
        filters={filters}
        loading={loading}
        onRefresh={load}
      />

      {/* Região rolável nomeada (WCAG 2.1.1): <section> com aria-label expõe role=region
          IMPLÍCITO (sem role=; S6819); os KPIs (<button>) dão acesso por teclado (S6845). */}
      <section
        className="flex-1 overflow-y-auto px-6 py-3"
        aria-label="Indicadores e gráficos"
      >
        {error && (
          <Alert variant="error" className="mb-4">
            <strong>Erro:</strong> {error}
          </Alert>
        )}

        {/* Faixa de KPIs (cards clicáveis = filtro; ver KpiCard/KpiRow) */}
        <KpiRow items={kpis} filter={filter} onToggle={filters.toggleFilter} />

        {/* Grade ÚNICA 3×2 (5 donuts + o ranking de contas na 6ª célula) — decisão do usuário
            2026-08-15. Antes eram DUAS grades irmãs (donuts, depois rankings); um donut e um
            ranking só dividem a mesma linha estando na MESMA grade.
              linha 1 = Classificação Financeira + Custos de Mercadorias
              linha 2 = Despesas Fixas          + Custos de Importação
              linha 3 = Despesas Variáveis      + Ranking de contas
            A ordem VISUAL é a ordem do DOM — nenhuma classe `order-*` —, então leitor de tela
            e ordem de tabulação seguem o que se vê.
            ⚠️ A ordem NÃO espelha mais o `line_order` de analytics.demonstrativo_despesas
            (1 Mercadorias, 2 Importação, 3 Fixas, 4 Variáveis): Fixas passou à frente de
            Importação a pedido do usuário. Não "corrigir" de volta achando que é engano.
            `sm:grid-cols-2` (não o `lg:` que a grade dos rankings usava): o donut é o card
            com largura CRÍTICA — anel de 124px + legenda com R$ que não quebra —, enquanto a
            linha do ranking degrada truncando o nome; manter o `lg:` colapsaria os 5 donuts
            numa coluna só entre 640px e 1024px para proteger 1 card.
            size="sm" + dense nos 5 donuts, e `dense` TAMBÉM no card de ranking: agora eles são
            vizinhos na mesma grade, e 2px de diferença de moldura apareceriam lado a lado.
            `diameterPx` sobrepõe o diâmetro de `size` com o MESMO valor `donutDiameter` nos 5
            (ver o comentário de `donutDiameter` acima — pedido do usuário 2026-07-22). */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <DonutCard
            title="Classificação Financeira"
            subtitle={`${periodo}${kpiSuffix}`}
            slices={data?.tipoBreakdown}
            size="sm"
            dense
            diameterPx={donutDiameter}
            onSliceSelect={(label) => openDrill({ chart: 'tipo', label }, `Classificação Financeira · ${label}`)}
          />
          <DonutCard
            title="Custos de Mercadorias"
            subtitle={`Por grupo · ${periodo}`}
            slices={data?.custoMercadoriasBreakdown}
            size="sm"
            dense
            diameterPx={donutDiameter}
            onSliceSelect={(label) => openDrill({ chart: 'grupoTipo', typeGroupId: TYPE_GROUP_ID_CUSTO_MERCADORIAS, label }, `Custos de Mercadorias · ${label}`)}
          />
          <DonutCard
            title="Despesas Fixas"
            subtitle={`Por grupo · ${periodo}`}
            slices={data?.despesaFixaBreakdown}
            size="sm"
            dense
            diameterPx={donutDiameter}
            onSliceSelect={(label) => openDrill({ chart: 'grupoTipo', typeGroupId: TYPE_GROUP_ID_DESPESA_FIXA, label }, `Despesas Fixas · ${label}`)}
          />
          <DonutCard
            title="Custos de Importação"
            subtitle={`Por grupo · ${periodo}`}
            slices={data?.custoImportacaoBreakdown}
            size="sm"
            dense
            diameterPx={donutDiameter}
            onSliceSelect={(label) => openDrill({ chart: 'grupoTipo', typeGroupId: TYPE_GROUP_ID_CUSTO_IMPORTACAO, label }, `Custos de Importação · ${label}`)}
          />
          {/* `self-start` SÓ neste donut: é o único que divide a linha com um card de altura
              bem maior (o ranking, até 12 linhas sem scroll próprio). No `stretch` — padrão do
              grid — a moldura dele esticaria até a altura do ranking e deixaria ~150px de
              BRANCO sob o anel, gastando exatamente a altura de viewport que a decisão
              "donuts compactos de propósito" (2026-07-22) existe para poupar. Não subir isso
              para `items-start` no container: as linhas 1 e 2 emparelham dois donuts, e lá o
              `stretch` é o que mantém as molduras da mesma altura com legendas de tamanhos
              diferentes. */}
          <DonutCard
            title="Despesas Variáveis"
            subtitle={`Por grupo · ${periodo}`}
            slices={data?.despesaVariavelBreakdown}
            size="sm"
            dense
            className="self-start"
            diameterPx={donutDiameter}
            onSliceSelect={(label) => openDrill({ chart: 'grupoTipo', typeGroupId: TYPE_GROUP_ID_DESPESA_VARIAVEL, label }, `Despesas Variáveis · ${label}`)}
          />
          <ChartCard
            title="Ranking de contas"
            subtitle="Maiores valores por sub grupo de contas no período"
            icon={ListTree}
            dense
          >
            <RankingList
              rows={data?.subgroupRanking ?? []}
              onSelect={(row) => openDrill({ chart: 'subgroup', bucketKey: row.key }, `Conta · ${row.name}`)}
              dense
            />
          </ChartCard>
        </div>
      </section>

      <ExpenseDetailModal
        open={!!drill}
        title={drill?.title ?? ''}
        rows={drill?.rows ?? []}
        onClose={() => setDrill(null)}
      />
    </div>
  );
}
