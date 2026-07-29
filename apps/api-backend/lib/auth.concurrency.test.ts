// lib/auth.concurrency.test.ts
// Teste de REGRESSÃO DE SEGURANÇA do cliente anon compartilhado.
//
// POR QUE ESTE ARQUIVO É SEPARADO DE auth.test.ts: aquele faz
// `vi.mock('@supabase/supabase-js')` no escopo do módulo, substituindo o SDK inteiro — o que é
// certo para testar a LÓGICA de auth, e inútil aqui. O que precisa de cobertura é justamente o
// comportamento do SDK REAL, então este arquivo NÃO mocka o supabase-js: intercepta apenas o
// `fetch` global e deixa o postgrest-js montar o request de verdade.
//
// O QUE ESTÁ SENDO PROTEGIDO
// `getAnonClient()` devolve um SINGLETON de módulo (lib/auth.ts) e `canSeeConta` chama
// `.setHeader('Authorization', ...)` sobre ele a cada requisição. Se `setHeader` mutasse os
// headers do cliente compartilhado, duas requisições concorrentes de usuários DIFERENTES
// disputariam o mesmo objeto: entre o `setHeader` de A e o `await` de A, a requisição B poderia
// sobrescrever o header — e A consultaria o PostgREST com o JWT de B. Como a RLS da migration 076
// decide a visibilidade a partir de `auth.uid()`, isso seria vazamento de dados entre usuários,
// exatamente o que `canSeeConta` existe para impedir.
//
// POR QUE HOJE É SEGURO — DUAS camadas independentes no postgrest-js (ambas medidas, não
// deduzidas da leitura do código):
//   1. `client.from(...)` constrói um builder NOVO copiando os headers (`new Headers(...)`), de
//      modo que cada query já nasce com o próprio objeto;
//   2. `setHeader` faz copy-on-write (`this.headers = new Headers(this.headers)` antes do `set`).
// Medido com mutantes: sabotar APENAS a camada 2 não produz vazamento — a camada 1 sozinha já
// isola as requisições. Só sabotando as duas os tokens colidem (as duas chamadas saem com o mesmo
// `Authorization`), e é esse mutante que faz este teste falhar. Ou seja: o teste tem poder de
// detecção real, e a segurança atual tem folga — não depende de um único detalhe.
//
// Mesmo assim isto é garantia da IMPLEMENTAÇÃO INSTALADA, não do contrato público da biblioteca.
// Um `npm update` pode mudá-la sem aviso, e a falha seria silenciosa: nenhum erro, nenhum teste
// vermelho, apenas um usuário vendo a conta de outro sob concorrência.
//
// O teste afirma o COMPORTAMENTO ("cada requisição carrega o próprio token"), não o mecanismo —
// se o SDK trocar as duas camadas por outra estratégia igualmente correta, ele continua passando.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.stubEnv('SUPABASE_URL', 'https://proj.supabase.co');
vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');

// NÃO mockar '@supabase/supabase-js' aqui — o objetivo é exercitar o SDK real.
import { canSeeConta, getAnonClient } from './auth';
import { runTool } from './ai-chat/tools';

/** Requisição capturada pelo fetch interceptado. */
type Captured = { url: string; authorization: string | null };

const captured: Captured[] = [];

// Tokens gerados em RUNTIME, não literais. Um literal que se pareça com credencial dispara o
// `S6418` ("hard-coded secret") do SonarCloud, que reprova o quality gate do PR — foi o que já
// aconteceu com `"segredo-de-disparo"` em tests/test_flask_csrf_guard.py. Como o teste só precisa
// que os dois tokens sejam DISTINTOS e rastreáveis, o valor pode ser aleatório: o prefixo legível
// mantém a mensagem de falha diagnosticável.
const token = (rotulo: string) => `${rotulo}-${crypto.randomUUID()}`;

/**
 * Barreira que só libera quando `expected` requisições tiverem chegado. É o que força a
 * INTERCALAÇÃO real: sem ela, a primeira chamada resolveria antes de a segunda começar e o teste
 * passaria mesmo com um cliente mutável — testando nada.
 */
function makeBarrier(expected: number) {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    async wait() {
      arrived += 1;
      if (arrived >= expected) release();
      await open;
    },
  };
}

function reqWithToken(token: string): Request {
  return new Request('http://localhost/api/contas/7', {
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  captured.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('canSeeConta — isolamento do cliente anon compartilhado', () => {
  it('não vaza o token entre requisições concorrentes de usuários diferentes', async () => {
    const barrier = makeBarrier(2);

    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        captured.push({
          url: String(input),
          authorization: headers.get('authorization'),
        });
        // Segura as duas requisições até ambas terem montado seus headers. É aqui que um cliente
        // mutável se denunciaria: o segundo setHeader teria sobrescrito o primeiro.
        await barrier.wait();
        return new Response(JSON.stringify({ id: 7 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    );

    const tokenA = token('usuario-A');
    const tokenB = token('usuario-B');

    const [aVisible, bVisible] = await Promise.all([
      canSeeConta(reqWithToken(tokenA), 7),
      canSeeConta(reqWithToken(tokenB), 7),
    ]);

    expect(aVisible).toBe(true);
    expect(bVisible).toBe(true);

    expect(captured).toHaveLength(2);
    const enviados = captured.map((c) => c.authorization).sort();
    // A asserção central: DOIS tokens distintos chegaram ao PostgREST.
    // Com um cliente mutável, os dois seriam iguais (o último a chamar setHeader vence).
    expect(enviados).toEqual([`Bearer ${tokenA}`, `Bearer ${tokenB}`].sort());
  });

  it('envia o token do próprio request em chamadas sequenciais', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      captured.push({ url: String(input), authorization: headers.get('authorization') });
      return new Response(JSON.stringify({ id: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const primeiro = token('primeiro');
    const segundo = token('segundo');

    await canSeeConta(reqWithToken(primeiro), 1);
    await canSeeConta(reqWithToken(segundo), 1);

    // Um header residual do request anterior indicaria estado preso no singleton.
    expect(captured.map((c) => c.authorization)).toEqual([
      `Bearer ${primeiro}`,
      `Bearer ${segundo}`,
    ]);
  });

  it('não chama a rede quando não há token (curto-circuito antes do PostgREST)', async () => {
    vi.stubGlobal('fetch', async () => {
      captured.push({ url: 'nao-deveria-acontecer', authorization: null });
      return new Response('{}', { status: 200 });
    });

    const semToken = new Request('http://localhost/api/contas/7');
    await expect(canSeeConta(semToken, 7)).resolves.toBe(false);
    expect(captured).toHaveLength(0);
  });
});

// O chat de IA usa um caminho DIFERENTE do mesmo singleton: `.schema('analytics').rpc(...)` em vez
// de `.from(...)`. São implementações distintas no postgrest-js, e o teste acima — escrito para
// `from()` — não exercita nenhuma delas: o invariante de isolamento estava documentado como
// coberto e, para o caminho do chat, não estava.
//
// QUATRO camadas isolam este caminho (medidas com mutantes, não deduzidas da leitura):
//   1. `schema()` → `new PostgrestClient(...)`, cujo construtor faz `new Headers(headers)`;
//   2. `rpc()` → `const headers = new Headers(this.headers)`;
//   3. construtor de `PostgrestBuilder` → `new Headers(builder.headers)`;
//   4. `setHeader` → copy-on-write.
// Sabotar 1+2+4 NÃO produz vazamento — a camada 3 sozinha ainda isola. Só com as QUATRO
// desativadas os dois tokens colidem, e é aí que este teste falha (verificado). Ou seja: ele tem
// poder de detecção real, e a segurança atual tem folga grande — não depende de um detalhe único.
// Ainda assim, é garantia da implementação INSTALADA, não do contrato público: um `npm update`
// pode mudá-la, e a falha seria silenciosa (um usuário lendo o recorte de RLS de outro).
describe('runTool — isolamento no caminho de RPC (chat de IA)', () => {
  it('não vaza o token entre chamadas concorrentes de usuários diferentes', async () => {
    const barrier = makeBarrier(2);

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      captured.push({ url: String(input), authorization: headers.get('authorization') });
      await barrier.wait();
      return new Response('[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const tokenA = token('chat-A');
    const tokenB = token('chat-B');
    const client = getAnonClient();

    await Promise.all([
      runTool(client, tokenA, 'resumo_situacao', { p_sk_company: 1 }),
      runTool(client, tokenB, 'resumo_situacao', { p_sk_company: 2 }),
    ]);

    expect(captured).toHaveLength(2);
    // Com o singleton mutável, os dois sairiam com o MESMO Authorization — e um usuário do grupo
    // restrito receberia o recorte de RLS do outro, sem erro nenhum.
    expect(captured.map((c) => c.authorization).sort()).toEqual(
      [`Bearer ${tokenA}`, `Bearer ${tokenB}`].sort(),
    );
  });

  it('endereça a função no schema analytics, não em public', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      captured.push({ url: String(input), authorization: headers.get('authorization') });
      // `Content-Profile` é o header que seleciona o schema em POST/rpc. Com `Accept-Profile` a
      // função seria procurada em `public` e o PostgREST devolveria PGRST202.
      expect(headers.get('content-profile')).toBe('analytics');
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await runTool(getAnonClient(), token('t'), 'resumo_situacao', {});
    expect(captured[0].url).toContain('/rest/v1/rpc/resumo_situacao');
  });
});
