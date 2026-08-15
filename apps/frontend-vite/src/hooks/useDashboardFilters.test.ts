// src/hooks/useDashboardFilters.test.ts
// Estado compartilhado pelos dois dashboards. O caso que mais importa é o toggle: clicar
// no KPI já ativo LIMPA o filtro (volta a 'total') — regra que estava duplicada nas duas
// páginas antes do hook.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Lookup de empresas — evita rede no teste (o hook consome useCompanyOptions).
const listCompaniesMock = vi.fn();
vi.mock('../services/lookups', () => ({ listCompanies: () => listCompaniesMock() }));

import { useDashboardFilters } from './useDashboardFilters';

describe('useDashboardFilters', () => {
  beforeEach(() => {
    listCompaniesMock.mockReset();
    listCompaniesMock.mockResolvedValue([{ sk_company: 1, trade_name: 'OTIMOTEX TECIDOS' }]);
  });

  it('abre no mês/ano correntes, escopo "month" e sem empresa', () => {
    const { result } = renderHook(() => useDashboardFilters());
    const now = new Date();
    expect(result.current.month).toBe(now.getMonth());
    expect(result.current.year).toBe(now.getFullYear());
    expect(result.current.scope).toBe('month');
    expect(result.current.skCompany).toBeUndefined();
  });

  it('o filtro inicial é parametrizável (as duas telas abrem em "A vencer em 7 dias")', () => {
    expect(renderHook(() => useDashboardFilters()).result.current.filter).toBe('total');
    expect(renderHook(() => useDashboardFilters('vencendo7')).result.current.filter).toBe('vencendo7');
  });

  it('toggleFilter aplica o filtro e, no MESMO KPI, limpa para "total"', () => {
    const { result } = renderHook(() => useDashboardFilters());
    act(() => result.current.toggleFilter('pago'));
    expect(result.current.filter).toBe('pago');
    act(() => result.current.toggleFilter('pago'));
    expect(result.current.filter).toBe('total');
  });

  it('toggleFilter troca direto entre KPIs distintos', () => {
    const { result } = renderHook(() => useDashboardFilters());
    act(() => result.current.toggleFilter('pago'));
    act(() => result.current.toggleFilter('vencidas'));
    expect(result.current.filter).toBe('vencidas');
  });

  it('clearFilter volta a "total" a partir de qualquer filtro', () => {
    const { result } = renderHook(() => useDashboardFilters('vencendo7'));
    act(() => result.current.clearFilter());
    expect(result.current.filter).toBe('total');
  });

  // 'vencendo7' — o default das duas telas — é uma janela MÓVEL a partir de hoje, então só
  // intersecta o mês corrente. Mantendo-o grudado, navegar para outro mês devolveria "Sem
  // contas no período." em todos os gráficos, culpando o PERÍODO por um recorte que é do
  // FILTRO. Por isso navegar LIMPA o filtro.
  it('trocar de MÊS limpa o filtro de KPI', () => {
    const { result } = renderHook(() => useDashboardFilters('vencendo7'));
    const outroMes = (new Date().getMonth() + 1) % 12;
    act(() => result.current.setMonth(outroMes));
    expect(result.current.month).toBe(outroMes);
    expect(result.current.filter).toBe('total');
  });

  it('trocar de ANO limpa o filtro de KPI', () => {
    const { result } = renderHook(() => useDashboardFilters('vencendo7'));
    act(() => result.current.setYear(2025));
    expect(result.current.year).toBe(2025);
    expect(result.current.filter).toBe('total');
  });

  // A outra metade da regra, e a que uma implementação ingênua quebra: o botão do mês
  // CORRENTE continua clicável depois de o usuário aplicar um filtro num card de KPI —
  // clicar nele não pode descartar o filtro que ele acabou de escolher.
  it('reselecionar o MESMO mês NÃO limpa o filtro', () => {
    const { result } = renderHook(() => useDashboardFilters());
    act(() => result.current.toggleFilter('pago'));
    act(() => result.current.setMonth(result.current.month));
    expect(result.current.filter).toBe('pago');
  });

  it('reselecionar o MESMO ano NÃO limpa o filtro', () => {
    const { result } = renderHook(() => useDashboardFilters());
    act(() => result.current.toggleFilter('vencidas'));
    act(() => result.current.setYear(result.current.year));
    expect(result.current.filter).toBe('vencidas');
  });

  // `scope` fica DE FORA da regra: escopo "todas as contas" + 'vencendo7' é uma combinação
  // válida (contas a vencer nos próximos 7 dias em toda a base), não um beco sem saída.
  it('trocar o ESCOPO preserva o filtro de KPI', () => {
    const { result } = renderHook(() => useDashboardFilters('vencendo7'));
    act(() => result.current.setScope('all'));
    expect(result.current.scope).toBe('all');
    expect(result.current.filter).toBe('vencendo7');
  });

  it('setters de mês/ano/escopo/empresa atualizam o estado', () => {
    const { result } = renderHook(() => useDashboardFilters());
    act(() => result.current.setMonth(0));
    act(() => result.current.setYear(2025));
    act(() => result.current.setScope('all'));
    act(() => result.current.setSkCompany(2));
    expect(result.current.month).toBe(0);
    expect(result.current.year).toBe(2025);
    expect(result.current.scope).toBe('all');
    expect(result.current.skCompany).toBe(2);
    // undefined = TODAS (o <select> vazio) — não pode virar NaN nem 0.
    act(() => result.current.setSkCompany(undefined));
    expect(result.current.skCompany).toBeUndefined();
  });

  it('expõe as opções de empresa carregadas pelo lookup', async () => {
    const { result } = renderHook(() => useDashboardFilters());
    await vi.waitFor(() => expect(result.current.companyOptions).toHaveLength(1));
    expect(result.current.companyOptions[0]).toEqual({ value: 1, label: 'OTIMOTEX TECIDOS' });
  });
});
