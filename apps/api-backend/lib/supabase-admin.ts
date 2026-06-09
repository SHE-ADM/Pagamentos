// lib/supabase-admin.ts
// Cliente Supabase com a service_role key — SOMENTE no servidor. Ignora RLS,
// usado para operações de escrita/CRUD pela API. NUNCA importar em código de
// cliente nem expor a chave no frontend.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let cached: SupabaseClient | null = null;

// Lazy: evita lançar no import (ex.: durante build) quando as envs ainda não
// estão presentes. O erro só ocorre se a API for de fato usada sem configuração.
export function getSupabaseAdmin(): SupabaseClient {
  if (!url || !serviceKey) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não configuradas no ambiente do servidor');
  }
  if (!cached) {
    cached = createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return cached;
}
