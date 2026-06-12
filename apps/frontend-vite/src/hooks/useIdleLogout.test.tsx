import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useIdleLogout, markIdleActivityNow, clearIdleActivity } from './useIdleLogout';

const STORAGE_KEY = 'pag:last-activity';
const TIMEOUT_MS = 10 * 60_000; // 10 minutos

// Harness mínimo — apenas aciona o hook; nenhum estado React envolvido.
function Harness(props: { enabled: boolean; timeoutMs: number; onTimeout: () => void }) {
  useIdleLogout(props);
  return null;
}

describe('useIdleLogout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispara onTimeout após o período de inatividade', () => {
    const onTimeout = vi.fn();
    render(<Harness enabled timeoutMs={TIMEOUT_MS} onTimeout={onTimeout} />);

    act(() => {
      vi.advanceTimersByTime(TIMEOUT_MS + 30_000);
    });

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('atividade do usuário reseta o relógio e evita o logout', () => {
    const onTimeout = vi.fn();
    render(<Harness enabled timeoutMs={TIMEOUT_MS} onTimeout={onTimeout} />);

    act(() => {
      vi.advanceTimersByTime(TIMEOUT_MS - 60_000);
      globalThis.dispatchEvent(new MouseEvent('mousedown')); // atividade reseta o relógio
      vi.advanceTimersByTime(TIMEOUT_MS - 60_000);
    });

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('reabertura após inatividade herdada → logout imediato na montagem', () => {
    // Simula atividade antiga persistida (15 min atrás) antes de montar.
    localStorage.setItem(STORAGE_KEY, String(Date.now() - 15 * 60_000));
    const onTimeout = vi.fn();

    render(<Harness enabled timeoutMs={TIMEOUT_MS} onTimeout={onTimeout} />);

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('desabilitado não monitora inatividade', () => {
    const onTimeout = vi.fn();
    render(<Harness enabled={false} timeoutMs={TIMEOUT_MS} onTimeout={onTimeout} />);

    act(() => {
      vi.advanceTimersByTime(TIMEOUT_MS * 2);
    });

    expect(onTimeout).not.toHaveBeenCalled();
  });
});

describe('marcadores de atividade (helpers)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('markIdleActivityNow grava o timestamp e clearIdleActivity remove', () => {
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    markIdleActivityNow();
    expect(Number(localStorage.getItem(STORAGE_KEY))).toBeGreaterThan(0);

    clearIdleActivity();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
