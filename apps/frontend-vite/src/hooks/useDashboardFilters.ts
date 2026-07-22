// src/hooks/useDashboardFilters.ts
// Estado dos filtros compartilhados pelos dois dashboards: mês, ano, escopo, filtro de
// KPI e empresa pagadora (+ as opções do <select>). As duas páginas mantinham SEIS
// useState idênticos, o mesmo `toggleFilter` e o mesmo par de handlers — duplicação de
// LÓGICA, não só de markup, que é o que sobrava depois de extrair DashboardHeader/KpiCard.
//
// O que NÃO entra aqui: o `load()` e o estado de dados/erro/loading. Cada dashboard chama
// um serviço diferente (getDashboardData × getFinancialDashboardData) e tem o seu próprio
// formato de resposta — juntar isso aqui exigiria genéricos e um parâmetro de serviço,
// acoplando o hook ao que cada página tem de específico.
import { useState } from 'react';
import type { SelectOption } from '../components/atoms/LabeledSelect';
import type { DashboardScope, KpiFilter } from '../services/supabase';
import { useCompanyOptions } from './useCompanyOptions';

export interface DashboardFilters {
  month: number;
  year: number;
  scope: DashboardScope;
  filter: KpiFilter;
  /** undefined = TODAS as empresas. */
  skCompany: number | undefined;
  companyOptions: SelectOption[];
  setMonth: (month: number) => void;
  setYear: (year: number) => void;
  setScope: (scope: DashboardScope) => void;
  setSkCompany: (skCompany: number | undefined) => void;
  /** Clicar no KPI já ativo limpa o filtro (volta a 'total'). */
  toggleFilter: (filter: KpiFilter) => void;
  clearFilter: () => void;
}

/**
 * @param initialFilter filtro de KPI na abertura. `/dashboard_vencimentos` abre sem
 * filtro ('total'); `/dashboard_despesas` abre em 'aVencer'.
 */
export function useDashboardFilters(initialFilter: KpiFilter = 'total'): DashboardFilters {
  // Inicializadores LAZY — `new Date()` no corpo do render é impuro (React Compiler).
  const [month, setMonth] = useState(() => new Date().getMonth());
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [scope, setScope] = useState<DashboardScope>('month');
  const [filter, setFilter] = useState<KpiFilter>(initialFilter);
  const [skCompany, setSkCompany] = useState<number | undefined>(undefined);
  const companyOptions = useCompanyOptions();

  return {
    month, year, scope, filter, skCompany, companyOptions,
    setMonth, setYear, setScope, setSkCompany,
    toggleFilter: (f) => setFilter((cur) => (cur === f ? 'total' : f)),
    clearFilter: () => setFilter('total'),
  };
}
