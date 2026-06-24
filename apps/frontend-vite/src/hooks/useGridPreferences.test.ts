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

  it('reconcilia a ordem salva (mantém conhecidas, insere novas na posição, descarta removidas)', () => {
    localStorage.setItem(
      'pag:grid:g1:v3',
      JSON.stringify({
        order: ['c', 'a', 'x'],
        visibility: {},
        sizing: {},
        pinning: { left: [], right: [] },
        density: 'comfortable',
      }),
    );
    const { result } = renderHook(() => useGridPreferences('g1', ['a', 'b', 'c']));
    // 'c','a' conhecidas (nessa ordem); 'b' (def. após 'a') entra após 'a'; 'x' descartada.
    expect(result.current.prefs.order).toEqual(['c', 'a', 'b']);
  });

  it('insere coluna nova na POSIÇÃO da definição, não no fim do layout salvo', () => {
    localStorage.setItem(
      'pag:grid:g1:v3',
      JSON.stringify({
        order: ['a', 'b', 'c'],
        visibility: {},
        sizing: {},
        pinning: { left: [], right: [] },
        density: 'comfortable',
      }),
    );
    // 'novo' definido entre 'a' e 'b' deve entrar entre eles (não ser anexado ao fim).
    const { result } = renderHook(() => useGridPreferences('g1', ['a', 'novo', 'b', 'c']));
    expect(result.current.prefs.order).toEqual(['a', 'novo', 'b', 'c']);
  });

  it('sem gridId não persiste (apenas memória)', () => {
    const { result } = renderHook(() => useGridPreferences(undefined, ['a']));
    act(() => result.current.setDensity('compact'));
    expect(localStorage.length).toBe(0);
    expect(result.current.prefs.density).toBe('compact');
  });

  it('semeia defaultPinning/defaultDensity quando não há prefs salvas', () => {
    const { result } = renderHook(() =>
      useGridPreferences('g2', ['a', 'b', 'c'], { pinning: { left: ['a', 'b'], right: [] }, density: 'compact' }),
    );
    expect(result.current.prefs.pinning).toEqual({ left: ['a', 'b'], right: [] });
    expect(result.current.prefs.density).toBe('compact');
  });

  it('reset restaura os defaults (não vazio) quando informados', () => {
    const defaults = { pinning: { left: ['a'], right: [] }, density: 'compact' as const };
    const { result } = renderHook(() => useGridPreferences('g3', ['a', 'b'], defaults));
    act(() => result.current.setColumnPinning({ left: [], right: ['b'] }));
    act(() => result.current.setDensity('comfortable'));
    act(() => result.current.reset());
    expect(result.current.prefs.pinning).toEqual({ left: ['a'], right: [] });
    expect(result.current.prefs.density).toBe('compact');
  });

  it('prefs salvas prevalecem sobre os defaults', () => {
    localStorage.setItem(
      'pag:grid:g4:v3',
      JSON.stringify({
        order: ['a', 'b'],
        visibility: {},
        sizing: {},
        pinning: { left: ['b'], right: [] },
        density: 'comfortable',
      }),
    );
    const { result } = renderHook(() =>
      useGridPreferences('g4', ['a', 'b'], { pinning: { left: ['a'], right: [] }, density: 'compact' }),
    );
    expect(result.current.prefs.pinning).toEqual({ left: ['b'], right: [] });
    expect(result.current.prefs.density).toBe('comfortable');
  });
});
