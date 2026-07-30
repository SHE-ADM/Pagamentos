// lib/ai-chat/log.test.ts
// Guarda da TRILHA DE AUDITORIA — achado do code review da Fase 3 (§20.6 do doc de arquitetura).
//
// POR QUE ESTE ARQUIVO EXISTE
// `logInteraction` **nunca lança** (de propósito: falha ao auditar não pode derrubar uma resposta já
// produzida). Sem teste, essa decisão vira um ponto cego perfeito: um nome de coluna errado, um
// schema trocado ou um campo esquecido fariam o pilar de auditoria ficar MORTO em produção sem
// nenhum sintoma — exatamente o modo de falha do §19.1, em que o GRANT ausente do `service_role`
// custou uma migration para ser descoberto.
//
// O teste mais valioso aqui não é "chamou o insert": é que as colunas gravadas EXISTEM de fato. Por
// isso o payload é conferido contra o schema declarado nas MIGRATIONS (mesmo padrão cross-layer de
// `tests/test_doc_type_domain_consistency.py`, que trava o enum contra o CHECK do banco).

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const insert = vi.fn();
const from = vi.fn(() => ({ insert }));
const schema = vi.fn(() => ({ from }));
vi.mock('../supabase-admin', () => ({ getSupabaseAdmin: () => ({ schema }) }));

import { logInteraction } from './log';

const ENTRY = {
  userId: '00000000-0000-0000-0000-000000000001',
  question: 'quanto tenho a pagar em agosto?',
  toolCalls: [{ name: 'resumo_situacao', params: {}, rows: 4, ms: 120 }],
  rowCount: 4,
  latencyMs: 3210,
  inputTokens: 180,
  outputTokens: 420,
  cacheReadTokens: 2175,
  cacheCreationTokens: 0,
};

/** Colunas de `analytics.ai_chat_log` conforme as migrations (CREATE TABLE 098 + ALTER 101). */
function columnsFromMigrations(): Set<string> {
  // Ancorado no ARQUIVO, não em `process.cwd()`: o cwd depende de como o vitest foi invocado (da
  // raiz do monorepo com `--root`, ou de dentro do app), e um caminho que muda com isso transforma
  // o guarda num teste que falha por motivo errado. lib/ai-chat → lib → api-backend → apps → raiz.
  const dir = resolve(import.meta.dirname, '..', '..', '..', '..', 'supabase', 'migrations');
  const files = readdirSync(dir).filter((f) => /^(098|101)_.*\.sql$/.test(f));
  const cols = new Set<string>();

  for (const f of files) {
    const sql = readFileSync(resolve(dir, f), 'utf8');

    // CREATE TABLE ... ai_chat_log ( <corpo> );
    const create = /CREATE TABLE[^;]*?ai_chat_log\s*\(([\s\S]*?)\n\);/i.exec(sql);
    for (const line of create?.[1].split('\n') ?? []) {
      const col = /^\s{2,}([a-z_]+)\s+[a-z]/i.exec(line);
      if (col) cols.add(col[1]);
    }

    // ADD COLUMN [IF NOT EXISTS] <coluna>
    for (const m of sql.matchAll(/ADD COLUMN\s+(?:IF NOT EXISTS\s+)?([a-z_]+)/gi)) cols.add(m[1]);
  }

  return cols;
}

describe('logInteraction — trilha de auditoria', () => {
  beforeEach(() => {
    // Corpo em BLOCO: mockReset devolve o mock, e retorno de função num hook do Vitest vira
    // teardown (o mock seria chamado ao fim do teste).
    insert.mockReset();
    from.mockClear();
    schema.mockClear();
    insert.mockResolvedValue({ error: null });
  });

  it('grava no schema analytics, na tabela ai_chat_log', async () => {
    await logInteraction(ENTRY);
    expect(schema).toHaveBeenCalledWith('analytics');
    expect(from).toHaveBeenCalledWith('ai_chat_log');
    expect(insert).toHaveBeenCalledTimes(1);
  });

  // O CERNE: coluna inexistente devolveria erro do PostgREST que `logInteraction` engole.
  it('só usa colunas que existem nas migrations', async () => {
    await logInteraction(ENTRY);
    const payload = insert.mock.calls[0][0] as Record<string, unknown>;
    const declared = columnsFromMigrations();

    // Sanidade do parser: se ele não achou o schema, o teste seria vacuamente verdadeiro.
    expect(declared.has('question')).toBe(true);
    expect(declared.has('cache_read_input_tokens')).toBe(true);

    const desconhecidas = Object.keys(payload).filter((k) => !declared.has(k));
    expect(desconhecidas).toEqual([]);
  });

  // Sem os 4 campos de token não há como estimar custo nem NOTAR um invalidador silencioso do
  // prompt caching (§19.4/§19.10): ele não gera erro, só zera o número e aumenta a fatura.
  it('registra os quatro campos de token, o custo e o resultado', async () => {
    await logInteraction(ENTRY);
    expect(insert).toHaveBeenCalledWith({
      user_id: ENTRY.userId,
      question: ENTRY.question,
      tool_calls: ENTRY.toolCalls,
      row_count: 4,
      latency_ms: 3210,
      input_tokens: 180,
      output_tokens: 420,
      cache_read_input_tokens: 2175,
      cache_creation_input_tokens: 0,
      error: null,
    });
  });

  it('a pergunta que FALHOU também é auditada, com o erro', async () => {
    await logInteraction({ ...ENTRY, error: 'rate limit' });
    const payload = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.error).toBe('rate limit');
  });

  // As duas metades da promessa "nunca lança": erro devolvido pelo PostgREST e exceção crua.
  it('não lança quando o insert devolve erro — e reporta no console', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    insert.mockResolvedValue({ error: { message: 'permission denied for table ai_chat_log' } });

    await expect(logInteraction(ENTRY)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(
      '[ai-chat] falha ao gravar ai_chat_log:',
      'permission denied for table ai_chat_log',
    );
    spy.mockRestore();
  });

  it('não lança quando o cliente explode', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    insert.mockRejectedValue(new Error('socket hang up'));

    await expect(logInteraction(ENTRY)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith('[ai-chat] falha ao gravar ai_chat_log:', 'socket hang up');
    spy.mockRestore();
  });
});
