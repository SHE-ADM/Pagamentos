import { useEffect } from 'react';

// Eventos que contam como atividade do usuário (resetam o relógio de inatividade).
const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'scroll', 'touchstart', 'mousemove'] as const;

const STORAGE_KEY = 'pag:last-activity';
const CHECK_INTERVAL_MS = 30_000; // frequência da verificação de inatividade
const WRITE_THROTTLE_MS = 10_000; // grava o timestamp no máximo a cada 10s

interface UseIdleLogoutOptions {
  enabled: boolean;
  timeoutMs: number;
  onTimeout: () => void;
}

/**
 * Desloga o usuário após `timeoutMs` sem atividade. O timestamp da última
 * atividade vive no localStorage — compartilhado entre abas e preservado em
 * refresh. Ao montar, verifica o valor herdado: se o app foi reaberto após o
 * período de inatividade, dispara o logout imediatamente.
 */
export function useIdleLogout({ enabled, timeoutMs, onTimeout }: UseIdleLogoutOptions): void {
  useEffect(() => {
    if (!enabled) return;

    const readLastActivity = (): number => Number(localStorage.getItem(STORAGE_KEY)) || Date.now();
    const writeLastActivity = (t: number): void => {
      localStorage.setItem(STORAGE_KEY, String(t));
    };

    let fired = false;
    const checkIdle = (): void => {
      if (fired) return;
      if (Date.now() - readLastActivity() >= timeoutMs) {
        fired = true;
        localStorage.removeItem(STORAGE_KEY);
        onTimeout();
      }
    };

    // 1. Verifica a inatividade herdada (reabertura após período ocioso) ANTES
    //    de registrar a sessão atual como ativa.
    checkIdle();
    if (fired) return;

    // 2. Marca atividade agora e passa a monitorar.
    writeLastActivity(Date.now());
    let lastWrite = Date.now();

    const markActivity = (): void => {
      const t = Date.now();
      if (t - lastWrite >= WRITE_THROTTLE_MS) {
        lastWrite = t;
        writeLastActivity(t);
      }
    };

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') checkIdle();
    };

    ACTIVITY_EVENTS.forEach((evt) => {
      window.addEventListener(evt, markActivity, { passive: true });
    });
    document.addEventListener('visibilitychange', onVisible);
    const interval = window.setInterval(checkIdle, CHECK_INTERVAL_MS);

    return () => {
      ACTIVITY_EVENTS.forEach((evt) => {
        window.removeEventListener(evt, markActivity);
      });
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(interval);
    };
  }, [enabled, timeoutMs, onTimeout]);
}
