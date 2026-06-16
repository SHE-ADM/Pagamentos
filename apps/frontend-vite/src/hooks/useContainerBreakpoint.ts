import { useEffect, useRef, useState } from 'react';

type Breakpoint = 'sm' | 'md' | 'lg';

// Mesmos limiares do Tailwind, mas medidos na largura REAL do container (não da
// janela) — assim a sidebar, paddings e o próprio resize do painel são levados em
// conta. Usa if/return (sem ternário aninhado, S3358).
function classify(width: number): Breakpoint {
  if (width >= 1024) return 'lg';
  if (width >= 640) return 'md';
  return 'sm';
}

/**
 * Observa a largura de um elemento (ResizeObserver) e devolve o breakpoint
 * correspondente. `ref` deve ser ligado ao container cuja largura disponível
 * decide quantas colunas cabem (no DataGrid, o wrapper rolável da tabela).
 * Inicia em 'lg' e ajusta no primeiro observe — sem flash perceptível.
 */
export function useContainerBreakpoint<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [breakpoint, setBreakpoint] = useState<Breakpoint>('lg');

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth;
      setBreakpoint(classify(width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, breakpoint };
}
