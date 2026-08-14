// src/ai-chat-stream.ts
// Protocolo de streaming do chat de IA — contrato ÚNICO entre a Next API e o frontend.
//
// POR QUE VIVE NO `@sheild/shared`, e não dentro de cada app: o nome de cada evento é escrito nas
// DUAS pontas (o servidor emite, o cliente compara). Com duas cópias, trocar `tool_end` por
// `toolEnd` de um lado só produz a pior falha possível deste protocolo: o stream continua válido,
// o HTTP continua 200, e o evento simplesmente **nunca casa** — o chip da ferramenta some da tela
// sem erro, sem log e sem teste vermelho. Com uma união discriminada compartilhada, o mesmo engano
// vira erro de compilação nas duas pontas.
//
// POR QUE FORA DE `schemas/`: aquele diretório é de schemas Zod, e aqui não há validação de
// entrada a fazer — o produtor é o nosso próprio servidor e o consumidor é tipado pelo mesmo
// union. Pôr um arquivo sem Zod lá dentro faria o diretório mentir sobre o que contém.
//
// FORMATO NO FIO: cada evento é um frame SSE com **uma única linha `data:`** contendo o JSON do
// evento, discriminado por `type` — em vez do campo `event:` do SSE. O motivo é prático: o cliente
// não usa `EventSource` (que só faz GET e não aceita `Authorization`), e sim `fetch` + leitura do
// corpo, então o `event:` não traria nenhum despacho de graça e custaria um segundo eixo a manter
// em sincronia com o `type`.

/** Content-Type do corpo da rota de streaming. */
export const AI_CHAT_STREAM_MIME = 'text/event-stream';

/** Uma ferramenta executada, no formato que a conversa exibe. */
export interface AiChatStreamToolCall {
  name: string;
  params: Record<string, unknown>;
  rows: number;
}

/**
 * Os eventos do protocolo, em ordem típica de um turno:
 *
 *   open → [text_start → delta*]? → tool → tool_end → [text_start → delta*] → done
 *
 * `text_start` pode ocorrer MAIS DE UMA VEZ no mesmo turno: o modelo costuma escrever um preâmbulo
 * antes de pedir a ferramenta ("vou verificar isso") e só depois a resposta de fato. Cada
 * `text_start` significa **descarte o texto acumulado e recomece** — é o que mantém o texto em tela
 * idêntico ao `answer` final, que também é apenas o da última mensagem. Sem esse reinício, o
 * preâmbulo apareceria grudado na resposta e a tela divergiria da auditoria.
 */
export type AiChatStreamEvent =
  /** Enviado assim que o stream abre, antes de qualquer trabalho — ver `AI_CHAT_STREAM_MIME`. */
  | { type: 'open' }
  /** Uma ferramenta começou a executar. Vira o chip "consultando…" na tela. */
  | { type: 'tool'; name: string; params: Record<string, unknown> }
  /** A ferramenta terminou. `error` presente = falhou (o loop segue, por contrato). */
  | { type: 'tool_end'; name: string; rows: number; ms: number; error?: string }
  /** Uma nova mensagem do assistente começou a emitir texto: DESCARTE o buffer e recomece. */
  | { type: 'text_start' }
  /** Um pedaço de texto do assistente. */
  | { type: 'delta'; text: string }
  /** Turno concluído. `answer` é a resposta canônica — a mesma que a rota JSON devolveria. */
  | { type: 'done'; answer: string; tool_calls: AiChatStreamToolCall[]; truncated: boolean }
  /**
   * Falha DEPOIS de o stream ter aberto.
   *
   * 🔴 Existe porque, uma vez enviado o `200 OK` com os headers do SSE, o status HTTP não pode mais
   * comunicar erro algum — e o gateway falha justamente no meio do trabalho (429 do provedor, 503,
   * timeout). Sem este evento, uma falha tardia chegaria ao usuário como um stream que simplesmente
   * termina: tela vazia, nenhuma explicação e nada a tentar de novo. `status` carrega o código que
   * a rota JSON teria devolvido, para o cliente decidir entre "tentar novamente" e "pedir acesso".
   */
  | { type: 'error'; message: string; status: number };

/**
 * Valida a forma de um evento vindo do fio.
 *
 * O produtor é o nosso próprio servidor, então isto NÃO é validação de entrada não-confiável — é
 * contenção de corrupção de transporte: um proxy que injete texto, um frame partido por
 * reconexão, ou uma versão do servidor mais nova que a do cliente (deploy em andamento, aba
 * aberta há horas). Em qualquer desses casos o cliente precisa DESCARTAR o frame e seguir lendo,
 * nunca derrubar a conversa inteira por um `JSON.parse` que veio torto.
 */
export function isAiChatStreamEvent(value: unknown): value is AiChatStreamEvent {
  if (typeof value !== 'object' || value === null) return false;
  const type: unknown = (value as { type?: unknown }).type;
  if (typeof type !== 'string') return false;

  const v = value as Record<string, unknown>;
  switch (type) {
    case 'open':
    case 'text_start':
      return true;
    case 'tool':
      return typeof v.name === 'string';
    case 'tool_end':
      return typeof v.name === 'string' && typeof v.rows === 'number';
    case 'delta':
      return typeof v.text === 'string';
    case 'done':
      return typeof v.answer === 'string';
    case 'error':
      return typeof v.message === 'string';
    default:
      // Evento desconhecido: provavelmente um servidor mais novo que este cliente. Descartar é o
      // comportamento correto — e é por isso que a função devolve `false` em vez de lançar.
      return false;
  }
}
