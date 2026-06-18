import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGridPreferences } from './useGridPreferences';

beforeEach(() => localStorage.clear());

describe('useGridPreferences', () => {
  it('inicia com a ordem padrão = ids das colunas e densidade confortável', () => {
    const { result } = renderHook(() => useGridPreferences('g1', ['a', 'b', 'c']));
    expect(result.current.prefs.order).toEqual(['a', 'b', 'c']);
    expect(result.current.prefs.density).toBe('comfortable');
  });

  it('persiste e recarrega do localStorage', () => {
    const { result, unmount } = renderHook(() => useGridPreferences('g1', ['a', 'b']));
    act(() => result.current.setDensity('compact'));
    act(() => result.current.setColumnVisibility((v) => ({ ...v, b: false })));
    unmount();

    const { result: r2 } = renderHook(() => useGridPreferences('g1', ['a', 'b']));
    expect(r2.current.prefs.density).toBe('compact');
    expect(r2.current.prefs.visibility).toEqual({ b: false });
  });

  it('reset volta ao padrão', () => {
    const { result } = renderHook(() => useGridPreferences('g1', ['a', 'b']));
    act(() => result.current.setDensity('compact'));
    act(() => result.current.reset());
    expect(result.current.prefs.density).toBe('comfortable');
  });

  it('reconcilia a ordem salva (mantém conhecidas, anexa novas, descarta removidas)', () => {
    localStorage.setItem(
      'pag:grid:g1:v1',
      JSON.stringify({
        order: ['c', 'a', 'x'],
        visibility: {},
        sizing: {},
        pinning: { left: [], right: [] },
        density: 'comfortable',
      }),
    );
    const { result } = renderHook(() => useGridPreferences('g1', ['a', 'b', 'c']));
    // 'c','a' conhecidas (nessa ordem) → 'b' nova anexada; 'x' (removida) descartada.
    expect(result.current.prefs.order).toEqual(['c', 'a', 'b']);
  });

  it('sem gridId não persiste (apenas memória)', () => {
    const { result } = renderHook(() => useGridPreferences(undefined, ['a']));
    act(() => result.current.setDensity('compact'));
    expect(localStorage.length).toBe(0);
    expect(result.current.prefs.density).toBe('compact');
  });
});
