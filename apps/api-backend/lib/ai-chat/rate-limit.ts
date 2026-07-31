// lib/ai-chat/rate-limit.ts
// Teto de uso do chat por usuário — item 1.5 da Onda 1 (docs/roadmap-enriquecimento-dados.md).
//
// POR QUE EXISTE
// Até aqui não havia NENHUM limite: qualquer sessão autenticada podia disparar chamadas pagas à
// Claude API em sequência, sem teto. Era o único risco financeiro em aberto do projeto — por isso
// a auditoria do roadmap promoveu este item da Onda 8 para a Onda 1.
//
// POR QUE O CONTADOR É O PRÓPRIO `analytics.ai_chat_log`, E NÃO MEMÓRIA
// A rota roda em FUNCTION SERVERLESS: cada invocação pode cair numa instância nova, e o processo é
// congelado entre requisições. Um contador em memória (Map, variável de módulo) zeraria de forma
// imprevisível — daria a impressão de proteger sem proteger, que é pior que não ter.
// O log já é gravado a cada interação (inclusive nas que falham) e já tem o índice
// `ix_ai_chat_log_user_created (user_id, created_at DESC)` da migration 098: as duas contagens
// abaixo são index-only scans.
//
// POR QUE CONTA TAMBÉM O QUE FALHOU
// Pergunta que deu 429 do provedor, que estourou o teto de iterações ou que o usuário cancelou
// TAMBÉM gastou tokens — o gateway registra o custo parcial justamente por isso. Um limite que só
// contasse sucesso seria contornável por perguntas que falham caro.

import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { AiChatError } from './errors';

/**
 * Lê um teto de variável de ambiente, caindo no default quando o valor não é utilizável.
 *
 * 🔴 NÃO SIMPLIFICAR PARA `Number(env ?? default)` — foi o que estava aqui e é defeituoso nos dois
 * sentidos (medido):
 *   - env declarada e VAZIA (`''`), caso comum quando alguém cria a variável no painel da Vercel e
 *     não preenche: `'' ?? 30` devolve `''`, e `Number('')` é **0**. Com teto 0, `count >= 0` é
 *     sempre verdadeiro → **429 para todos os usuários**, o chat inteiro fora do ar.
 *   - env com lixo (`'abc'`) ou negativa: `Number('abc')` é **NaN**, e toda comparação com NaN é
 *     `false` → o limite **nunca** aplica, ou seja, a proteção de custo desliga em SILÊNCIO.
 *
 * O segundo é o pior: nada falha, nada aparece no log, e só a fatura denuncia. Por isso o valor
 * precisa ser inteiro finito e positivo para ser aceito; qualquer outra coisa cai no default e é
 * registrada no console.
 */
function readLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`[ai-chat] rate limit: valor inválido ${JSON.stringify(raw)}; usando ${fallback}`);
    return fallback;
  }
  return n;
}

/** Perguntas por hora, por usuário. Configurável por env para ajuste sem deploy de código. */
const PER_HOUR = readLimit(process.env.AI_CHAT_RATE_LIMIT_PER_HOUR, 30);
/** Teto diário — sem ele, o limite horário ainda permitiria 24× o volume num único dia. */
const PER_DAY = readLimit(process.env.AI_CHAT_RATE_LIMIT_PER_DAY, 150);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Conta interações do usuário desde `since`. Devolve `null` quando a contagem não é confiável. */
async function countSince(userId: string, since: Date): Promise<number | null> {
  const { count, error } = await getSupabaseAdmin()
    .schema('analytics')
    .from('ai_chat_log')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', since.toISOString());

  if (error) {
    console.error('[ai-chat] rate limit: contagem falhou', error.message);
    return null;
  }
  return count ?? 0;
}

/**
 * Lança `AiChatError` 429 quando o usuário excedeu o teto horário ou diário.
 *
 * FAIL-OPEN DELIBERADO: se a contagem falhar (banco indisponível, permissão), a função **deixa
 * passar** e registra no console. É a mesma escolha de `logInteraction`, e pelo mesmo motivo —
 * derrubar o chat inteiro por causa do contador transformaria um problema de infraestrutura num
 * incidente de produto. O risco aceito é limitado: são ~12 usuários internos, todos autenticados e
 * identificados na trilha de auditoria, então um eventual excesso é visível e atribuível.
 * (Se o perfil de uso mudar — usuários externos, volume alto — reavaliar para fail-closed.)
 */
export async function assertWithinRateLimit(userId: string): Promise<void> {
  const now = Date.now();
  const [lastHour, lastDay] = await Promise.all([
    countSince(userId, new Date(now - HOUR_MS)),
    countSince(userId, new Date(now - DAY_MS)),
  ]);

  if (lastHour !== null && lastHour >= PER_HOUR) {
    throw new AiChatError(
      `Você atingiu o limite de ${PER_HOUR} perguntas por hora. Tente novamente mais tarde.`,
      429,
    );
  }
  if (lastDay !== null && lastDay >= PER_DAY) {
    throw new AiChatError(
      `Você atingiu o limite de ${PER_DAY} perguntas por dia. Tente novamente amanhã.`,
      429,
    );
  }
}
