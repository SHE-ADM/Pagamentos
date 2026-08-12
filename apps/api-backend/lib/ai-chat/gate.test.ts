import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

/**
 * Carrega o gate com o admin mockado.
 *
 * ⚠️ `failFromError` e `ApiServiceError` vêm DAQUI, não de um import no topo do arquivo. O
 * `vi.resetModules()` cria um registro novo, e a classe importada antes dele é um objeto
 * DIFERENTE da que o gate acabou de carregar — `instanceof` daria falso e o teste do eco
 * concluiria "vira 500 genérico" sobre um erro que na produção é ecoado como 403. Artefato do
 * harness, com potencial de acusar um defeito que não existe (ou esconder um que existe).
 */
async function load(mock: ReturnType<typeof mockAdmin>) {
  vi.resetModules();
  vi.doMock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => mock.admin }));
  const [gate, response, apiError] = await Promise.all([
    import('./gate'),
    import('@/lib/response'),
    import('@/lib/api-error'),
  ]);
  return { ...gate, failFromError: response.failFromError, ApiServiceError: apiError.ApiServiceError };
}

const habilitado = (extra: Record<string, unknown> = {}): Resultado => ({
  data: { user_group: { ai_chat_enabled: true, ...extra } },
  error: null,
});

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.doUnmock('@/lib/supabase-admin');
});

describe('assertAiChatAllowed — acesso', () => {
  it('deixa passar quando o grupo está habilitado, e lê a tabela certa', async () => {
    const m = mockAdmin(habilitado());
    const { assertAiChatAllowed } = await load(m);

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
    const { assertAiChatAllowed, MENSAGEM_SEM_ACESSO } = await load(m);

    await expect(assertAiChatAllowed('user-1')).rejects.toMatchObject({
      status: 403,
      message: MENSAGEM_SEM_ACESSO,
    });
  });

  it('nega quando o usuário não tem perfil — grupo 0 (sentinela) não é liberado', async () => {
    const m = mockAdmin({ data: null, error: null });
    const { assertAiChatAllowed } = await load(m);

    await expect(assertAiChatAllowed('user-sem-perfil')).rejects.toMatchObject({ status: 403 });
  });

  it('a negação é ECOADA ao cliente — 403 curado, não 500 genérico', async () => {
    const m = mockAdmin({ data: { user_group: { ai_chat_enabled: false } }, error: null });
    const { assertAiChatAllowed, MENSAGEM_SEM_ACESSO, failFromError } = await load(m);

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
    const { assertAiChatAllowed } = await load(m);

    await expect(assertAiChatAllowed('user-1')).rejects.toThrow(/gate de acesso indisponível/);
    expect(erros).toHaveBeenCalled();
  });

  it('a falha de infraestrutura NÃO vira mensagem curada — 500 genérico, detalhe só no log', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const m = mockAdmin({ data: null, error: { message: 'relation "user_group" does not exist' } });
    const { assertAiChatAllowed, failFromError, ApiServiceError } = await load(m);

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
    const { assertAiChatAllowed } = await load(m);

    await expect(assertAiChatAllowed('user-1')).rejects.toMatchObject({ status: 403 });
  });
});

describe('assertAiChatAllowed — forma do embed e cotas', () => {
  // Medido: o postgrest-js instalado devolve OBJETO para FK to-one. Isso é propriedade da versão,
  // não do contrato — o normalizador aceita as duas formas, e os dois casos provam isso.
  it('aceita o embed como objeto', async () => {
    const m = mockAdmin(habilitado());
    const { assertAiChatAllowed } = await load(m);
    await expect(assertAiChatAllowed('u')).resolves.toEqual({ perHour: null, perDay: null });
  });

  it('aceita o embed como array', async () => {
    const m = mockAdmin({
      data: { user_group: [{ ai_chat_enabled: true, ai_chat_limit_per_hour: 5 }] },
      error: null,
    });
    const { assertAiChatAllowed } = await load(m);
    await expect(assertAiChatAllowed('u')).resolves.toEqual({ perHour: 5, perDay: null });
  });

  it('devolve as cotas do grupo quando existem', async () => {
    const m = mockAdmin(habilitado({ ai_chat_limit_per_hour: 5, ai_chat_limit_per_day: 20 }));
    const { assertAiChatAllowed } = await load(m);
    await expect(assertAiChatAllowed('u')).resolves.toEqual({ perHour: 5, perDay: 20 });
  });

  // O CHECK da migration 120 já barra 0/negativo no banco; esta é a segunda barreira, para cota que
  // chegue por outro caminho. Um `0` propagado viraria 429 para o grupo inteiro.
  it.each([0, -1, 2.5, Number.NaN])('descarta cota inutilizável (%s) devolvendo null', async (v) => {
    const m = mockAdmin(habilitado({ ai_chat_limit_per_hour: v }));
    const { assertAiChatAllowed } = await load(m);
    await expect(assertAiChatAllowed('u')).resolves.toMatchObject({ perHour: null });
  });
});
