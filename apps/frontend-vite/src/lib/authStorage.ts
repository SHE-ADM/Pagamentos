// src/lib/authStorage.ts
// Storage adapter híbrido para a sessão do Supabase Auth.
//
// O Supabase fixa o `storage` no momento do createClient(), mas a escolha entre
// persistir (localStorage) ou descartar ao fechar o navegador (sessionStorage)
// depende do checkbox "Lembrar-me" — conhecido só em runtime. Este adapter roteia
// o token conforme uma flag de preferência (`pag:remember`) gravada no localStorage:
//   - marcado   → token em localStorage  → sobrevive ao fechamento do navegador
//   - desmarcado → token em sessionStorage → reabrir o app sempre exige login
//
// O teto de inatividade de 10 min (useIdleLogout) continua valendo em ambos os casos.
//
// SEGURANÇA (S1-2): o access_token fica em web-storage (local/session) — exfiltrável por
// XSS POR DESIGN do supabase-js. Hoje o risco é CONTIDO (sem vetor de XSS reproduzível —
// ver S5; React escapa, sem HTML cru) e mitigado pela CSP (S5) + expiração da sessão. Não
// é uma fronteira contra o próprio usuário (é o browser dele). Migrar a sessão para cookie
// HttpOnly fecharia a exposição a XSS, mas muda a arquitetura de auth — fora deste escopo.

const REMEMBER_KEY = 'pag:remember';

// Valor persistido para cada estado da preferência (constantes nomeadas —
// sem magic strings; '0' é guardado explicitamente em vez de remover a chave).
const REMEMBER_ON = '1';
const REMEMBER_OFF = '0';

// Define a preferência de persistência. Chamado no login, ANTES do signIn, para
// que o token recém-emitido já seja gravado no storage correto.
export function setRememberPreference(remember: boolean): void {
  localStorage.setItem(REMEMBER_KEY, remember ? REMEMBER_ON : REMEMBER_OFF);
}

// Lê a preferência persistida — usada para inicializar o checkbox "Lembrar-me"
// refletindo a última escolha do usuário (mantida até ele mesmo desmarcar).
export function getRememberPreference(): boolean {
  return localStorage.getItem(REMEMBER_KEY) === REMEMBER_ON;
}

// Adapter no formato esperado pelo Supabase (`{ getItem, setItem, removeItem }`).
export const hybridAuthStorage = {
  // Lê de onde o token estiver. setItem garante que só um dos storages o contém,
  // então a ordem de leitura é indiferente para a corretude.
  getItem(key: string): string | null {
    return sessionStorage.getItem(key) ?? localStorage.getItem(key);
  },

  // Grava no storage escolhido e remove do outro, evitando duplicata órfã que
  // poderia "ressuscitar" uma sessão após o usuário trocar a preferência.
  setItem(key: string, value: string): void {
    const remembering = getRememberPreference();
    const target = remembering ? localStorage : sessionStorage;
    const other = remembering ? sessionStorage : localStorage;
    other.removeItem(key);
    target.setItem(key, value);
  },

  // Logout/expiração limpa em ambos os storages.
  removeItem(key: string): void {
    sessionStorage.removeItem(key);
    localStorage.removeItem(key);
  },
};
