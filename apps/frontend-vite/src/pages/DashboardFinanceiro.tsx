// src/pages/DashboardFinanceiro.tsx
// Dashboard financeiro escopado a DESPESAS + CUSTO (Indicadores de despesas — Naturezas do
// GRUPO type_group_id 2 e 8). Mesma casca do dashboard de vencimentos (pages/Dashboard.tsx)
// — 5 KPIs e filtros de empresa/mês/escopo/KPI (que aqui ABRE em "A vencer") — mas sem o
// gráfico mês a mês e com os gráficos trocados para a dimensão contábil (4 donuts numa linha):
//   • donut "Classificação Financeira" — por Tipo do subgrupo (Fixa/Variável/Custos de Mercadorias)
//   • donut "Custos de Mercadorias" — custos (Tipo 7) por GRUPO do plano de contas
//   • donut "Despesas Fixas" — despesas FIXAS (Tipo 5) por GRUPO
//   • donut "Despesas Variáveis" — idem, só as VARIÁVEIS (Tipo 6)
//   • rankings por VALOR (R$): CENTROS DE CUSTO + PLANO DE CONTAS (no lugar do de fornecedores
//     e das "Contas críticas e prioritárias", que seguem só no de vencimentos)
// Dados reais via getFinancialDashboardData (filtra group.type_group_id ∈ {Despesas, Custo}).
// Estilo 100% Tailwind; primitivos de gráfico reusados de components/dashboard/.
import { useEffect, useState, useCallback } from 'react';
import { FileText, CheckCircle2, Clock, TrendingUp, AlertCircle, Building2, ListTree } from 'lucide-react';
import {
  TYPE_GROUP_ID_DESPESA_FIXA,
  TYPE_GROUP_ID_DESPESA_VARIAVEL,
  TYPE_GROUP_ID_CUSTO_MERCADORIAS,
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
import { MONTHS_FULL, KPI_FILTER_LABEL } from '../components/dashboard/constants';
import { ChartCard } from '../components/dashboard/ChartCard';
import { DonutCard } from '../components/dashboard/DonutCard';
import { DashboardHeader } from '../components/dashboard/DashboardHeader';
import { KpiRow, type KpiEntry } from '../components/dashboard/KpiRow';
import { RankingList } from '../components/dashboard/RankingList';
import { ExpenseDetailModal } from '../components/dashboard/ExpenseDetailModal';

export default function DashboardFinanceiro() {
  const filters = useDashboardFilters('aVencer');
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

  // Rótulo do período, repetido no subtítulo dos 3 donuts (extraído do JSX — ternário
  // inline repetido dispara S3358 no SonarLint).
  const periodo = scope === 'all' ? 'Todas as contas' : MONTHS_FULL[month];
  // Sufixo do KPI ativo no subtítulo do donut "Classificação Financeira" (ex.: mês +
  // "Julho - A vencer"). 'total' = sem filtro → só o mês, sem sufixo.
  const kpiSuffix = filter === 'total' ? '' : ` - ${KPI_FILTER_LABEL[filter]}`;

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

        {/* Donuts (4, na MESMA linha no xl — size sm, mesmo padrão do /dashboard_vencimentos):
            Classificação Financeira (por Tipo do subgrupo) e, na sequência, o GRUPO recortado
            por tipo — Custos de Mercadorias, Despesas Fixas e Despesas Variáveis. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 mb-3">
          <DonutCard
            title="Classificação Financeira"
            subtitle={`${periodo}${kpiSuffix}`}
            slices={data?.tipoBreakdown}
            size="sm"
            onSliceSelect={(label) => openDrill({ chart: 'tipo', label }, `Classificação Financeira · ${label}`)}
          />
          <DonutCard
            title="Custos de Mercadorias"
            subtitle={`Por grupo · ${periodo}`}
            slices={data?.custoMercadoriasBreakdown}
            size="sm"
            onSliceSelect={(label) => openDrill({ chart: 'grupoTipo', typeGroupId: TYPE_GROUP_ID_CUSTO_MERCADORIAS, label }, `Custos de Mercadorias · ${label}`)}
          />
          <DonutCard
            title="Despesas Fixas"
            subtitle={`Por grupo · ${periodo}`}
            slices={data?.despesaFixaBreakdown}
            size="sm"
            onSliceSelect={(label) => openDrill({ chart: 'grupoTipo', typeGroupId: TYPE_GROUP_ID_DESPESA_FIXA, label }, `Despesas Fixas · ${label}`)}
          />
          <DonutCard
            title="Despesas Variáveis"
            subtitle={`Por grupo · ${periodo}`}
            slices={data?.despesaVariavelBreakdown}
            size="sm"
            onSliceSelect={(label) => openDrill({ chart: 'grupoTipo', typeGroupId: TYPE_GROUP_ID_DESPESA_VARIAVEL, label }, `Despesas Variáveis · ${label}`)}
          />
        </div>

        {/* Rankings por VALOR (R$): centros de custo + plano de contas */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <ChartCard
            title="Ranking de centros de custo"
            subtitle="Maiores valores por centro de custo no período"
            icon={Building2}
          >
            <RankingList
              rows={data?.costCenterRanking ?? []}
              onSelect={(row) => openDrill({ chart: 'costCenter', bucketKey: row.key }, `Centro de custo · ${row.name}`)}
            />
          </ChartCard>

          <ChartCard
            title="Ranking de contas"
            subtitle="Maiores valores por sub grupo de contas no período"
            icon={ListTree}
          >
            <RankingList
              rows={data?.subgroupRanking ?? []}
              onSelect={(row) => openDrill({ chart: 'subgroup', bucketKey: row.key }, `Conta · ${row.name}`)}
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
