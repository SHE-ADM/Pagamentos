// lib/ai-chat/gate.ts
// Gate de uso do chat de IA por GRUPO — item 8.3 da Onda 8 (docs/roadmap-enriquecimento-dados.md).
//
// POR QUE EXISTE
// Até aqui qualquer sessão autenticada usava o assistente: o widget era montado sem condição e a
// rota só exigia um usuário válido. O rate limit da Onda 1 responde "quanto", nunca "quem" — não
// havia como dizer que um grupo inteiro não deve consumir um recurso pago.
//
// 🔴 POR QUE ESTE MÓDULO É SEPARADO DO `rate-limit.ts`, E NÃO PODE SER FUNDIDO COM ELE
// Os dois rodam lado a lado na rota e parecem "dois pré-checks" — mas têm políticas de falha
// OPOSTAS, e de propósito:
//
//     rate-limit.ts  → VOLUME       → falha ABERTO (contador indisponível não derruba o produto)
//     gate.ts        → AUTORIZAÇÃO  → falha FECHADO (não consegui provar que pode ⇒ não pode)
//
// Sob o mesmo arquivo, o refactor mais natural do mundo ("unificar o tratamento de erro dos dois
// pré-checks") converte uma autorização em bypass, sem erro, sem teste vermelho e sem sintoma. A
// separação física é o que torna essa fusão uma decisão visível em vez de um acidente.
//
// POR QUE POR GRUPO (e não por usuário): espelha `user_group.sees_only_own_accounts` (migration
// 076), que já é o padrão de "flag de comportamento por grupo" deste projeto. As duas flags são
// ORTOGONAIS — aquela decide quais LINHAS o usuário vê, esta decide se ele pode CHAMAR a feature.
//
// 🔴 POR QUE O GRUPO VEM DE `user_profile`, E NUNCA DO JWT
// Medido em 2026-08-12: `auth.users.raw_app_meta_data->>'group_id'` existe em apenas 2 dos 13
// usuários, e nos DOIS ele diz `0` enquanto o `user_profile` diz `1` e `7`. Ler o claim
// autorizaria e negaria as pessoas erradas **sem levantar erro nenhum** — a pior classe de falha
// para uma autorização. A fonte de verdade do vínculo é a tabela (migration 065), como o
// `getUserGroupId` de `lib/auth.ts` já faz.

import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { AiChatError } from './errors';

/** Mensagem única da negação. Exportada para o teste da rota afirmar o que vai à auditoria. */
// ts-prune-ignore-next — consumido pelos testes e pela mensagem de erro da própria rota.
export const MENSAGEM_SEM_ACESSO =
  'O assistente de IA não está liberado para o seu grupo de usuário. '
  + 'Fale com o administrador do sistema.';

/**
 * Cotas próprias do grupo. `null` em qualquer campo = usa o teto global do ambiente.
 *
 * Não devolve o `group_id`: nada o consumiria, e campo buscado-e-descartado vira, com o tempo,
 * "dado que alguém deve estar usando". O gate responde exatamente duas coisas — pode usar? com
 * que folga? A identidade do grupo, quando for preciso auditá-la, está no banco.
 *
 * Estruturalmente compatível com o `LimitOverrides` do `rate-limit.ts`, e os dois tipos são
 * declarados SEPARADAMENTE de propósito: importar um do outro acoplaria o módulo de VOLUME ao de
 * AUTORIZAÇÃO, que é justamente a fusão que o cabeçalho deste arquivo existe para impedir.
 */
// ts-prune-ignore-next — contrato consumido por inferência em route.ts / rate-limit.ts.
export interface AiChatGate {
  perHour: number | null;
  perDay: number | null;
}

/** Formato da linha devolvida pelo embed — sem tipos gerados, o shape é declarado aqui. */
interface LinhaPerfil {
  // Medido no postgrest-js instalado (2026-08-12): FK to-one devolve OBJETO, não array. O
  // normalizador abaixo aceita os dois assim mesmo — a forma é propriedade da versão instalada,
  // não do contrato, e é a mesma classe de coisa que `auth.concurrency.test.ts` existe para fixar.
  user_group?: LinhaGrupo | LinhaGrupo[] | null;
}

interface LinhaGrupo {
  ai_chat_enabled?: unknown;
  ai_chat_limit_per_hour?: unknown;
  ai_chat_limit_per_day?: unknown;
}

function primeiro(v: LinhaGrupo | LinhaGrupo[] | null | undefined): LinhaGrupo | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/** Converte para inteiro positivo, ou `null`. O domínio real é imposto pelo CHECK da migration. */
function cota(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * Garante que o usuário pode usar o chat e devolve as cotas do grupo dele.
 *
 * 🔴 FAIL-CLOSED, ao contrário do `assertWithinRateLimit`. Se a consulta falhar, não sabemos se o
 * usuário pode — e "não sei" tem de significar "não". O erro lançado aqui é um `Error` COMUM, não
 * um `AiChatError`: os dois produzem a mesma resposta HTTP (500 genérico), mas `AiChatError`
 * significa, neste projeto, "mensagem curada, escrita para o usuário ler e ecoada ao cliente".
 * Usá-lo para uma falha de infraestrutura embaçaria um contrato que hoje é nítido.
 *
 * ❌ NÃO transformar "coluna não existe" (deploy fora de ordem, cache de schema do PostgREST
 * atrasado) num passe livre. É a "correção" tentadora quando o chat cai depois de um deploy — e é
 * um backdoor fail-open acionado por string de erro. A resposta certa é a ordem de implantação:
 * migration → conferir o cache → API → SPA.
 *
 * @throws {AiChatError} 403 quando o grupo não está liberado (mensagem ecoada ao cliente).
 * @throws {Error} quando a verificação não pôde ser feita (vira 500 genérico + log).
 */
export async function assertAiChatAllowed(userId: string): Promise<AiChatGate> {
  const { data, error } = await getSupabaseAdmin()
    .from('user_profile')
    .select('user_group(ai_chat_enabled, ai_chat_limit_per_hour, ai_chat_limit_per_day)')
    .eq('user_id', userId)
    .maybeSingle<LinhaPerfil>();

  if (error) {
    console.error('[ai-chat] gate: verificação de acesso falhou', error.message);
    throw new Error(`gate de acesso indisponível: ${error.message}`);
  }

  // Perfil ausente ⇒ `data` nulo ⇒ negado, pelo mesmo caminho de um grupo desabilitado. É o
  // análogo do sentinela 0 do `getUserGroupId` (lib/auth.ts), com uma diferença que evita
  // divergência: aqui a decisão NUNCA olha o número do grupo, só a flag — então mudar a regra do
  // sentinela lá não altera nada aqui.
  const grupo = primeiro(data?.user_group);

  // 🔴 `=== true`, nunca truthiness: cache de schema velho, coluna removida ou um `"false"` em
  // string precisam negar, sem exceção. Fail-closed por construção, não por um `if` reescrevível.
  if (grupo?.ai_chat_enabled !== true) {
    throw new AiChatError(MENSAGEM_SEM_ACESSO, 403);
  }

  return {
    perHour: cota(grupo.ai_chat_limit_per_hour),
    perDay: cota(grupo.ai_chat_limit_per_day),
  };
}
