// src/lib/chunkReload.ts
// Recuperação de falha ao carregar chunks lazy (code-splitting). Sintoma clássico:
// um DEPLOY novo invalida os hashes dos assets referenciados pelo index.html já
// aberto na aba; ao navegar para uma rota lazy ainda não baixada, o import dinâmico
// retorna 404 (ou o fallback SPA serve HTML em vez de JS) → o React lança no render →
// SEM Error Boundary, a árvore inteira some (tela branca). Um refresh resolve porque
// recarrega o index.html novo. Aqui detectamos esse erro e recarregamos UMA vez
// automaticamente (com trava anti-loop), tornando o refresh manual desnecessário.

// O evento `vite:preloadError` já é tipado pelo `vite/client` (VitePreloadErrorEvent)
// no WindowEventMap — não redeclarar aqui (causaria conflito de tipos).

const RELOAD_COUNT_KEY = 'pag:chunk-reload-count';
const MAX_RELOADS = 2; // após N tentativas seguidas, desiste e deixa a UI de erro aparecer

// Heurística de erro de carregamento de chunk (mensagens variam por navegador).
export function isChunkLoadError(error: unknown): boolean {
  let msg = '';
  if (error instanceof Error) msg = `${error.name} ${error.message}`;
  else if (typeof error === 'string') msg = error;
  return /dynamically imported module|failed to fetch dynamically|importing a module script failed|chunkloaderror|error loading dynamically imported module|module script failed/i.test(
    msg,
  );
}

function readReloadCount(): number {
  try {
    return Number(sessionStorage.getItem(RELOAD_COUNT_KEY)) || 0;
  } catch {
    return 0;
  }
}

/**
 * Recarrega a página para buscar a versão nova dos assets — no máximo `MAX_RELOADS`
 * vezes por sessão (anti-loop, caso o deploy esteja genuinamente quebrado).
 * @returns true se disparou o reload; false se atingiu o teto (caller deve mostrar erro).
 */
export function reloadOnceForChunk(): boolean {
  const count = readReloadCount();
  if (count >= MAX_RELOADS) return false;
  try {
    sessionStorage.setItem(RELOAD_COUNT_KEY, String(count + 1));
  } catch {
    /* sessionStorage indisponível — ainda assim tenta recarregar uma vez */
  }
  globalThis.location.reload();
  return true;
}

// Zera o contador após um carregamento bem-sucedido (o bundle principal montou) —
// chamado de App no mount. Garante que uma falha futura volte a ter as 2 tentativas.
export function clearChunkReloadCount(): void {
  try {
    sessionStorage.removeItem(RELOAD_COUNT_KEY);
  } catch {
    /* ignore */
  }
}

// Caminho rápido: o Vite emite `vite:preloadError` quando o preload de um módulo
// dinâmico falha — recarrega antes mesmo de o React tentar renderizar o erro.
export function installPreloadErrorReload(): void {
  globalThis.addEventListener('vite:preloadError', (event) => {
    event.preventDefault(); // evita o "unhandled error" padrão do Vite
    reloadOnceForChunk();
  });
}
