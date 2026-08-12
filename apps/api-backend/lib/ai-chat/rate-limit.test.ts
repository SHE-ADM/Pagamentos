import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// O módulo lê os limites de env NO CARREGAMENTO, então cada cenário precisa reimportar com o env
// já definido. `vi.resetModules()` + import dinâmico é o que permite isso.
const ORIGINAL_ENV = { ...process.env };

interface CountResult { count: number | null; error: { message: string } | null }

/** Mock do getSupabaseAdmin: devolve a sequência de resultados por chamada (hora, depois dia). */
function mockAdmin(results: CountResult[]) {
  const gte = vi.fn();
  for (const r of results) gte.mockResolvedValueOnce(r);
  // Se pedirem mais chamadas do que o previsto, devolve 0 (não trava o teste com undefined).
  gte.mockResolvedValue({ count: 0, error: null });

  const eq = vi.fn(() => ({ gte }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  const schema = vi.fn(() => ({ from }));
  return { admin: { schema }, schema, from, select, eq, gte };
}

async function load(mock: ReturnType<typeof mockAdmin>) {
  vi.resetModules();
  vi.doMock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => mock.admin }));
  return import('./rate-limit');
}

beforeEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.doUnmock('@/lib/supabase-admin');
});

describe('assertWithinRateLimit', () => {
  it('deixa passar quando está abaixo dos dois tetos', async () => {
    process.env.AI_CHAT_RATE_LIMIT_PER_HOUR = '30';
    process.env.AI_CHAT_RATE_LIMIT_PER_DAY = '150';
    const m = mockAdmin([{ count: 5, error: null }, { count: 40, error: null }]);
    const { assertWithinRateLimit } = await load(m);

    await expect(assertWithinRateLimit('user-1')).resolves.toBeUndefined();
    // Contagem no schema analytics, filtrada pelo usuário — não pode contar a caixa toda.
    expect(m.schema).toHaveBeenCalledWith('analytics');
    expect(m.from).toHaveBeenCalledWith('ai_chat_log');
    expect(m.eq).toHaveBeenCalledWith('user_id', 'user-1');
  });

  it('barra com 429 ao atingir o teto HORÁRIO', async () => {
    process.env.AI_CHAT_RATE_LIMIT_PER_HOUR = '30';
    const m = mockAdmin([{ count: 30, error: null }, { count: 30, error: null }]);
    const { assertWithinRateLimit } = await load(m);

    await expect(assertWithinRateLimit('user-1')).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining('por hora'),
    });
  });

  it('barra com 429 ao atingir o teto DIÁRIO mesmo com a hora folgada', async () => {
    process.env.AI_CHAT_RATE_LIMIT_PER_HOUR = '30';
    process.env.AI_CHAT_RATE_LIMIT_PER_DAY = '150';
    const m = mockAdmin([{ count: 1, error: null }, { count: 150, error: null }]);
    const { assertWithinRateLimit } = await load(m);

    await expect(assertWithinRateLimit('user-1')).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining('por dia'),
    });
  });

  // O teto é ">= limite", não "> limite": a chamada de número N+1 é que deve ser barrada.
  it('permite exatamente até o limite e barra a seguinte', async () => {
    process.env.AI_CHAT_RATE_LIMIT_PER_HOUR = '3';
    process.env.AI_CHAT_RATE_LIMIT_PER_DAY = '999';
    const ok = await load(mockAdmin([{ count: 2, error: null }, { count: 2, error: null }]));
    await expect(ok.assertWithinRateLimit('u')).resolves.toBeUndefined();

    const barrado = await load(mockAdmin([{ count: 3, error: null }, { count: 3, error: null }]));
    await expect(barrado.assertWithinRateLimit('u')).rejects.toMatchObject({ status: 429 });
  });

  // FAIL-OPEN é decisão deliberada e precisa de teste: sem ele, uma indisponibilidade do banco
  // derrubaria o chat inteiro em vez de apenas desligar o contador. O console.error é o que torna
  // a degradação visível — sem ele a proteção sumiria em silêncio.
  it('DEIXA PASSAR e registra no console quando a contagem falha (fail-open)', async () => {
    const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = mockAdmin([
      { count: null, error: { message: 'connection refused' } },
      { count: null, error: { message: 'connection refused' } },
    ]);
    const { assertWithinRateLimit } = await load(m);

    await expect(assertWithinRateLimit('user-1')).resolves.toBeUndefined();
    expect(erro).toHaveBeenCalledWith(
      expect.stringContaining('rate limit'),
      expect.stringContaining('connection refused'),
    );
  });

  // ---- Parse das variáveis de ambiente ----
  // Estes casos existem porque a versão inicial usava `Number(env ?? 30)` e quebrava nos dois
  // sentidos: env VAZIA virava teto 0 (429 para todo mundo) e env com lixo virava NaN (proteção
  // desligada em silêncio). Nenhum teste pegava, porque todos passavam valores válidos.

  it('env VAZIA cai no default — não vira teto 0, que barraria todos', async () => {
    process.env.AI_CHAT_RATE_LIMIT_PER_HOUR = '';
    process.env.AI_CHAT_RATE_LIMIT_PER_DAY = '';
    // 29 < 30 (default): passa. Com o bug, o teto seria 0 e isto rejeitaria.
    const m = mockAdmin([{ count: 29, error: null }, { count: 29, error: null }]);
    const { assertWithinRateLimit } = await load(m);

    await expect(assertWithinRateLimit('user-1')).resolves.toBeUndefined();
  });

  it.each(['abc', '-5', '10.5'])(
    'env inválida (%s) cai no default e AVISA — nunca desliga a proteção em silêncio',
    async (valor) => {
      const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
      process.env.AI_CHAT_RATE_LIMIT_PER_HOUR = valor;
      // 30 >= 30 (default) tem de barrar. Com o bug do NaN, passaria batido.
      const m = mockAdmin([{ count: 30, error: null }, { count: 30, error: null }]);
      const { assertWithinRateLimit } = await load(m);

      await expect(assertWithinRateLimit('user-1')).rejects.toMatchObject({ status: 429 });
      expect(erro).toHaveBeenCalledWith(expect.stringContaining('valor inválido'));
    },
  );

  // Falha parcial: a janela horária não pôde ser lida, mas a diária sim e está estourada. O limite
  // que PÔDE ser verificado tem de continuar valendo — senão um erro numa das contagens viraria
  // bypass completo.
  it('aplica o teto diário mesmo quando a contagem horária falhou', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.AI_CHAT_RATE_LIMIT_PER_DAY = '150';
    const m = mockAdmin([
      { count: null, error: { message: 'timeout' } },
      { count: 200, error: null },
    ]);
    const { assertWithinRateLimit } = await load(m);

    await expect(assertWithinRateLimit('user-1')).rejects.toMatchObject({ status: 429 });
  });
});

// ---------------------------------------------------------------------------
// Cota POR GRUPO (migration 120, Onda 8)
// ---------------------------------------------------------------------------
// Os casos acima continuam chamando `assertWithinRateLimit` com UM argumento — e é assim que eles
// provam o fallback para o ambiente. Os daqui exercitam o segundo argumento, que vem do gate.
describe('assertWithinRateLimit — cota do grupo', () => {
  it('a cota do grupo vence o teto do ambiente', async () => {
    process.env.AI_CHAT_RATE_LIMIT_PER_HOUR = '30';
    // 3 perguntas na última hora: passaria folgado no teto 30 do ambiente, barra na cota 3.
    const m = mockAdmin([{ count: 3, error: null }, { count: 3, error: null }]);
    const { assertWithinRateLimit } = await load(m);

    await expect(assertWithinRateLimit('user-1', { perHour: 3 })).rejects.toMatchObject({
      status: 429,
    });
  });

  it('🔴 a mensagem cita o limite EFETIVO, não a constante do ambiente', async () => {
    process.env.AI_CHAT_RATE_LIMIT_PER_HOUR = '30';
    const m = mockAdmin([{ count: 5, error: null }, { count: 5, error: null }]);
    const { assertWithinRateLimit } = await load(m);

    // Dizer "limite de 30" ao barrar na 5ª pergunta contradiz o próprio comportamento e manda o
    // suporte procurar um problema que não existe.
    await expect(assertWithinRateLimit('user-1', { perHour: 5 })).rejects.toMatchObject({
      message: expect.stringContaining('limite de 5 perguntas por hora'),
    });
  });

  it('cota diária do grupo também vale, e a mensagem a reflete', async () => {
    process.env.AI_CHAT_RATE_LIMIT_PER_DAY = '150';
    const m = mockAdmin([{ count: 1, error: null }, { count: 20, error: null }]);
    const { assertWithinRateLimit } = await load(m);

    await expect(assertWithinRateLimit('user-1', { perDay: 20 })).rejects.toMatchObject({
      message: expect.stringContaining('limite de 20 perguntas por dia'),
    });
  });

  it('cota nula (grupo sem override) cai no teto do ambiente', async () => {
    process.env.AI_CHAT_RATE_LIMIT_PER_HOUR = '30';
    const m = mockAdmin([{ count: 29, error: null }, { count: 29, error: null }]);
    const { assertWithinRateLimit } = await load(m);

    await expect(
      assertWithinRateLimit('user-1', { perHour: null, perDay: null }),
    ).resolves.toBeUndefined();
  });

  /**
   * O CHECK da 120 (`per_day >= per_hour`) só compara o que está NO BANCO. Com `per_day` nulo, o
   * teto diário vem do ambiente — e a incoerência atravessa a fronteira que o SQL não enxerga.
   * Esta é a única camada que conhece os dois valores efetivos.
   */
  it('AVISA quando a cota horária do grupo passa do teto diário do ambiente', async () => {
    const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.AI_CHAT_RATE_LIMIT_PER_DAY = '150';
    const m = mockAdmin([{ count: 1, error: null }, { count: 1, error: null }]);
    const { assertWithinRateLimit } = await load(m);

    // 200/hora contra 150/dia: a horária é inalcançável, e nada no banco poderia ter barrado isso.
    await expect(assertWithinRateLimit('user-1', { perHour: 200 })).resolves.toBeUndefined();
    expect(erro).toHaveBeenCalledWith(expect.stringContaining('acima da diária'));
  });

  it('NÃO avisa na configuração coerente — senão o aviso vira ruído e ninguém o lê', async () => {
    const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.AI_CHAT_RATE_LIMIT_PER_HOUR = '30';
    process.env.AI_CHAT_RATE_LIMIT_PER_DAY = '150';
    const m = mockAdmin([{ count: 1, error: null }, { count: 1, error: null }]);
    const { assertWithinRateLimit } = await load(m);

    await expect(assertWithinRateLimit('user-1', { perHour: 5, perDay: 20 })).resolves.toBeUndefined();
    expect(erro).not.toHaveBeenCalled();
  });

  // O CHECK da migration 120 já barra 0/negativo no banco, e o gate já descarta o inutilizável.
  // Esta é a terceira barreira: cota 0 aqui reproduziria o bug do `readLimit` (429 para o grupo).
  it.each([0, -5, 2.5, Number.NaN])(
    'cota inutilizável (%s) cai no default e AVISA',
    async (valor) => {
      const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
      process.env.AI_CHAT_RATE_LIMIT_PER_HOUR = '30';
      const m = mockAdmin([{ count: 29, error: null }, { count: 29, error: null }]);
      const { assertWithinRateLimit } = await load(m);

      await expect(assertWithinRateLimit('user-1', { perHour: valor })).resolves.toBeUndefined();
      expect(erro).toHaveBeenCalledWith(expect.stringContaining('cota de grupo inválida'));
    },
  );
});
