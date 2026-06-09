// src/lib/supabaseClient.js
// Cliente oficial do Supabase — usado apenas para Auth (sessao, refresh de
// token, onAuthStateChange). As leituras de dados continuam via fetch direto
// em services/supabase.js, agora autenticadas com o token desta sessao.

import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !key) {
  throw new Error('Variaveis VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY nao configuradas')
}

export const supabase = createClient(url, key)
