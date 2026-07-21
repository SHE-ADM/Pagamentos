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
import { statusColor, paletteColor } from '../components/dashboard/chartColors';
import { BreakdownDonut, type DonutSize } from '../components/dashboard/BreakdownDonut';
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
          <div className="card p-2.5">
            <div className="mb-2">
              <h3 className="text-sm font-semibold text-slate-800">Minha situação</h3>
              <p className="text-xs text-slate-500">Por status · {scope === 'all' ? 'Todas as contas' : MONTHS_FULL[month]}</p>
            </div>
            <StatusDonut data={data} size="sm" />
          </div>

          <div className="card p-2.5">
            <div className="mb-2">
              <h3 className="text-sm font-semibold text-slate-800">Tipos de contas</h3>
              <p className="text-xs text-slate-500">Por tipo de documento · {scope === 'all' ? 'Todas as contas' : MONTHS_FULL[month]}</p>
            </div>
            <BreakdownDonut
              segs={(data?.documentTypeBreakdown ?? []).map((s) => ({ key: s.label, label: s.label, value: s.value }))}
              colorFor={paletteColor}
              size="sm"
            />
          </div>

          <div className="card p-2.5">
            <div className="mb-2">
              <h3 className="text-sm font-semibold text-slate-800">Tributos</h3>
              <p className="text-xs text-slate-500">Por tipo de guia · {scope === 'all' ? 'Todas as contas' : MONTHS_FULL[month]}</p>
            </div>
            <BreakdownDonut
              segs={(data?.taxTypeBreakdown ?? []).map((s) => ({ key: s.label, label: s.label, value: s.value }))}
              colorFor={paletteColor}
              size="sm"
            />
          </div>

          <div className="card p-2.5">
            <div className="mb-2">
              <h3 className="text-sm font-semibold text-slate-800">Tipos de pagamentos</h3>
              <p className="text-xs text-slate-500">Por forma de pagamento · {scope === 'all' ? 'Todas as contas' : MONTHS_FULL[month]}</p>
            </div>
            <BreakdownDonut
              segs={(data?.paymentMethodBreakdown ?? []).map((s) => ({ key: s.label, label: s.label, value: s.value }))}
              colorFor={paletteColor}
              size="sm"
            />
          </div>
        </div>

        {/* Ranking + Prioritárias */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="card p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-brand/10 text-brand"><Building2 size={14} /></span>
              <div>
                <h3 className="text-sm font-semibold text-slate-800">Ranking de fornecedores</h3>
                <p className="text-xs text-slate-500">Maiores valores no período</p>
              </div>
            </div>
            <RankingList rows={data?.supplierRanking ?? []} />
          </div>

          <div className="card p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-status-error-solid/10 text-status-error-fg"><Zap size={14} /></span>
              <div>
                <h3 className="text-sm font-semibold text-slate-800">Contas críticas e prioritárias</h3>
                <p className="text-xs text-slate-500">Água, luz, internet, aluguel, tributos e vencidas</p>
              </div>
            </div>
            <PriorityList rows={data?.priorityAccounts ?? []} />
          </div>
        </div>
      </section>
    </div>
  );
}

// ── sub-componente local (não exportado) ────────────────────────────────────

// Situação por status: cor semântica por nome de status (ignora o índice da paleta).
// Fica local porque só o dashboard de vencimentos tem o donut de situação (o financeiro
// usa apenas Natureza/Tipo). Delega ao BreakdownDonut compartilhado.
function StatusDonut({ data, size }: { data: DashboardData | null; size?: DonutSize }) {
  const segs = (data?.statusBreakdown ?? []).map((s) => ({ key: s.status, label: s.status, value: s.value }));
  return <BreakdownDonut segs={segs} colorFor={(label) => statusColor(label)} size={size} />;
}
