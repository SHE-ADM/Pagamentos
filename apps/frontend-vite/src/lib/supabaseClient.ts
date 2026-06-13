// src/lib/supabaseClient.ts
// Cliente oficial do Supabase — usado apenas para Auth (sessao, refresh de
// token, onAuthStateChange). As leituras de dados continuam via fetch direto
// em services/supabase.ts, agora autenticadas com o token desta sessao.

import { createClient } from '@supabase/supabase-js';
import { hybridAuthStorage } from './authStorage';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  throw new Error('Variaveis VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY nao configuradas');
}

// storage: hybridAuthStorage — roteia o token conforme o checkbox "Lembrar-me":
//   - marcado    → localStorage  → sessão sobrevive ao fechamento do navegador
//   - desmarcado → sessionStorage → reabrir o app SEMPRE exige login (padrão)
// Em ambos os casos a sessão sobrevive a refresh (F5) na mesma aba, e o logout
// por inatividade de 10 min (useIdleLogout / AuthContext) impõe o teto na reabertura.
export const supabase = createClient(url, key, {
  auth: {
    storage: hybridAuthStorage,
    persistSession: true,
    autoRefreshToken: true,
  },
});
