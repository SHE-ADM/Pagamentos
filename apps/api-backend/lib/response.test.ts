import { describe, it, expect } from 'vitest';
import { ok, fail } from './response';

describe('response envelope', () => {
  it('ok() envelopa data com success=true e meta opcional', async () => {
    const res = ok({ a: 1 }, { total: 10 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, data: { a: 1 }, meta: { total: 10 } });
  });

  it('ok() sem meta omite a chave', async () => {
    const res = ok({ a: 1 });
    const body = await res.json();
    expect(body).toEqual({ success: true, data: { a: 1 } });
  });

  it('fail() retorna success=false com o status informado', async () => {
    const res = fail('boom', 422);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: 'boom' });
  });

  it('fail() usa status 400 por padrão', () => {
    expect(fail('x').status).toBe(400);
  });
});
