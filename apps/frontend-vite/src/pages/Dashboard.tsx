// src/pages/Dashboard.tsx
// Dashboard financeiro de contas a pagar. Abre SEMPRE no mês atual.
// Dados reais via getDashboardData (services/supabase.ts).
// Estilo 100% Tailwind (Regra 1). Estilo inline só onde não há classe equivalente:
// gradiente cônico do donut e larguras dinâmicas de barra (exceções justificadas).
import { useEffect, useState, useCallback } from 'react';
import { FileText, CheckCircle2, Clock, TrendingUp, AlertCircle, Building2, Zap } from 'lucide-react';
import { getDashboardData, type DashboardData } from '../services/supabase';
import { getErrorMessage } from '../lib/getErrorMessage';
import { useDashboardFilters } from '../hooks/useDashboardFilters';
import Alert from '../components/atoms/Alert';
import { MONTHS_FULL } from '../components/dashboard/constants';
import { statusColor } from '../components/dashboard/chartColors';
import { ChartCard } from '../components/dashboard/ChartCard';
import { DonutCard } from '../components/dashboard/DonutCard';
import { DashboardHeader } from '../components/dashboard/DashboardHeader';
import { KpiRow, type KpiEntry } from '../components/dashboard/KpiRow';
import { MonthlyFlow } from '../components/dashboard/MonthlyFlow';
import { RankingList } from '../components/dashboard/RankingList';
import { PriorityList } from '../components/dashboard/PriorityList';

export default function Dashboard() {
  const filters = useDashboardFilters();
  const { month, year, scope, filter } = filters;
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getDashboardData(month, year, scope, filter, filters.skCompany));
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
    { icon: FileText, label: scope === 'all' ? 'Total a pagar' : 'Total a pagar no mês', amount: k?.totalValue ?? 0, count: k?.totalCount ?? 0, tone: 'neutral', filter: 'total' },
    { icon: CheckCircle2, label: 'Pagos', amount: k?.pagoValue ?? 0, count: k?.pagoCount ?? 0, tone: 'success', filter: 'pago' },
    { icon: Clock, label: 'A vencer', amount: k?.aVencerValue ?? 0, count: k?.aVencerCount ?? 0, tone: 'muted', filter: 'aVencer' },
    { icon: TrendingUp, label: 'A vencer em 7 dias', amount: k?.vencendoValue ?? 0, count: k?.vencendoCount ?? 0, tone: 'muted', filter: 'vencendo7' },
    { icon: AlertCircle, label: 'Vencidas', amount: k?.vencidasValue ?? 0, count: k?.vencidasCount ?? 0, tone: 'danger', filter: 'vencidas' },
  ];

  // Rótulo do período, repetido no subtítulo dos 4 donuts (extraído do JSX — ternário
  // inline repetido dispara S3358 no SonarLint).
  const periodo = scope === 'all' ? 'Todas as contas' : MONTHS_FULL[month];

  return (
    <div className="flex flex-col h-full">
      <div className="h-0.5 bg-linear-to-r from-brand to-brand-dark" />
      <DashboardHeader
        title="Dashboard financeiro"
        subject="Contas a pagar"
        idPrefix="dashboard"
        filters={filters}
        loading={loading}
        onRefresh={load}
      />

      {/* Região rolável nomeada (WCAG 2.1.1 / axe scrollable-region-focusable): o
          <section> com aria-label expõe o papel "region" IMPLÍCITO (sem role=; S6819) e
          os cards de KPI (<button>, logo abaixo) são os descendentes FOCÁVEIS que dão
          acesso por teclado à rolagem — daí NÃO precisar tabIndex no contêiner (S6845).
          Os 5 KPIs são estáticos: sempre há botão focável, mesmo em loading/vazio. */}
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

        {/* Movimentações mês a mês (largura total) */}
        <div className="card p-3 mb-3">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-800">Movimentações mês a mês</h3>
              <p className="text-xs text-slate-500">Total a pagar vs. pago por vencimento — {year}</p>
            </div>
            <span className="text-xs text-slate-500">valores em R$</span>
          </div>
          <MonthlyFlow flow={data?.monthlyFlow ?? []} />
        </div>

        {/* 4 donuts na mesma linha (xl), círculo `sm` p/ caber R$ + % no espaço estreito. */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2 mb-3">
          {/* Situação: cor SEMÂNTICA por status (não a paleta cíclica dos demais). As
              fatias vêm com a chave `status`, então o adaptador é local. */}
          <DonutCard
            title="Minha situação"
            subtitle={`Por status · ${periodo}`}
            slices={(data?.statusBreakdown ?? []).map((s) => ({ label: s.status, value: s.value }))}
            colorFor={(label) => statusColor(label)}
            size="sm"
            dense
          />
          <DonutCard
            title="Tipos de contas"
            subtitle={`Por tipo de documento · ${periodo}`}
            slices={data?.documentTypeBreakdown}
            size="sm"
            dense
          />
          <DonutCard
            title="Tributos"
            subtitle={`Por tipo de guia · ${periodo}`}
            slices={data?.taxTypeBreakdown}
            size="sm"
            dense
          />
          <DonutCard
            title="Tipos de pagamentos"
            subtitle={`Por forma de pagamento · ${periodo}`}
            slices={data?.paymentMethodBreakdown}
            size="sm"
            dense
          />
        </div>

        {/* Ranking + Prioritárias */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <ChartCard
            title="Ranking de fornecedores"
            subtitle="Maiores valores no período"
            icon={Building2}
          >
            <RankingList rows={data?.supplierRanking ?? []} />
          </ChartCard>

          <ChartCard
            title="Contas críticas e prioritárias"
            subtitle="Água, luz, internet, aluguel, tributos e vencidas"
            icon={Zap}
            tone="danger"
          >
            <PriorityList rows={data?.priorityAccounts ?? []} />
          </ChartCard>
        </div>
      </section>
    </div>
  );
}
