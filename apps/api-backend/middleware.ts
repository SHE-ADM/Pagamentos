// middleware.ts
// Protege as rotas da API exigindo Authorization: Bearer <token> válido.
// Exceção: /api/health (sonda pública, sem dados sensíveis). A lógica de
// validação vive em lib/auth.ts (testável isoladamente). O caminho atual do
// frontend (leitura de e-mails) fala com o Flask direto — esta camada cobre a
// API de dados Next (CRUD), preparando a fase do portal público.

import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';

export async function middleware(req: NextRequest): Promise<Response> {
  const denied = await requireAuth(req);
  if (denied) return denied;
  return NextResponse.next();
}

// Aplica a todas as rotas /api/*, menos /api/health.
export const config = {
  matcher: ['/api/((?!health).*)'],
};
