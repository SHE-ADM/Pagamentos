// apps/frontend-vite/tests/vercel-config.test.ts
// Guarda do vercel.json. Motivo: um deploy de PRODUÇÃO já falhou por schema inválido —
// `headers[1] should NOT have additional property "//"`. JSON não tem comentário, e a
// convenção "//" (comum em package.json) é rejeitada pelo Vercel na validação, que roda
// ANTES do build: nada aparece nos logs de build, o deploy vai a ERROR e o alias de
// produção fica preso no deploy anterior. Nenhum gate do CI pegava isso — daí este teste.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const cfg = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8')) as Record<string, unknown>;

// Chaves aceitas pelo schema em cada nível (as que este projeto usa).
const ROOT_KEYS = new Set(['$schema', 'headers', 'rewrites', 'redirects', 'cleanUrls', 'trailingSlash', 'buildCommand', 'outputDirectory', 'framework', 'installCommand', 'regions', 'functions', 'crons', 'images', 'git']);
const RULE_KEYS = new Set(['source', 'headers', 'has', 'missing']);
const HEADER_KEYS = new Set(['key', 'value']);
const REWRITE_KEYS = new Set(['source', 'destination', 'has', 'missing', 'statusCode']);

interface HeaderRule { source: string; headers: { key: string; value: string }[] }

const headers = cfg.headers as HeaderRule[];
const rewrites = cfg.rewrites as Record<string, unknown>[];

describe('vercel.json — schema (o Vercel valida ANTES do build; erro aqui = deploy ERROR)', () => {
  it('não tem propriedade extra na raiz', () => {
    expect(Object.keys(cfg).filter((k) => !ROOT_KEYS.has(k))).toEqual([]);
  });

  it('não tem propriedade extra nas regras de header (nem "//" como comentário)', () => {
    headers.forEach((rule, i) => {
      expect(Object.keys(rule).filter((k) => !RULE_KEYS.has(k)), `headers[${i}]`).toEqual([]);
      rule.headers.forEach((h, j) => {
        expect(Object.keys(h).filter((k) => !HEADER_KEYS.has(k)), `headers[${i}].headers[${j}]`).toEqual([]);
      });
    });
  });

  it('não tem propriedade extra nos rewrites', () => {
    rewrites.forEach((r, i) => {
      expect(Object.keys(r).filter((k) => !REWRITE_KEYS.has(k)), `rewrites[${i}]`).toEqual([]);
    });
  });
});

describe('vercel.json — regras que não podem regredir', () => {
  const csp = headers.find((h) => h.source === '/(.*)');
  const assets = headers.find((h) => h.source === '/assets/(.*)');

  it('mantém o CSP global', () => {
    expect(csp?.headers.map((h) => h.key)).toContain('Content-Security-Policy');
  });

  it('cacheia os assets com hash como immutable', () => {
    const cc = assets?.headers.find((h) => h.key === 'Cache-Control')?.value;
    expect(cc).toBe('public, max-age=31536000, immutable');
  });

  it('a regra de cache NÃO alcança o index.html — é ele que aponta para os nomes novos', () => {
    const re = new RegExp(`^${assets?.source ?? ''}$`);
    expect(re.test('/index.html')).toBe(false);
    expect(re.test('/')).toBe(false);
    expect(re.test('/consulta')).toBe(false);
    expect(re.test('/assets/index-CLNzY0MZ.js')).toBe(true);
  });

  it('mantém o proxy /data-api para a Next API e o fallback SPA', () => {
    expect(rewrites.some((r) => r.source === '/data-api/:path*')).toBe(true);
    // O fallback SPA precisa ser o ÚLTIMO: a regra `/(.*)` casa tudo e engoliria as demais.
    expect(rewrites[rewrites.length - 1]).toMatchObject({ source: '/(.*)', destination: '/index.html' });
  });
});
