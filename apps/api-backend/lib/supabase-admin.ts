// lib/supabase-admin.ts
// Cliente Supabase com a service_role key — SOMENTE no servidor. Ignora RLS,
// usado para operações de escrita/CRUD pela API. NUNCA importar em código de
// cliente nem expor a chave no frontend.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

// Lazy: as envs são lidas só no primeiro uso (não no import), para não lançar
// durante o build quando ainda não estão presentes — e para que testes que as
// configuram após o import (vi.stubEnv) sejam respeitados. O erro só ocorre se a
// API for de fato usada sem configuração.
export function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não configuradas no ambiente do servidor');
  }
  cached ??= createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cached;
}
