import { ok } from '@/lib/response';
import { probePythonHealth } from '@/lib/python-bridge';

// Rotas não são cacheadas por padrão; explícito por clareza (health é dinâmico).
export const dynamic = 'force-dynamic';

export async function GET() {
  const pythonOk = await probePythonHealth();
  return ok({
    api: 'ok',
    python: pythonOk ? 'ok' : 'unreachable',
    timestamp: new Date().toISOString(),
  });
}
