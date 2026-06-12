// src/lib/supabaseClient.ts
// Cliente oficial do Supabase — usado apenas para Auth (sessao, refresh de
// token, onAuthStateChange). As leituras de dados continuam via fetch direto
// em services/supabase.ts, agora autenticadas com o token desta sessao.

import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  throw new Error('Variaveis VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY nao configuradas');
}

// storage: sessionStorage (em vez do localStorage padrão) — a sessão é
// descartada ao fechar a aba/navegador, então reabrir o app SEMPRE exige login.
// Sobrevive a refresh (F5) na mesma aba. Complementa o logout por inatividade
// de 10 min (useIdleLogout / AuthContext).
export const supabase = createClient(url, key, {
  auth: {
    storage: globalThis.sessionStorage,
    persistSession: true,
    autoRefreshToken: true,
  },
});
