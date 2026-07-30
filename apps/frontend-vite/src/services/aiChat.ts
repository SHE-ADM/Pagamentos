// src/services/aiChat.ts — cliente do chat de IA (POST /api/ai-chat na Next API).
//
// Reusa o dataApiCall: base /data-api (proxy do Vite → :3000/api), Bearer token da sessão
// Supabase e desembrulho do envelope { success, data, error } com a mensagem curada do backend.
//
// O backend devolve APENAS texto + metadados das tools (a contagem de linhas, não as linhas) —
// ver app/api/ai-chat/route.ts. A tabela de resultado, quando existe, vem no markdown de `answer`;
// quem a renderiza é o MarkdownMessage.
import { dataApiCall } from './dataApi';

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Transparência: qual ferramenta o modelo usou e quantas linhas ela devolveu.
 *
 * Sem `export`: o painel chega a ele por `ChatEntry['toolCalls']`, e nenhum outro módulo o importa
 * — exportar deixaria um export órfão (`ts-prune`).
 */
interface AiChatToolCall {
  name: string;
  params: Record<string, unknown>;
  rows: number;
}

/**
 * Uma mensagem da conversa em tela: a mensagem do protocolo mais o que só existe na resposta.
 *
 * Mora AQUI, e não no componente, porque é o modelo do domínio (o que a conversa É), consumido
 * pelo widget (estado) e pelo painel (render). Ter o tipo no componente lazy obrigava o widget a
 * importar tipo de um módulo que ele carrega sob demanda — e, por ser supertipo de `AiChatMessage`,
 * pode ir direto a `buildHistory` sem uma passada de `map`.
 */
export interface ChatEntry extends AiChatMessage {
  toolCalls?: AiChatToolCall[];
  truncated?: boolean;
}

// Sem `export`: ninguém importa este tipo — o widget o consome por inferência do retorno de
// askAiChat. Exportá-lo deixaria um export órfão (ts-prune).
interface AiChatAnswer {
  answer: string;
  tool_calls: AiChatToolCall[];
  /** true quando a resposta pode estar incompleta (teto de iterações ou corte por max_tokens). */
  truncated: boolean;
}

/**
 * Teto de mensagens enviadas como histórico (4 pares).
 *
 * O Zod da rota aceita até 20, mas cada iteração do loop de tool use reenvia TODO o histórico ao
 * modelo — histórico longo é custo por pergunta, não memória de graça.
 */
const MAX_HISTORY_MESSAGES = 8;

/**
 * Timeout do cliente. A rota tem `maxDuration = 300`, então este teto é menor de propósito: quem
 * desiste primeiro é o navegador, com mensagem nossa, em vez de o usuário olhar um spinner eterno.
 */
const REQUEST_TIMEOUT_MS = 180_000;

const TIMEOUT_MESSAGE =
  'A consulta demorou demais e foi interrompida. Tente uma pergunta mais específica '
  + '(um período menor, uma empresa só).';

/**
 * O usuário cancelou (botão "Parar").
 *
 * Classe própria porque cancelamento **não é falha**: quem chama precisa distinguir para não pintar
 * de vermelho uma ação deliberada do usuário. Tratar tudo como erro é o caminho fácil que produz
 * "Erro: consulta cancelada" — mensagem que culpa o usuário pelo que ele mesmo pediu.
 */
export class AiChatCancelledError extends Error {
  constructor() {
    super('Consulta cancelada.');
    this.name = 'AiChatCancelledError';
  }
}

/**
 * Recorta o histórico no formato que a rota exige (não regredir — é validação, não estética).
 *
 * O `bodySchema` da rota REJEITA com 422 histórico de tamanho ímpar ou fora da alternância
 * user→assistant: a Claude API exige alternância, e um histórico terminando em `user` colaria dois
 * `user` seguidos com a pergunta nova (400 do provedor, que o contrato de erro converte em 500
 * opaco). Por isso aqui só entram PARES COMPLETOS, contados do fim para o começo.
 *
 * A conversa em tela pode legitimamente terminar em `user` — é o estado enquanto a resposta não
 * voltou, ou depois de uma falha (a mensagem de erro não vira `assistant`). Nesses casos a última
 * pergunta sem par é descartada do histórico.
 *
 * Aceita `ChatEntry` (supertipo) e devolve mensagens **normalizadas**: só `role` e `content`. Isso
 * não é estética — sem a normalização, `toolCalls`/`truncated` das entradas do assistente viajariam
 * dentro de cada item de `history` no corpo do POST. O Zod da rota os descartaria, mas o payload
 * enviado ao servidor deve conter exatamente o que o contrato declara.
 */
export function buildHistory(messages: readonly AiChatMessage[]): AiChatMessage[] {
  const pairs: AiChatMessage[] = [];

  // Varre do fim para o começo juntando (user, assistant) adjacentes: preserva as trocas MAIS
  // RECENTES, que são as que dão contexto ao "e os 5 maiores?" da pergunta seguinte.
  // `while` e não `for`: o passo é 2 quando um par casa e 1 quando não casa — mexer no contador
  // dentro do corpo de um `for` é o smell S2310 do Sonar.
  let i = messages.length - 1;
  while (i >= 1 && pairs.length < MAX_HISTORY_MESSAGES) {
    const assistant = messages[i];
    const user = messages[i - 1];
    if (assistant.role === 'assistant' && user.role === 'user') {
      pairs.unshift(
        { role: user.role, content: user.content },
        { role: assistant.role, content: assistant.content },
      );
      i -= 2;
    } else {
      i -= 1;
    }
  }

  return pairs;
}

/**
 * Envia a pergunta. Lança `Error` com mensagem em pt-BR (curada pelo backend ou pelo timeout), ou
 * `AiChatCancelledError` quando o `signal` recebido aborta.
 *
 * @param signal Cancelamento pelo usuário. Vai ao servidor pelo próprio corte da conexão: a rota
 *   repassa o `request.signal` ao gateway, que para o loop — é o que evita continuar pagando por
 *   uma resposta que ninguém vai ler.
 */
export async function askAiChat(
  question: string,
  messages: readonly AiChatMessage[] = [],
  signal?: AbortSignal,
): Promise<AiChatAnswer> {
  const history = buildHistory(messages);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  // `AbortSignal.any` em vez de encadear listeners à mão: preserva o `reason` do signal que abortou
  // primeiro, e é justamente o `reason` que distingue "o usuário desistiu" (AbortError) de "estourou
  // o teto" (TimeoutError) no catch abaixo.
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    const body = await dataApiCall<AiChatAnswer>('/ai-chat', {
      method: 'POST',
      body: JSON.stringify({ question, ...(history.length ? { history } : {}) }),
      signal: combined,
    });
    // `dataApiCall` só desembrulha o envelope — não valida o formato de `data` (o frontend deste
    // projeto não roda Zod em resposta de serviço). Uma resposta sem texto utilizável renderizaria
    // um BALÃO EM BRANCO na conversa, que o usuário leria como "o assistente não respondeu" sem
    // nada explicando: melhor falhar com mensagem do que exibir vazio. O gateway já garante um
    // texto de fallback, então cair aqui significa contrato quebrado, não resposta legítima.
    const data = body.data;
    if (typeof data?.answer !== 'string' || data.answer.trim() === '') {
      throw new Error('A resposta do assistente veio vazia. Tente novamente.');
    }
    return { answer: data.answer, tool_calls: data.tool_calls ?? [], truncated: data.truncated ?? false };
  } catch (e) {
    // Os dois abortos chegam como DOMException e precisam de destinos DIFERENTES — tratá-los juntos
    // (como antes) fazia o cancelamento do usuário aparecer como "a consulta demorou demais".
    if (e instanceof DOMException && e.name === 'TimeoutError') {
      // `cause` preserva o erro original para o console/telemetria, sem levá-lo à tela.
      throw new Error(TIMEOUT_MESSAGE, { cause: e });
    }
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new AiChatCancelledError();
    }
    throw e;
  }
}
