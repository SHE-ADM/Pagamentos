// lib/ai-chat/sse.ts
// Transporte Server-Sent Events do chat de IA: serialização dos frames e escrita resiliente.
//
// O protocolo em si (nomes e formato dos eventos) vive no `@sheild/shared`, porque é compartilhado
// com o frontend. Aqui fica só o lado servidor: como pôr aquilo no fio sem que uma desconexão
// derrube o turno.

import type { AiChatStreamEvent } from '@sheild/shared';

/**
 * Headers da resposta de streaming.
 *
 * `no-transform` e `X-Accel-Buffering: no` não são decoração: proxies e CDNs bufferizam respostas
 * por padrão, e um buffer intermediário anula o streaming por completo — a resposta chega inteira
 * no fim, exatamente como a rota JSON, só que sem o status de erro. O sintoma seria "o streaming
 * não funciona em produção e funciona em dev", que é caro de diagnosticar porque o código está
 * certo dos dois lados.
 */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-store, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/**
 * Serializa um evento como frame SSE.
 *
 * Uma única linha `data:` com o JSON — seguro porque `JSON.stringify` escapa quebras de linha
 * (`\n` vira `\\n`), então o corpo nunca contém o `\n\n` que encerraria o frame no meio. Um texto
 * com quebras de linha vindo do modelo é o caso comum, não a exceção: toda resposta em markdown
 * tem várias.
 */
export function toSseFrame(event: AiChatStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Escreve eventos no corpo da resposta, tolerando a desconexão do cliente.
 *
 * 🔴 TODO MÉTODO É À PROVA DE FALHA, e isso é o ponto do módulo. `controller.enqueue()` **lança**
 * quando o stream já foi fechado ou cancelado — e o cliente sumir no meio do turno não é uma
 * anomalia, é o caminho normal de "Parar", de fechar a aba e de perder a rede. Se essa exceção
 * subisse, ela abortaria o turno de dentro de um callback de progresso, num ponto arbitrário do
 * loop, e pularia a auditoria: perderíamos justamente o registro do que já foi gasto.
 *
 * Depois da primeira falha o escritor se marca como fechado e vira no-op — sem isso, um turno com
 * cliente desconectado despejaria uma exceção por delta de texto no log da função.
 */
export class SseWriter {
  private readonly encoder = new TextEncoder();

  private aberto = true;

  constructor(private readonly controller: ReadableStreamDefaultController<Uint8Array>) {}

  /** true enquanto vale a pena continuar escrevendo. */
  get aceitando(): boolean {
    return this.aberto;
  }

  /** Envia um evento. Nunca lança. */
  send(event: AiChatStreamEvent): void {
    this.write(toSseFrame(event));
  }

  /**
   * Comentário SSE (linha iniciada por `:`), ignorado pelo cliente.
   *
   * Serve de heartbeat: o primeiro evento útil só sai depois da primeira resposta do modelo, e
   * alguns intermediários encerram conexões ociosas antes disso.
   */
  comment(texto: string): void {
    this.write(`: ${texto}\n\n`);
  }

  /** Fecha o corpo. Nunca lança, e é idempotente. */
  close(): void {
    if (!this.aberto) return;
    this.aberto = false;
    try {
      this.controller.close();
    } catch {
      // Já fechado pelo outro lado — nada a fazer, e nada a registrar: é o desfecho esperado de
      // um cliente que desligou primeiro.
    }
  }

  private write(texto: string): void {
    if (!this.aberto) return;
    try {
      this.controller.enqueue(this.encoder.encode(texto));
    } catch {
      // O cliente foi embora. Marca e silencia: quem decide encerrar o trabalho é o `signal` no
      // gateway, não este escritor.
      this.aberto = false;
    }
  }
}
