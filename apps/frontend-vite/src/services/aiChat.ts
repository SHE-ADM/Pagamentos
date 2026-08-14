// src/services/aiChat.ts — cliente do chat de IA (POST /api/ai-chat na Next API).
//
// Reusa o dataApiCall: base /data-api (proxy do Vite → :3000/api), Bearer token da sessão
// Supabase e desembrulho do envelope { success, data, error } com a mensagem curada do backend.
//
// O backend devolve APENAS texto + metadados das tools (a contagem de linhas, não as linhas) —
// ver app/api/ai-chat/route.ts. A tabela de resultado, quando existe, vem no markdown de `answer`;
// quem a renderiza é o MarkdownMessage.
import {
  AI_CHAT_STREAM_MIME,
  isAiChatStreamEvent,
  type AiChatStreamEvent,
} from '@sheild/shared';
import { dataApiCall, dataApiFetch } from './dataApi';

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

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * STREAMING (SSE) — o mesmo turno, exibido conforme acontece.
 *
 * Medido em 14/08/2026: a latência é ~6,8 s fixos + ~7,7 ms por token gerado. O custo fixo são os
 * dois round-trips ao modelo e NÃO sai trocando de modelo (Opus 5 → Sonnet 5 cortou 9%). O que
 * resta é parar de esperar pelo bloco inteiro.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Progresso do turno, para a conversa se mexer enquanto a resposta é gerada.
 *
 * Consumido por INFERÊNCIA: o widget passa um objeto literal para `askAiChatStream`, sem importar
 * o tipo nominalmente — mesmo padrão de `ApiResponse` e `ReaderSummary`.
 */
// ts-prune-ignore-next
export interface AiChatStreamHandlers {
  /** Texto acumulado da mensagem CORRENTE — já reiniciado a cada `text_start`. */
  onText?: (textoParcial: string) => void;
  /** Uma ferramenta começou a executar. */
  onTool?: (name: string, params: Record<string, unknown>) => void;
  /** A ferramenta terminou; `error` presente quando falhou. */
  onToolEnd?: (name: string, rows: number, error?: string) => void;
}

const INTERROMPIDO =
  'A conexão com o assistente foi interrompida antes da resposta terminar. Tente novamente.';

/**
 * Quebra o corpo em frames SSE e devolve os eventos já validados.
 *
 * Separador por regex `\r?\n\r?\n` em vez de `indexOf('\n\n')`: o SSE admite CRLF, e um
 * intermediário que normalize quebras de linha produziria frames que nunca casariam — o stream
 * pareceria travado, sem erro nenhum. Frame corrompido ou desconhecido é DESCARTADO e a leitura
 * segue: um proxy que injete uma linha não pode derrubar a conversa inteira.
 */
async function* lerEventos(res: Response): AsyncGenerator<AiChatStreamEvent> {
  const body = res.body;
  if (!body) throw new Error(INTERROMPIDO);

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const separador = /\r?\n\r?\n/;
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let corte = separador.exec(buffer);
      while (corte) {
        const frame = buffer.slice(0, corte.index);
        buffer = buffer.slice(corte.index + corte[0].length);
        const evento = parseFrame(frame);
        if (evento) yield evento;
        corte = separador.exec(buffer);
      }
    }
  } finally {
    // Libera a conexão quando saímos cedo (cancelamento, erro no consumidor). Sem isto o socket
    // ficaria preso até o GC — e o servidor só descobriria a desistência muito depois.
    reader.cancel().catch(() => { /* já encerrado pelo outro lado */ });
  }
}

/** Um frame → evento, ou `null` quando é comentário (heartbeat) ou lixo. */
function parseFrame(frame: string): AiChatStreamEvent | null {
  const dados = frame
    .split(/\r?\n/)
    .filter((linha) => linha.startsWith('data:'))
    .map((linha) => linha.slice(5).trimStart())
    .join('\n');
  if (!dados) return null; // linha `:` de heartbeat

  try {
    const bruto: unknown = JSON.parse(dados);
    return isAiChatStreamEvent(bruto) ? bruto : null;
  } catch {
    return null;
  }
}

/**
 * Envia a pergunta pelo caminho de streaming, com FALLBACK automático para a rota JSON.
 *
 * 🔴 A POLÍTICA DE FALLBACK É ESTREITA DE PROPÓSITO. Só cai para o JSON quando o streaming não
 * chegou a acontecer e nada foi cobrado:
 *
 *   · **404** — a rota não existe naquele deploy (janela de implantação, aba aberta há horas);
 *   · **200 sem `text/event-stream`** — alguém no caminho transformou o corpo (proxy, CDN,
 *     extensão de navegador). O turno até rodou, mas a resposta chegou embrulhada de outro jeito.
 *
 * Qualquer outro status é erro HONESTO e sobe como erro. Reenviar um 403, um 429 ou um 500 pela
 * segunda rota faria a MESMA pergunta rodar duas vezes — o usuário pagaria dois turnos e o
 * `ai_chat_log` registraria duas tentativas, sendo que a primeira já havia falhado por um motivo
 * que a segunda vai reencontrar. O usuário tem "Tentar novamente" para isso, e ali a decisão é
 * dele.
 */
export async function askAiChatStream(
  question: string,
  messages: readonly AiChatMessage[],
  handlers: AiChatStreamHandlers = {},
  signal?: AbortSignal,
): Promise<AiChatAnswer> {
  const history = buildHistory(messages);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    const res = await dataApiFetch('/ai-chat/stream', {
      method: 'POST',
      body: JSON.stringify({ question, ...(history.length ? { history } : {}) }),
      signal: combined,
    });

    const tipo = res.headers.get('content-type') ?? '';
    if (!res.ok || !tipo.includes(AI_CHAT_STREAM_MIME)) {
      if (res.status === 404 || res.ok) {
        return await askAiChat(question, messages, signal);
      }
      throw await erroDoEnvelope(res);
    }

    return await consumir(res, handlers);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TimeoutError') {
      throw new Error(TIMEOUT_MESSAGE, { cause: e });
    }
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new AiChatCancelledError();
    }
    throw e;
  }
}

/** Consome os eventos até `done` (ou `error`), alimentando os handlers pelo caminho. */
async function consumir(res: Response, handlers: AiChatStreamHandlers): Promise<AiChatAnswer> {
  let corrente = '';
  let final: AiChatAnswer | null = null;
  let falha: { message: string } | null = null;

  for await (const evento of lerEventos(res)) {
    switch (evento.type) {
      case 'text_start':
        // Nova mensagem do assistente: o preâmbulo ("vou verificar isso") dá lugar à resposta.
        // Sem este reinício, os dois apareceriam grudados e a tela divergiria do `answer` final.
        corrente = '';
        handlers.onText?.('');
        break;
      case 'delta':
        corrente += evento.text;
        handlers.onText?.(corrente);
        break;
      case 'tool':
        handlers.onTool?.(evento.name, evento.params);
        break;
      case 'tool_end':
        handlers.onToolEnd?.(evento.name, evento.rows, evento.error);
        break;
      case 'done':
        final = {
          answer: evento.answer,
          tool_calls: evento.tool_calls ?? [],
          truncated: evento.truncated,
        };
        break;
      case 'error':
        falha = { message: evento.message };
        break;
      default:
        break; // 'open' — só confirma que o transporte é streaming
    }
  }

  // A ordem importa: uma falha declarada pelo servidor explica melhor que "conexão interrompida".
  if (falha) throw new Error(falha.message);
  // Stream que acaba sem `done` nem `error` = conexão cortada no meio. NÃO se promove o texto
  // parcial a resposta: o `answer` do evento `done` é o que vai para o histórico enviado ao modelo
  // na próxima pergunta, e um texto truncado ali envenenaria a conversa seguinte em silêncio.
  if (!final) throw new Error(INTERROMPIDO);
  if (final.answer.trim() === '') throw new Error('A resposta do assistente veio vazia. Tente novamente.');
  return final;
}

/** Erro de uma resposta que não é SSE: usa a mensagem curada do envelope, quando houver. */
async function erroDoEnvelope(res: Response): Promise<Error> {
  const corpo = (await res.json().catch(() => ({}))) as { error?: string };
  if (corpo.error) return new Error(corpo.error);
  return new Error(
    res.status >= 500
      ? `A API de dados está indisponível no momento (erro ${res.status}). Tente novamente em instantes.`
      : `Erro ${res.status} ao acessar a API de dados`,
  );
}
