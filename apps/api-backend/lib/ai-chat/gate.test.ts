import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 🔴 MOCK ESTÁTICO (`vi.mock` içado), NÃO `vi.resetModules()` + `vi.doMock` + import dinâmico.
 *
 * A primeira versão deste arquivo usava o padrão dinâmico copiado de `rate-limit.test.ts` — que lá
 * é NECESSÁRIO, porque aquele módulo lê os tetos de env no CARREGAMENTO e cada cenário precisa de
 * um env diferente. O `gate.ts` não lê nada no carregamento, então o padrão só trazia o custo.
 *
 * E o custo era real: com `resetModules`, se o import dinâmico enxerga o mock passa a depender do
 * estado de registro que o teste ANTERIOR deixou — ou seja, a suíte dependia da ORDEM. Passou
 * localmente e QUEBROU NO CI (`SUPABASE_URL não configurada` no último caso do `it.each`, onde o
 * módulo real vazou). Mock içado elimina a classe inteira: há uma só instância, sempre mockada.
 *
 * De brinde, some a armadilha do `instanceof`: com um registro só, o `ApiServiceError` importado
 * aqui é o MESMO que o gate lança — no padrão dinâmico eram objetos diferentes, e a asserção do
 * eco concluía "500 genérico" sobre um erro que em produção é ecoado como 403.
 */
const supabase = vi.hoisted(() => ({ admin: null as unknown }));
vi.mock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => supabase.admin }));

import { assertAiChatAllowed, MENSAGEM_SEM_ACESSO } from './gate';
import { failFromError } from '@/lib/response';
import { ApiServiceError } from '@/lib/api-error';

/**
 * Mock do getSupabaseAdmin. A cadeia é `from().select().eq().maybeSingle()`.
 *
 * `maybeSingle` devolve o resultado completo do PostgREST (`{ data, error }`) para os casos poderem
 * exercitar o ramo de FALHA — que é o mais importante deste arquivo, e o único que a suíte do
 * rate-limit exercita na direção oposta (lá a falha DEIXA passar; aqui ela BLOQUEIA).
 */
interface Resultado {
  data: unknown;
  error: { message: string } | null;
}

function mockAdmin(resultado: Resultado) {
  const maybeSingle = vi.fn(async () => resultado);
  const eq = vi.fn<(coluna: string, valor: string) => { maybeSingle: typeof maybeSingle }>(
    () => ({ maybeSingle }),
  );
  // Assinatura declarada no genérico (e não como parâmetro nomeado, que viraria variável não
  // usada): sem ela o mock é `vi.fn(() => ...)`, `mock.calls[0][0]` não existe para o TypeScript
  // e a asserção sobre as COLUNAS lidas nem compilaria.
  const select = vi.fn<(colunas: string) => { eq: typeof eq }>(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { admin: { from }, from, select, eq, maybeSingle };
}

/** Aplica o mock deste cenário. Devolve os espiões da cadeia para asserção. */
function load(mock: ReturnType<typeof mockAdmin>): ReturnType<typeof mockAdmin> {
  supabase.admin = mock.admin;
  return mock;
}

const habilitado = (extra: Record<string, unknown> = {}): Resultado => ({
  data: { user_group: { ai_chat_enabled: true, ...extra } },
  error: null,
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('assertAiChatAllowed — acesso', () => {
  it('deixa passar quando o grupo está habilitado, e lê a tabela certa', async () => {
    const m = mockAdmin(habilitado());
    load(m);

    await expect(assertAiChatAllowed('user-1')).resolves.toEqual({ perHour: null, perDay: null });
    expect(m.from).toHaveBeenCalledWith('user_profile');
    expect(m.eq).toHaveBeenCalledWith('user_id', 'user-1');
    // A fonte do grupo é a tabela, nunca o claim do JWT (medido defasado em 2 de 13 usuários).
    expect(m.select.mock.calls[0][0]).toContain('user_group(ai_chat_enabled');
  });

  it('nega com 403 e a mensagem única quando o grupo não está habilitado', async () => {
    const m = mockAdmin({
      data: { user_group: { ai_chat_enabled: false } },
      error: null,
    });
    load(m);

    await expect(assertAiChatAllowed('user-1')).rejects.toMatchObject({
      status: 403,
      message: MENSAGEM_SEM_ACESSO,
    });
  });

  it('nega quando o usuário não tem perfil — grupo 0 (sentinela) não é liberado', async () => {
    const m = mockAdmin({ data: null, error: null });
    load(m);

    await expect(assertAiChatAllowed('user-sem-perfil')).rejects.toMatchObject({ status: 403 });
  });

  it('a negação é ECOADA ao cliente — 403 curado, não 500 genérico', async () => {
    const m = mockAdmin({ data: { user_group: { ai_chat_enabled: false } }, error: null });
    load(m);

    const erro = await assertAiChatAllowed('user-1').catch((e: unknown) => e);
    const res = failFromError(erro, 'ai-chat');
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ success: false, error: MENSAGEM_SEM_ACESSO });
  });
});

describe('assertAiChatAllowed — fail-closed', () => {
  it('🔴 falha de consulta BLOQUEIA (o oposto do rate limit, que deixa passar)', async () => {
    const erros = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const m = mockAdmin({ data: null, error: { message: 'connection reset' } });
    load(m);

    await expect(assertAiChatAllowed('user-1')).rejects.toThrow(/gate de acesso indisponível/);
    expect(erros).toHaveBeenCalled();
  });

  it('a falha de infraestrutura NÃO vira mensagem curada — 500 genérico, detalhe só no log', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const m = mockAdmin({ data: null, error: { message: 'relation "user_group" does not exist' } });
    load(m);

    const erro = await assertAiChatAllowed('user-1').catch((e: unknown) => e);
    // Não é ApiServiceError de propósito: aquela classe significa "mensagem escrita para o usuário".
    expect(erro).not.toBeInstanceOf(ApiServiceError);

    const res = failFromError(erro, 'ai-chat');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Erro interno ao processar a solicitação');
    expect(body.error).not.toContain('user_group');
  });

  // A flag chega de fora tipada como `unknown`. Se o dia em que o PostgREST devolver a coluna em
  // outra forma (cache velho, JSON com string) o gate ler por truthiness, `'false'` LIBERA.
  it.each([
    ['ausente', {}],
    ['null', { ai_chat_enabled: null }],
    ['string "false"', { ai_chat_enabled: 'false' }],
    ['string "true"', { ai_chat_enabled: 'true' }],
    ['número 1', { ai_chat_enabled: 1 }],
  ])('nega quando ai_chat_enabled vem como %s', async (_rotulo, grupo) => {
    const m = mockAdmin({ data: { user_group: grupo }, error: null });
    load(m);

    await expect(assertAiChatAllowed('user-1')).rejects.toMatchObject({ status: 403 });
  });
});

describe('assertAiChatAllowed — forma do embed e cotas', () => {
  // Medido: o postgrest-js instalado devolve OBJETO para FK to-one. Isso é propriedade da versão,
  // não do contrato — o normalizador aceita as duas formas, e os dois casos provam isso.
  it('aceita o embed como objeto', async () => {
    const m = mockAdmin(habilitado());
    load(m);
    await expect(assertAiChatAllowed('u')).resolves.toEqual({ perHour: null, perDay: null });
  });

  it('aceita o embed como array', async () => {
    const m = mockAdmin({
      data: { user_group: [{ ai_chat_enabled: true, ai_chat_limit_per_hour: 5 }] },
      error: null,
    });
    load(m);
    await expect(assertAiChatAllowed('u')).resolves.toEqual({ perHour: 5, perDay: null });
  });

  it('devolve as cotas do grupo quando existem', async () => {
    const m = mockAdmin(habilitado({ ai_chat_limit_per_hour: 5, ai_chat_limit_per_day: 20 }));
    load(m);
    await expect(assertAiChatAllowed('u')).resolves.toEqual({ perHour: 5, perDay: 20 });
  });

  // O CHECK da migration 120 já barra 0/negativo no banco; esta é a segunda barreira, para cota que
  // chegue por outro caminho. Um `0` propagado viraria 429 para o grupo inteiro.
  it.each([0, -1, 2.5, Number.NaN])('descarta cota inutilizável (%s) devolvendo null', async (v) => {
    const m = mockAdmin(habilitado({ ai_chat_limit_per_hour: v }));
    load(m);
    await expect(assertAiChatAllowed('u')).resolves.toMatchObject({ perHour: null });
  });
});
