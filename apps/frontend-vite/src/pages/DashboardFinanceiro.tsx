// src/pages/DashboardFinanceiro.tsx
// Dashboard financeiro escopado a DESPESAS (Indicadores financeiros). Mesma casca do
// dashboard de vencimentos (pages/Dashboard.tsx) — 5 KPIs e filtros de empresa/mês/escopo/
// KPI (que aqui ABRE em "A vencer") — mas sem o gráfico mês a mês e com os gráficos
// trocados para a dimensão contábil:
//   • donut "Tipo" — despesas por Tipo do subgrupo (Fixa/Variável)
//   • donut "Natureza" — despesas por GRUPO do plano de contas
//   • rankings por VALOR (R$): SUBGRUPOS + PLANO DE CONTAS (no lugar do de fornecedores
//     e das "Contas críticas e prioritárias", que seguem só no de vencimentos)
// Dados reais via getFinancialDashboardData (filtra group.type_group_id === Despesas).
// Estilo 100% Tailwind; primitivos de gráfico reusados de components/dashboard/.
import { useEffect, useState, useCallback } from 'react';
import { FileText, CheckCircle2, Clock, TrendingUp, AlertCircle, Layers, ListTree } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { getFinancialDashboardData, type FinancialDashboardData, type DashboardScope, type KpiFilter } from '../services/supabase';
import { getErrorMessage } from '../lib/getErrorMessage';
import { useCompanyOptions } from '../hooks/useCompanyOptions';
import Alert from '../components/atoms/Alert';
import { MONTHS_FULL } from '../components/dashboard/constants';
import { paletteColor } from '../components/dashboard/chartColors';
import { BreakdownDonut } from '../components/dashboard/BreakdownDonut';
import { DashboardHeader } from '../components/dashboard/DashboardHeader';
import { KpiCard } from '../components/dashboard/KpiCard';
import type { KpiTone } from '../components/dashboard/kpiCard.variants';
import { RankingList } from '../components/dashboard/RankingList';

export default function DashboardFinanceiro() {
  // Inicializador LAZY — não chamar new Date() no corpo do render (impureza; React Compiler).
  const [month, setMonth] = useState(() => new Date().getMonth());
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [scope, setScope] = useState<DashboardScope>('month');
  // Abre FILTRADO por "A vencer" (pedido do usuário) — os cards de KPI seguem com os
  // totais completos; clicar no card ativo (ou no ✕ do cabeçalho) volta para 'total'.
  const [filter, setFilter] = useState<KpiFilter>('aVencer');
  const [skCompany, setSkCompany] = useState<number | undefined>(undefined);
  const companyOptions = useCompanyOptions();
  const [data, setData] = useState<FinancialDashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getFinancialDashboardData(month, year, scope, filter, skCompany));
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [month, year, scope, filter, skCompany]);

  const toggleFilter = (f: KpiFilter): void => setFilter((cur) => (cur === f ? 'total' : f));

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const k = data?.kpis;
  const kpis: { icon: LucideIcon; label: string; amount: number; count: number; tone: KpiTone; filter: KpiFilter }[] = [
    { icon: FileText, label: scope === 'all' ? 'Total de despesas' : 'Despesas no mês', amount: k?.totalValue ?? 0, count: k?.totalCount ?? 0, tone: 'neutral', filter: 'total' },
    { icon: CheckCircle2, label: 'Pagas', amount: k?.pagoValue ?? 0, count: k?.pagoCount ?? 0, tone: 'success', filter: 'pago' },
    { icon: Clock, label: 'A vencer', amount: k?.aVencerValue ?? 0, count: k?.aVencerCount ?? 0, tone: 'muted', filter: 'aVencer' },
    { icon: TrendingUp, label: 'A vencer em 7 dias', amount: k?.vencendoValue ?? 0, count: k?.vencendoCount ?? 0, tone: 'muted', filter: 'vencendo7' },
    { icon: AlertCircle, label: 'Vencidas', amount: k?.vencidasValue ?? 0, count: k?.vencidasCount ?? 0, tone: 'danger', filter: 'vencidas' },
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="h-0.5 bg-linear-to-r from-brand to-brand-dark" />
      <DashboardHeader
        title="Indicadores financeiros"
        subject="Despesas"
        idPrefix="dashboard-financeiro"
        month={month}
        year={year}
        scope={scope}
        filter={filter}
        skCompany={skCompany}
        companyOptions={companyOptions}
        loading={loading}
        onMonthChange={setMonth}
        onYearChange={setYear}
        onScopeChange={setScope}
        onClearFilter={() => setFilter('total')}
        onCompanyChange={setSkCompany}
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

        {/* Faixa de KPIs (cards clicáveis = filtro; ver KpiCard) */}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2 mb-3">
          {kpis.map(({ icon, label, amount, count, tone, filter: kpiFilter }) => (
            <KpiCard
              key={label}
              icon={icon}
              label={label}
              amount={amount}
              count={count}
              tone={tone}
              // 'total' nunca fica "ativo" — é o estado SEM filtro.
              active={filter === kpiFilter && kpiFilter !== 'total'}
              onClick={() => toggleFilter(kpiFilter)}
            />
          ))}
        </div>

        {/* Donuts: Tipo (Fixa/Variável) e Natureza (por grupo) */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
          <div className="card p-3">
            <div className="mb-2">
              <h3 className="text-sm font-semibold text-slate-800">Tipo</h3>
              <p className="text-xs text-slate-500">Por tipo (fixa/variável) · {scope === 'all' ? 'Todas as contas' : MONTHS_FULL[month]}</p>
            </div>
            <BreakdownDonut
              segs={(data?.tipoBreakdown ?? []).map((s) => ({ key: s.label, label: s.label, value: s.value }))}
              colorFor={paletteColor}
              size="lg"
            />
          </div>

          <div className="card p-3">
            <div className="mb-2">
              <h3 className="text-sm font-semibold text-slate-800">Natureza</h3>
              <p className="text-xs text-slate-500">Por grupo de despesa · {scope === 'all' ? 'Todas as contas' : MONTHS_FULL[month]}</p>
            </div>
            <BreakdownDonut
              segs={(data?.naturezaBreakdown ?? []).map((s) => ({ key: s.label, label: s.label, value: s.value }))}
              colorFor={paletteColor}
              size="lg"
            />
          </div>
        </div>

        {/* Rankings por VALOR (R$): subgrupos + plano de contas */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="card p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-brand/10 text-brand"><Layers size={14} /></span>
              <div>
                <h3 className="text-sm font-semibold text-slate-800">Ranking de subgrupos</h3>
                <p className="text-xs text-slate-500">Maiores valores por subgrupo no período</p>
              </div>
            </div>
            <RankingList rows={data?.subgroupRanking ?? []} />
          </div>

          <div className="card p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-brand/10 text-brand"><ListTree size={14} /></span>
              <div>
                <h3 className="text-sm font-semibold text-slate-800">Ranking de contas</h3>
                <p className="text-xs text-slate-500">Maiores valores por plano de contas no período</p>
              </div>
            </div>
            <RankingList rows={data?.chartAccountRanking ?? []} />
          </div>
        </div>
      </section>
    </div>
  );
}
