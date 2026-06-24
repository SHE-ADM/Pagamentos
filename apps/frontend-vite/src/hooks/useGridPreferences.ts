import { useCallback, useEffect, useRef, useState } from 'react';
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

/** Defaults por grid (fixação/densidade iniciais) — semeados na 1ª carga e no `reset()`. */
export interface GridDefaults {
  pinning?: ColumnPinningState;
  density?: GridDensity;
}

const defaultPrefs = (order: string[], defaults?: GridDefaults): GridPreferences => ({
  order,
  visibility: {},
  sizing: {},
  pinning: { left: defaults?.pinning?.left ?? [], right: defaults?.pinning?.right ?? [] },
  density: defaults?.density ?? 'comfortable',
});

// Mantém a ordem salva das colunas ainda existentes e insere as NOVAS na POSIÇÃO da
// definição (logo após o vizinho anterior já presente; senão, antes do próximo presente;
// senão, no fim). Assim adicionar uma coluna no código não a joga para o fim do layout
// salvo do usuário — ela aparece onde foi definida (ex.: "E-mail (Cc)" logo após "E-mail").
const reconcileOrder = (saved: string[], ids: string[]): string[] => {
  const idsSet = new Set(ids);
  const result = saved.filter((id) => idsSet.has(id));
  ids.forEach((id, defIdx) => {
    if (result.includes(id)) return;
    let at = -1;
    for (let i = defIdx - 1; i >= 0 && at === -1; i--) {
      const p = result.indexOf(ids[i]);
      if (p !== -1) at = p + 1;
    }
    for (let j = defIdx + 1; j < ids.length && at === -1; j++) {
      const q = result.indexOf(ids[j]);
      if (q !== -1) at = q;
    }
    result.splice(at === -1 ? result.length : at, 0, id);
  });
  return result;
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
export function useGridPreferences(gridId: string | undefined, columnIds: string[], defaults?: GridDefaults) {
  // Ref dos defaults — evita que um objeto inline (novo a cada render) entre nas deps do
  // `reset`; lê sempre o valor mais recente sem recriar o callback. Sincronizado em
  // effect (não em render) para não violar a regra de refs do React Compiler.
  const defaultsRef = useRef(defaults);
  useEffect(() => {
    defaultsRef.current = defaults;
  }, [defaults]);

  const [prefs, setPrefs] = useState<GridPreferences>(() => {
    const base = defaultPrefs(columnIds, defaults);
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

  // Reconcilia a ordem persistida com as colunas atuais quando o conjunto muda (coluna
  // adicionada/removida). É sincronização de estado PERSISTIDO dirigida por prop externa,
  // com guarda (retorna `prev` quando igual) — setState-in-effect é o padrão correto aqui.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
  const reset = useCallback(() => setPrefs(defaultPrefs(columnIds, defaultsRef.current)), [columnIds]);

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
