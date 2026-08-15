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
  /** Trocar de mês LIMPA o filtro de KPI — ver `limparFiltroAoNavegar` abaixo. */
  setMonth: (month: number) => void;
  /** Trocar de ano LIMPA o filtro de KPI — mesma razão do mês. */
  setYear: (year: number) => void;
  setScope: (scope: DashboardScope) => void;
  setSkCompany: (skCompany: number | undefined) => void;
  /** Clicar no KPI já ativo limpa o filtro (volta a 'total'). */
  toggleFilter: (filter: KpiFilter) => void;
  clearFilter: () => void;
}

/**
 * @param initialFilter filtro de KPI na abertura. As DUAS telas abrem em 'vencendo7'
 * ("A vencer em 7 dias") — decisão do usuário 2026-08-15. Antes eram 'total' no de
 * vencimentos e 'aVencer' no financeiro.
 */
export function useDashboardFilters(initialFilter: KpiFilter = 'total'): DashboardFilters {
  // Inicializadores LAZY — `new Date()` no corpo do render é impuro (React Compiler).
  const [month, setMonth] = useState(() => new Date().getMonth());
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [scope, setScope] = useState<DashboardScope>('month');
  const [filter, setFilter] = useState<KpiFilter>(initialFilter);
  const [skCompany, setSkCompany] = useState<number | undefined>(undefined);
  const companyOptions = useCompanyOptions();

  // Navegar para outro mês/ano LIMPA o filtro de KPI. Motivo: 'vencendo7' — o default das
  // duas telas — é uma janela MÓVEL a partir de hoje, então ele só intersecta o mês
  // corrente; mantendo-o grudado, trocar de mês devolveria "Sem contas no período." em
  // todos os gráficos, culpando o PERÍODO por um recorte que é do FILTRO. Volta a 'total'
  // (não a `initialFilter`), senão o mês novo nasceria vazio de novo.
  //
  // `scope` NÃO entra: escopo "todas as contas" + 'vencendo7' é uma combinação válida
  // (contas a vencer nos próximos 7 dias em toda a base), não um beco sem saída.
  //
  // A guarda `proximo !== atual` não é cosmética: sem ela, clicar no mês JÁ selecionado
  // descartaria o filtro que o usuário acabou de aplicar — o botão do mês corrente é
  // clicável e continua na tela depois de um clique em card de KPI.
  const limparFiltroAoNavegar = <T>(
    proximo: T, atual: T, aplicar: (v: T) => void,
  ): void => {
    aplicar(proximo);
    if (proximo !== atual) setFilter('total');
  };

  return {
    month, year, scope, filter, skCompany, companyOptions,
    setMonth: (m) => limparFiltroAoNavegar(m, month, setMonth),
    setYear: (y) => limparFiltroAoNavegar(y, year, setYear),
    setScope, setSkCompany,
    toggleFilter: (f) => setFilter((cur) => (cur === f ? 'total' : f)),
    clearFilter: () => setFilter('total'),
  };
}
