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

/**
 * Escolhe entre a cota do GRUPO (migration 120) e o teto do ambiente.
 *
 * NÃO é o `readLimit` reaproveitado, e a duplicação aparente é deliberada: aquele valida uma
 * `string` vinda de env, este valida um `number` vindo do banco. Fundir os dois deixaria uma
 * edição futura enfraquecer as duas validações de uma vez — e são as duas metades da MESMA
 * proteção contra o limite `0`, que faz `count >= 0` ser sempre verdadeiro e devolve 429 a
 * qualquer usuário do grupo.
 *
 * O banco já barra `0` e negativo pelo CHECK `chk_user_group_ai_chat_limits`; esta função é a
 * segunda barreira, para o caso de a cota chegar por outro caminho (correção manual, cópia de
 * base, coluna alterada). Valor inutilizável cai no default do ambiente e é registrado.
 */
function pickLimit(override: number | null | undefined, envDefault: number): number {
  if (override === null || override === undefined) return envDefault;
  if (!Number.isInteger(override) || override <= 0) {
    console.error(
      `[ai-chat] rate limit: cota de grupo inválida ${JSON.stringify(override)}; usando ${envDefault}`,
    );
    return envDefault;
  }
  return override;
}

/** Cotas próprias do grupo, quando houver. Ver `lib/ai-chat/gate.ts`. */
interface LimitOverrides {
  perHour?: number | null;
  perDay?: number | null;
}

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
 * incidente de produto. O risco aceito é limitado: são 13 usuários internos, todos autenticados e
 * identificados na trilha de auditoria, então um eventual excesso é visível e atribuível.
 * (Se o perfil de uso mudar — usuários externos, volume alto — reavaliar para fail-closed.)
 */
export async function assertWithinRateLimit(
  userId: string,
  overrides?: LimitOverrides,
): Promise<void> {
  // 🔴 A mensagem tem de citar o limite EFETIVO, não a constante de módulo. Com uma cota de grupo
  // de 5 e o ambiente em 30, dizer "limite de 30" ao barrar na 5ª pergunta contradiz o próprio
  // comportamento e manda o suporte procurar um problema que não existe.
  const perHour = pickLimit(overrides?.perHour, PER_HOUR);
  const perDay = pickLimit(overrides?.perDay, PER_DAY);

  // 🔴 O CHECK da migration 120 (`per_day >= per_hour`) só compara o que está NO BANCO — ele não
  // enxerga o teto do ambiente. Um grupo com `per_hour = 200` e `per_day` NULL passa pelo CHECK e
  // produz 200/hora contra 150/dia do `.env`: a cota horária vira inalcançável, e o operador acha
  // que configurou algo que não vale. Esta é a única camada que conhece os DOIS valores efetivos,
  // então é aqui que a incoerência pode ser detectada.
  //
  // AVISO, não erro: o comportamento continua seguro (o menor dos dois manda) — o que está errado
  // é a configuração, e derrubar o chat por causa dela seria pior que registrá-la.
  if (perHour > perDay) {
    console.error(
      `[ai-chat] rate limit: cota horária (${perHour}) acima da diária (${perDay}) — `
        + 'a horária nunca será atingida; revise a cota do grupo (user_group).',
    );
  }

  const now = Date.now();
  const [lastHour, lastDay] = await Promise.all([
    countSince(userId, new Date(now - HOUR_MS)),
    countSince(userId, new Date(now - DAY_MS)),
  ]);

  if (lastHour !== null && lastHour >= perHour) {
    throw new AiChatError(
      `Você atingiu o limite de ${perHour} perguntas por hora. Tente novamente mais tarde.`,
      429,
    );
  }
  if (lastDay !== null && lastDay >= perDay) {
    throw new AiChatError(
      `Você atingiu o limite de ${perDay} perguntas por dia. Tente novamente amanhã.`,
      429,
    );
  }
}
