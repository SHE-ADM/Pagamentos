import { useEffect, useState } from 'react';

export type Breakpoint = 'sm' | 'md' | 'lg';

// Esquema de breakpoints do grid: sm < 640px · md 640–1024px · lg >= 1024px.
// Usa if/return (sem ternário aninhado) para classificar a faixa atual.
function currentBreakpoint(): Breakpoint {
  if (typeof window === 'undefined') return 'lg';
  if (window.matchMedia('(min-width: 1024px)').matches) return 'lg';
  if (window.matchMedia('(min-width: 640px)').matches) return 'md';
  return 'sm';
}

/**
 * Detecta o breakpoint atual ('sm' | 'md' | 'lg') e atualiza ao redimensionar a
 * janela. Usa `window.matchMedia` — reage à mudança de faixa, não a cada pixel.
 */
export function useBreakpoint(): Breakpoint {
  const [breakpoint, setBreakpoint] = useState<Breakpoint>(currentBreakpoint);

  useEffect(() => {
    const queries = [
      window.matchMedia('(min-width: 1024px)'),
      window.matchMedia('(min-width: 640px)'),
    ];
    const update = (): void => setBreakpoint(currentBreakpoint());
    update(); // sincroniza caso o tamanho tenha mudado antes do efeito montar
    queries.forEach((q) => q.addEventListener('change', update));
    return () => queries.forEach((q) => q.removeEventListener('change', update));
  }, []);

  return breakpoint;
}
