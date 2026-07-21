// src/components/dashboard/DashboardHeader.tsx
// Cabeçalho dos dashboards: título + indicador do filtro de KPI ativo, e a barra de
// controles (empresa · escopo · mês · ano · Atualizar). Compartilhado por
// /dashboard_vencimentos e /dashboard_financeiro — o bloco era duplicado LITERALMENTE nas
// duas páginas (84 linhas com apenas três diferenças: título, o assunto do subtítulo e o
// id/name do <select>), então corrigir um detalhe ali exigia lembrar de fazê-lo duas vezes.
//
// Apresentacional puro: NÃO tem estado nem busca dados. Quem guarda mês/ano/escopo/filtro/
// empresa e dispara o reload continua sendo a página — o header só renderiza e avisa.
import { RefreshCw } from 'lucide-react';
import type { SelectOption } from '../atoms/LabeledSelect';
import type { DashboardScope, KpiFilter } from '../../services/supabase';
import { MONTHS, MONTHS_FULL } from './constants';

// Rótulo pt-BR do filtro ativo (fonte única — as páginas não redeclaram).
const KPI_FILTER_LABEL: Record<KpiFilter, string> = {
  total: 'Todos', pago: 'Pagos', aVencer: 'A vencer', vencendo7: 'A vencer em 7 dias', vencidas: 'Vencidas',
};

type Props = Readonly<{
  /** Título da página (h1). */
  title: string;
  /** Assunto do subtítulo — "Contas a pagar" (vencimentos) · "Despesas" (financeiro). */
  subject: string;
  /**
   * Prefixo do id/name do <select> de empresa. Duas páginas nunca coexistem no DOM, mas
   * ids distintos mantêm o autofill do Chrome e o histórico de formulário separados.
   */
  idPrefix: string;
  month: number;
  year: number;
  scope: DashboardScope;
  filter: KpiFilter;
  /** undefined = TODAS as empresas. */
  skCompany: number | undefined;
  companyOptions: SelectOption[];
  loading: boolean;
  onMonthChange: (month: number) => void;
  onYearChange: (year: number) => void;
  onScopeChange: (scope: DashboardScope) => void;
  /** Limpa o filtro de KPI (volta a 'total') — o ✕ ao lado de "filtrando: …". */
  onClearFilter: () => void;
  onCompanyChange: (skCompany: number | undefined) => void;
  onRefresh: () => void;
}>;

export function DashboardHeader({
  title, subject, idPrefix, month, year, scope, filter, skCompany, companyOptions, loading,
  onMonthChange, onYearChange, onScopeChange, onClearFilter, onCompanyChange, onRefresh,
}: Props) {
  const selectId = `${idPrefix}-company`;
  return (
    <div className="px-6 py-2 border-b border-slate-200 bg-white flex items-center justify-between gap-4 flex-wrap">
      <div>
        <h1 className="text-sm font-semibold text-slate-800">{title}</h1>
        <p className="text-xs text-slate-500 mt-0.5">
          {subject} · {scope === 'all' ? 'Todas as contas' : `${MONTHS_FULL[month]} ${year}`}
          {filter !== 'total' && (
            <>
              {' · '}
              <button type="button" onClick={onClearFilter} className="font-medium text-brand-dark hover:underline">
                filtrando: {KPI_FILTER_LABEL[filter]} ✕
              </button>
            </>
          )}
        </p>
      </div>
      <div className="flex items-center gap-3 flex-wrap justify-end">
        {/* Empresa pagadora — primeiro dos controles: escopa TUDO (KPIs, donuts, rankings
            e o gráfico anual onde houver). Vazio = TODAS. Aplica NA HORA: o dashboard não
            tem botão "Buscar", diferente de /consulta. */}
        <select
          id={selectId}
          name={selectId}
          aria-label="Filtrar por empresa"
          className="input w-36 text-xs"
          value={skCompany == null ? '' : String(skCompany)}
          onChange={(e) => onCompanyChange(e.target.value ? Number(e.target.value) : undefined)}
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
            onClick={() => onScopeChange('month')}
            aria-pressed={scope === 'month'}
            className={`text-xs font-medium px-2.5 py-1 rounded-sm transition-colors ${scope === 'month' ? 'bg-white text-slate-800 shadow-xs' : 'text-slate-500 hover:text-slate-700'}`}
          >
            Este mês
          </button>
          <button
            onClick={() => onScopeChange('all')}
            aria-pressed={scope === 'all'}
            className={`text-xs font-medium px-2.5 py-1 rounded-sm transition-colors ${scope === 'all' ? 'bg-white text-slate-800 shadow-xs' : 'text-slate-500 hover:text-slate-700'}`}
          >
            Todas as contas
          </button>
        </div>
        {/* Meses: irrelevantes no escopo 'all' — esmaecidos e inertes, em vez de sumirem
            (evita o layout "pular" ao trocar de escopo).
            `disabled` além do aria-hidden/pointer-events NÃO é redundância: sem ele os
            botões seguiriam na ordem de TAB dentro de um contêiner aria-hidden — o teclado
            alcançava um controle que o leitor de tela não anuncia (axe aria-hidden-focus,
            WCAG 4.1.2). `disabled` os tira do foco e casa os dois mundos. */}
        <div className={`flex gap-0.5 flex-wrap transition-opacity ${scope === 'all' ? 'opacity-40 pointer-events-none' : ''}`} aria-hidden={scope === 'all'}>
          {MONTHS.map((m, i) => (
            <button
              key={m}
              onClick={() => onMonthChange(i)}
              disabled={scope === 'all'}
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
              onClick={() => onYearChange(y)}
              aria-pressed={y === year}
              className={`text-xs font-medium px-2.5 py-1 rounded-md border transition-colors ${y === year ? 'bg-brand-dark border-brand-dark text-white' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}
            >
              {y}
            </button>
          ))}
        </div>
        <button onClick={onRefresh} disabled={loading} className="btn">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Atualizar
        </button>
      </div>
    </div>
  );
}
