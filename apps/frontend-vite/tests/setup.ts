// Registra os matchers do jest-dom no expect do Vitest e aplica a augmentação
// de tipos (toBeInTheDocument, toHaveTextContent, etc.).
import '@testing-library/jest-dom/vitest';

// Matcher de acessibilidade (jest-axe) — habilita expect(...).toHaveNoViolations().
import { expect } from 'vitest';
import { toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

// jsdom não implementa matchMedia — shim genérico (matches=true) para libs que o
// consultem. Os breakpoints do DataGrid não usam mais matchMedia.
Object.defineProperty(globalThis, 'matchMedia', {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

// jsdom não implementa ResizeObserver — usado por `useContainerBreakpoint`
// (DataGrid mede a largura real do container). Stub controlável: a largura é lida
// de globalThis.__roWidth no observe (padrão 1280 = breakpoint 'lg') e a altura
// de globalThis.__roHeight (padrão undefined → DataGrid cai em clientHeight 0, ou
// seja, virtualização desligada nos testes que não a definem).
class ResizeObserverStub {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(target: Element): void {
    const width = (globalThis as { __roWidth?: number }).__roWidth ?? 1280;
    const height = (globalThis as { __roHeight?: number }).__roHeight;
    // `target` entra na entry — o @tanstack/react-virtual resolve a linha observada
    // por entry.target (indexFromElement) ao medir alturas dinâmicas.
    const entry = { target, contentRect: { width, height } } as ResizeObserverEntry;
    this.cb([entry], this);
  }
  unobserve(): void {
    /* no-op */
  }
  disconnect(): void {
    /* no-op */
  }
}
globalThis.ResizeObserver = ResizeObserverStub;
