// src/pages/DashboardFinanceiro.tsx
// Dashboard financeiro escopado a DESPESAS (Indicadores financeiros). Mesma casca do
// dashboard de vencimentos (pages/Dashboard.tsx) — 5 KPIs, filtros de empresa/mês/escopo/
// KPI e gráfico mês a mês — mas com os gráficos trocados para a dimensão contábil:
//   • donut "Natureza" — despesas por GRUPO do plano de contas
//   • donut "Tipo" — despesas por Tipo do subgrupo (Fixa/Variável)
//   • ranking de SUBGRUPOS de despesa (no lugar do de fornecedores)
// Dados reais via getFinancialDashboardData (filtra group.type_group_id === Despesas).
// Estilo 100% Tailwind; primitivos de gráfico reusados de components/dashboard/.
import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, FileText, CheckCircle2, Clock, TrendingUp, AlertCircle, Layers, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { getFinancialDashboardData, type FinancialDashboardData, type DashboardScope, type KpiFilter } from '../services/supabase';
import { getErrorMessage } from '../lib/getErrorMessage';
import { useCompanyOptions } from '../hooks/useCompanyOptions';
import Alert from '../components/atoms/Alert';
import { fmtMoney } from '../lib/format';
import { MONTHS, MONTHS_FULL } from '../components/dashboard/constants';
import { paletteColor } from '../components/dashboard/chartColors';
import { BreakdownDonut } from '../components/dashboard/BreakdownDonut';
import { MonthlyFlow } from '../components/dashboard/MonthlyFlow';
import { RankingList } from '../components/dashboard/RankingList';
import { PriorityList } from '../components/dashboard/PriorityList';

// Rótulo pt-BR do filtro ativo (indicador no cabeçalho).
const KPI_FILTER_LABEL: Record<KpiFilter, string> = {
  total: 'Todos', pago: 'Pagos', aVencer: 'A vencer', vencendo7: 'A vencer em 7 dias', vencidas: 'Vencidas',
};

export default function DashboardFinanceiro() {
  // Inicializador LAZY — não chamar new Date() no corpo do render (impureza; React Compiler).
  const [month, setMonth] = useState(() => new Date().getMonth());
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [scope, setScope] = useState<DashboardScope>('month');
  const [filter, setFilter] = useState<KpiFilter>('total');
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
  const kpis: { icon: LucideIcon; label: string; amount: number; count: number; tone: 'neutral' | 'success' | 'muted' | 'danger'; filter: KpiFilter }[] = [
    { icon: FileText, label: scope === 'all' ? 'Total de despesas' : 'Despesas no mês', amount: k?.totalValue ?? 0, count: k?.totalCount ?? 0, tone: 'neutral', filter: 'total' },
    { icon: CheckCircle2, label: 'Pagas', amount: k?.pagoValue ?? 0, count: k?.pagoCount ?? 0, tone: 'success', filter: 'pago' },
    { icon: Clock, label: 'A vencer', amount: k?.aVencerValue ?? 0, count: k?.aVencerCount ?? 0, tone: 'muted', filter: 'aVencer' },
    { icon: TrendingUp, label: 'A vencer em 7 dias', amount: k?.vencendoValue ?? 0, count: k?.vencendoCount ?? 0, tone: 'muted', filter: 'vencendo7' },
    { icon: AlertCircle, label: 'Vencidas', amount: k?.vencidasValue ?? 0, count: k?.vencidasCount ?? 0, tone: 'danger', filter: 'vencidas' },
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="h-0.5 bg-linear-to-r from-brand to-brand-dark" />
      <div className="px-6 py-2 border-b border-slate-200 bg-white flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-sm font-semibold text-slate-800">Indicadores financeiros</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Despesas · {scope === 'all' ? 'Todas as contas' : `${MONTHS_FULL[month]} ${year}`}
            {filter !== 'total' && (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={() => setFilter('total')}
                  className="font-medium text-brand-dark hover:underline"
                >
                  filtrando: {KPI_FILTER_LABEL[filter]} ✕
                </button>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap justify-end">
          {/* Empresa pagadora — escopa TUDO (KPIs, donuts e gráfico anual). Vazio = TODAS. */}
          <select
            id="dashboard-financeiro-company"
            name="dashboard-financeiro-company"
            aria-label="Filtrar por empresa"
            className="input w-36 text-xs"
            value={skCompany == null ? '' : String(skCompany)}
            onChange={(e) => setSkCompany(e.target.value ? Number(e.target.value) : undefined)}
          >
            <option value="">Empresa</option>
            {companyOptions.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          {/* Escopo: mês selecionado vs. todas as contas */}
          <div className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5" role="group" aria-label="Escopo do dashboard">
            <button
              onClick={() => setScope('month')}
              aria-pressed={scope === 'month'}
              className={`text-xs font-medium px-2.5 py-1 rounded-sm transition-colors ${scope === 'month' ? 'bg-white text-slate-800 shadow-xs' : 'text-slate-500 hover:text-slate-700'}`}
            >
              Este mês
            </button>
            <button
              onClick={() => setScope('all')}
              aria-pressed={scope === 'all'}
              className={`text-xs font-medium px-2.5 py-1 rounded-sm transition-colors ${scope === 'all' ? 'bg-white text-slate-800 shadow-xs' : 'text-slate-500 hover:text-slate-700'}`}
            >
              Todas as contas
            </button>
          </div>
          <div className={`flex gap-0.5 flex-wrap transition-opacity ${scope === 'all' ? 'opacity-40 pointer-events-none' : ''}`} aria-hidden={scope === 'all'}>
            {MONTHS.map((m, i) => (
              <button
                key={m}
                onClick={() => setMonth(i)}
                aria-label={`Mês ${MONTHS_FULL[i]}`}
                aria-pressed={i === month}
                className={`text-xs px-2 py-0.5 rounded-sm transition-colors ${i === month ? 'bg-brand-light text-brand-dark font-semibold' : 'text-slate-500 hover:bg-slate-100'}`}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {[year - 1, year, year + 1].map((y) => (
              <button
                key={y}
                onClick={() => setYear(y)}
                aria-pressed={y === year}
                className={`text-xs font-medium px-2.5 py-1 rounded-md border transition-colors ${y === year ? 'bg-brand-dark border-brand-dark text-white' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}
              >
                {y}
              </button>
            ))}
          </div>
          <button onClick={load} disabled={loading} className="btn">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Atualizar
          </button>
        </div>
      </div>

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

        {/* Faixa de KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2 mb-3">
          {kpis.map(({ icon: Icon, label, amount, count, tone, filter: kpiFilter }) => {
            const borderLeft = tone === 'danger' ? 'border-l-status-error-solid' : tone === 'success' ? 'border-l-status-success-fg' : 'border-l-brand';
            const iconCls = tone === 'danger' ? 'bg-status-error-solid/10 text-status-error-fg' : tone === 'success' ? 'bg-status-success-bg text-status-success-fg' : 'bg-brand/10 text-brand';
            const valueCls = tone === 'danger' ? 'text-status-error-fg' : tone === 'success' ? 'text-status-success-fg' : tone === 'muted' ? 'text-slate-500' : 'text-slate-800';
            const active = filter === kpiFilter && kpiFilter !== 'total';
            return (
              <button
                key={label}
                type="button"
                onClick={() => toggleFilter(kpiFilter)}
                aria-pressed={active}
                title={kpiFilter === 'total' ? 'Limpar filtro' : `Filtrar por ${label}`}
                className={`flex items-center gap-2 rounded-lg p-2 border-l-2 bg-white shadow-xs hover:shadow-sm transition-shadow animate-fade-in-up text-left w-full cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-brand ${borderLeft} ${active ? 'ring-2 ring-brand shadow-sm' : ''}`}
              >
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${iconCls}`}>
                  <Icon size={14} />
                </div>
                <div className="min-w-0">
                  <div className={`font-mono text-xl font-semibold leading-tight truncate ${valueCls}`}>{fmtMoney(amount)}</div>
                  <div className={`text-base leading-tight ${valueCls}`}>
                    {count}<span className="text-xs font-normal text-slate-500 ml-1">conta(s)</span>
                  </div>
                  <div className="text-xs text-slate-500 truncate">{label}</div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Movimentações mês a mês (largura total) */}
        <div className="card p-3 mb-3">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-800">Movimentações mês a mês</h3>
              <p className="text-xs text-slate-500">Despesas a pagar vs. pagas por vencimento — {year}</p>
            </div>
            <span className="text-xs text-slate-500">valores em R$</span>
          </div>
          <MonthlyFlow flow={data?.monthlyFlow ?? []} />
        </div>

        {/* Donuts: Natureza (por grupo) e Tipo (Fixa/Variável) */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
          <div className="card p-3">
            <div className="mb-2">
              <h3 className="text-sm font-semibold text-slate-800">Natureza</h3>
              <p className="text-xs text-slate-500">Por grupo de despesa · {scope === 'all' ? 'Todas as contas' : MONTHS_FULL[month]}</p>
            </div>
            <BreakdownDonut
              segs={(data?.naturezaBreakdown ?? []).map((s) => ({ key: s.label, label: s.label, value: s.value }))}
              colorFor={paletteColor}
            />
          </div>

          <div className="card p-3">
            <div className="mb-2">
              <h3 className="text-sm font-semibold text-slate-800">Tipo</h3>
              <p className="text-xs text-slate-500">Por tipo (fixa/variável) · {scope === 'all' ? 'Todas as contas' : MONTHS_FULL[month]}</p>
            </div>
            <BreakdownDonut
              segs={(data?.tipoBreakdown ?? []).map((s) => ({ key: s.label, label: s.label, value: s.value }))}
              colorFor={paletteColor}
            />
          </div>
        </div>

        {/* Ranking de subgrupos + Prioritárias */}
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
