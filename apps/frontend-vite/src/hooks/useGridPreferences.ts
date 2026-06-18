import { useCallback, useEffect, useState } from 'react';
import type {
  ColumnOrderState,
  ColumnPinningState,
  ColumnSizingState,
  OnChangeFn,
  VisibilityState,
} from '@tanstack/react-table';

/** Densidade visual do grid — controla o padding vertical das células. */
export type GridDensity = 'comfortable' | 'compact';

/** Preferências de layout do grid persistidas por usuário (uma chave por grid). */
interface GridPreferences {
  order: ColumnOrderState;
  visibility: VisibilityState;
  sizing: ColumnSizingState;
  pinning: ColumnPinningState;
  density: GridDensity;
}

const STORAGE_VERSION = 'v3';
const storageKey = (gridId: string): string => `pag:grid:${gridId}:${STORAGE_VERSION}`;

// Remove chaves de versões anteriores para não deixar dados obsoletos acumularem.
const purgeOldVersions = (gridId: string) => {
  ['v1', 'v2'].forEach((v) => {
    try { localStorage.removeItem(`pag:grid:${gridId}:${v}`); } catch { /* noop */ }
  });
};

const defaultPrefs = (order: string[]): GridPreferences => ({
  order,
  visibility: {},
  sizing: {},
  pinning: { left: [], right: [] },
  density: 'comfortable',
});

// Mantém a ordem salva para colunas ainda existentes e acrescenta as novas no fim —
// assim adicionar/remover uma coluna no código não corrompe o layout salvo do usuário.
const reconcileOrder = (saved: string[], ids: string[]): string[] => {
  const known = saved.filter((id) => ids.includes(id));
  const missing = ids.filter((id) => !known.includes(id));
  return [...known, ...missing];
};

const applyUpdater = <T,>(updater: T | ((old: T) => T), old: T): T =>
  typeof updater === 'function' ? (updater as (o: T) => T)(old) : updater;

const sameOrder = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Estado de layout do grid (ordem, visibilidade, larguras, fixação e densidade) com
 * persistência em `localStorage` quando `gridId` é informado. Os setters seguem a
 * assinatura `OnChangeFn` do TanStack (aceitam valor ou updater) para ligarem direto
 * em `onColumnOrderChange`/`onColumnVisibilityChange`/etc. `columnIds` deve ser estável
 * (memoizado pelo chamador) — é a base da ordem padrão e da reconciliação.
 */
export function useGridPreferences(gridId: string | undefined, columnIds: string[]) {
  const [prefs, setPrefs] = useState<GridPreferences>(() => {
    const base = defaultPrefs(columnIds);
    if (!gridId || typeof localStorage === 'undefined') return base;
    purgeOldVersions(gridId);
    try {
      const raw = localStorage.getItem(storageKey(gridId));
      if (!raw) return base;
      const parsed = JSON.parse(raw) as Partial<GridPreferences>;
      return {
        order: reconcileOrder(parsed.order ?? [], columnIds),
        visibility: parsed.visibility ?? {},
        sizing: parsed.sizing ?? {},
        pinning: { left: parsed.pinning?.left ?? [], right: parsed.pinning?.right ?? [] },
        density: parsed.density === 'compact' ? 'compact' : 'comfortable',
      };
    } catch {
      return base;
    }
  });

  // Persiste a cada mudança (ignora erro de quota/modo privado).
  useEffect(() => {
    if (!gridId || typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(storageKey(gridId), JSON.stringify(prefs));
    } catch {
      /* armazenamento indisponível — segue só em memória */
    }
  }, [gridId, prefs]);

  // Reconcilia a ordem quando o conjunto de colunas muda (coluna adicionada/removida).
  useEffect(() => {
    setPrefs((prev) => {
      const order = reconcileOrder(prev.order, columnIds);
      return sameOrder(order, prev.order) ? prev : { ...prev, order };
    });
  }, [columnIds]);

  const setColumnOrder = useCallback<OnChangeFn<ColumnOrderState>>(
    (u) => setPrefs((p) => ({ ...p, order: applyUpdater(u, p.order) })),
    [],
  );
  const setColumnVisibility = useCallback<OnChangeFn<VisibilityState>>(
    (u) => setPrefs((p) => ({ ...p, visibility: applyUpdater(u, p.visibility) })),
    [],
  );
  const setColumnSizing = useCallback<OnChangeFn<ColumnSizingState>>(
    (u) => setPrefs((p) => ({ ...p, sizing: applyUpdater(u, p.sizing) })),
    [],
  );
  const setColumnPinning = useCallback<OnChangeFn<ColumnPinningState>>(
    (u) => setPrefs((p) => ({ ...p, pinning: applyUpdater(u, p.pinning) })),
    [],
  );
  const setDensity = useCallback(
    (density: GridDensity) => setPrefs((p) => ({ ...p, density })),
    [],
  );
  const reset = useCallback(() => setPrefs(defaultPrefs(columnIds)), [columnIds]);

  return {
    prefs,
    setColumnOrder,
    setColumnVisibility,
    setColumnSizing,
    setColumnPinning,
    setDensity,
    reset,
  };
}
