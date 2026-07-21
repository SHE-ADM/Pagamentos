// src/pages/DashboardFinanceiro.tsx
// Dashboard financeiro escopado a DESPESAS (Indicadores financeiros). Mesma casca do
// dashboard de vencimentos (pages/Dashboard.tsx) — 5 KPIs e filtros de empresa/mês/escopo/
// KPI (que aqui ABRE em "A vencer") — mas sem o gráfico mês a mês e com os gráficos
// trocados para a dimensão contábil:
//   • donut "Tipo" — despesas por Tipo do subgrupo (Fixa/Variável)
//   • donut "Despesas Fixas" — despesas FIXAS por GRUPO do plano de contas
//   • donut "Despesas Variáveis" — idem, só as VARIÁVEIS (mesma dimensão, outro recorte)
//   • rankings por VALOR (R$): CENTROS DE CUSTO + PLANO DE CONTAS (no lugar do de fornecedores
//     e das "Contas críticas e prioritárias", que seguem só no de vencimentos)
// Dados reais via getFinancialDashboardData (filtra group.type_group_id === Despesas).
// Estilo 100% Tailwind; primitivos de gráfico reusados de components/dashboard/.
import { useEffect, useState, useCallback } from 'react';
import { FileText, CheckCircle2, Clock, TrendingUp, AlertCircle, Building2, ListTree } from 'lucide-react';
import { getFinancialDashboardData, type FinancialDashboardData } from '../services/supabase';
import { getErrorMessage } from '../lib/getErrorMessage';
import { useDashboardFilters } from '../hooks/useDashboardFilters';
import Alert from '../components/atoms/Alert';
import { MONTHS_FULL } from '../components/dashboard/constants';
import { ChartCard } from '../components/dashboard/ChartCard';
import { DonutCard } from '../components/dashboard/DonutCard';
import { DashboardHeader } from '../components/dashboard/DashboardHeader';
import { KpiRow, type KpiEntry } from '../components/dashboard/KpiRow';
import { RankingList } from '../components/dashboard/RankingList';

export default function DashboardFinanceiro() {
  const filters = useDashboardFilters('aVencer');
  const { month, year, scope, filter } = filters;
  const [data, setData] = useState<FinancialDashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
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

  return (
    <div className="flex flex-col h-full">
      <div className="h-0.5 bg-linear-to-r from-brand to-brand-dark" />
      <DashboardHeader
        title="Indicadores financeiros"
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

        {/* Donuts: Tipo (Fixa/Variável) e, na sequência, o grupo de despesa recortado por
            tipo — Despesas Fixas e Despesas Variáveis (nesta ordem). */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mb-3">
          <DonutCard
            title="Tipo"
            subtitle={`Por tipo (fixa/variável) · ${periodo}`}
            slices={data?.tipoBreakdown}
            size="lg"
          />
          <DonutCard
            title="Despesas Fixas"
            subtitle={`Por grupo de despesa · ${periodo}`}
            slices={data?.despesaFixaBreakdown}
            size="lg"
          />
          <DonutCard
            title="Despesas Variáveis"
            subtitle={`Por grupo de despesa · ${periodo}`}
            slices={data?.despesaVariavelBreakdown}
            size="lg"
          />
        </div>

        {/* Rankings por VALOR (R$): centros de custo + plano de contas */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <ChartCard
            title="Ranking de centros de custo"
            subtitle="Maiores valores por centro de custo no período"
            icon={Building2}
          >
            <RankingList rows={data?.costCenterRanking ?? []} />
          </ChartCard>

          <ChartCard
            title="Ranking de contas"
            subtitle="Maiores valores por plano de contas no período"
            icon={ListTree}
          >
            <RankingList rows={data?.chartAccountRanking ?? []} />
          </ChartCard>
        </div>
      </section>
    </div>
  );
}
