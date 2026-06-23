// middleware.ts
// Protege as rotas da API exigindo Authorization: Bearer <token> válido.
// Exceções públicas: /api/health (sonda) e /api/auth/login (autenticação — não há
// token antes de logar). A lógica de validação vive em lib/auth.ts (testável
// isoladamente). O caminho atual do frontend (leitura de e-mails) fala com o Flask
// direto — esta camada cobre a API de dados Next (CRUD), preparando o portal público.

import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';

export async function middleware(req: NextRequest): Promise<Response> {
  const denied = await requireAuth(req);
  if (denied) return denied;
  return NextResponse.next();
}

// Aplica a todas as rotas /api/*, menos /api/health e /api/auth/login (públicas).
export const config = {
  matcher: ['/api/((?!health|auth/login).*)'],
};
