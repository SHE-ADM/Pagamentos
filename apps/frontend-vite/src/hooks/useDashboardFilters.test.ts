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

  it('o filtro inicial é parametrizável (o financeiro abre em "A vencer")', () => {
    expect(renderHook(() => useDashboardFilters()).result.current.filter).toBe('total');
    expect(renderHook(() => useDashboardFilters('aVencer')).result.current.filter).toBe('aVencer');
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
    const { result } = renderHook(() => useDashboardFilters('aVencer'));
    act(() => result.current.clearFilter());
    expect(result.current.filter).toBe('total');
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
