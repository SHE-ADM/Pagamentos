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

// Lê o timestamp da última atividade. Ausente/ inválido → trata como "agora"
// (sem inatividade herdada).
function readLastActivity(): number {
  return Number(localStorage.getItem(STORAGE_KEY)) || Date.now();
}

// True quando o período ocioso herdado já excedeu o limite — usado pelo
// AuthContext para ir direto ao login na reabertura, sem restaurar a sessão.
export function isIdleExpired(timeoutMs: number): boolean {
  return Date.now() - readLastActivity() >= timeoutMs;
}

// Marca atividade agora — chamado no login (SIGNED_IN) para iniciar uma janela
// de inatividade limpa, evitando que um marcador antigo derrube o usuário logo
// após entrar.
export function markIdleActivityNow(): void {
  localStorage.setItem(STORAGE_KEY, String(Date.now()));
}

// Remove o marcador — chamado no logout (SIGNED_OUT).
export function clearIdleActivity(): void {
  localStorage.removeItem(STORAGE_KEY);
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

    const writeLastActivity = (t: number): void => {
      localStorage.setItem(STORAGE_KEY, String(t));
    };

    let fired = false;
    const checkIdle = (): void => {
      if (fired) return;
      if (isIdleExpired(timeoutMs)) {
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
      globalThis.addEventListener(evt, markActivity, { passive: true });
    });
    document.addEventListener('visibilitychange', onVisible);
    const interval = globalThis.setInterval(checkIdle, CHECK_INTERVAL_MS);

    return () => {
      ACTIVITY_EVENTS.forEach((evt) => {
        globalThis.removeEventListener(evt, markActivity);
      });
      document.removeEventListener('visibilitychange', onVisible);
      globalThis.clearInterval(interval);
    };
  }, [enabled, timeoutMs, onTimeout]);
}
