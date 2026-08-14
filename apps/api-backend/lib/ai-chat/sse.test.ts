import { describe, it, expect, vi } from 'vitest';
import { toSseFrame, SseWriter, SSE_HEADERS } from './sse';

/** Controller falso: registra o que foi escrito e permite simular um cliente que sumiu. */
function fakeController() {
  const escrito: string[] = [];
  const decoder = new TextDecoder();
  let quebrado = false;
  let fechado = 0;

  const controller = {
    enqueue(chunk: Uint8Array) {
      if (quebrado) throw new TypeError('Invalid state: Controller is already closed');
      escrito.push(decoder.decode(chunk));
    },
    close() {
      if (quebrado) throw new TypeError('Invalid state: Controller is already closed');
      fechado += 1;
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;

  return {
    controller,
    escrito,
    quebrar: () => { quebrado = true; },
    get fechado() { return fechado; },
  };
}

describe('toSseFrame', () => {
  it('serializa como um frame SSE de uma linha `data:`', () => {
    expect(toSseFrame({ type: 'open' })).toBe('data: {"type":"open"}\n\n');
  });

  /**
   * 🔴 O caso que quebraria o protocolo inteiro. Toda resposta em markdown tem quebras de linha, e
   * um `\n` literal no meio do frame o encerraria ali: o cliente leria metade do JSON, descartaria
   * o frame e o texto sumiria — sem erro, sem log, com o stream continuando normalmente.
   */
  it('texto com quebras de linha NÃO parte o frame', () => {
    const frame = toSseFrame({ type: 'delta', text: 'linha 1\nlinha 2\n\nparágrafo' });

    // Exatamente uma ocorrência do separador, e no fim.
    expect(frame.split('\n\n')).toHaveLength(2);
    expect(frame.endsWith('\n\n')).toBe(true);
    // E o conteúdo sobrevive à ida e volta.
    const dados = JSON.parse(frame.slice('data: '.length)) as { text: string };
    expect(dados.text).toBe('linha 1\nlinha 2\n\nparágrafo');
  });

  it('preserva acentuação e markdown de tabela', () => {
    const texto = '| Fornecedor | Valor |\n|---|---|\n| ÓTICA AÇÃO | R$ 1,00 |';
    const dados = JSON.parse(
      toSseFrame({ type: 'delta', text: texto }).slice('data: '.length),
    ) as { text: string };
    expect(dados.text).toBe(texto);
  });
});

describe('SSE_HEADERS', () => {
  /**
   * `no-transform` e `X-Accel-Buffering` não são decoração: um proxy que bufferize a resposta anula
   * o streaming por completo, e o sintoma ("funciona em dev, não funciona em produção") é caro de
   * diagnosticar justamente porque o código está certo dos dois lados.
   */
  it('desliga cache e buffering intermediário', () => {
    expect(SSE_HEADERS['Content-Type']).toContain('text/event-stream');
    expect(SSE_HEADERS['Cache-Control']).toContain('no-transform');
    expect(SSE_HEADERS['X-Accel-Buffering']).toBe('no');
  });
});

describe('SseWriter', () => {
  it('escreve eventos e comentários', () => {
    const c = fakeController();
    const w = new SseWriter(c.controller);

    w.send({ type: 'open' });
    w.comment('keep-alive');

    expect(c.escrito).toEqual(['data: {"type":"open"}\n\n', ': keep-alive\n\n']);
  });

  /**
   * 🔴 O invariante central do módulo. `controller.enqueue` LANÇA quando o cliente já fechou a
   * conexão — o que acontece toda vez que alguém clica em "Parar" ou fecha a aba. Se essa exceção
   * subisse, ela abortaria o turno de dentro de um callback de progresso, num ponto arbitrário do
   * loop, e pularia a auditoria: perderíamos o registro do que já foi gasto.
   */
  it('NÃO lança quando o cliente desconecta no meio do turno', () => {
    const c = fakeController();
    const w = new SseWriter(c.controller);

    w.send({ type: 'delta', text: 'antes' });
    c.quebrar();

    expect(() => w.send({ type: 'delta', text: 'depois' })).not.toThrow();
    expect(() => w.comment('keep-alive')).not.toThrow();
    expect(() => w.close()).not.toThrow();
  });

  /**
   * Depois da primeira falha o escritor vira no-op. Sem isso, um turno com cliente desconectado
   * tentaria escrever a cada delta de texto — dezenas de exceções capturadas por turno, cada uma
   * custando um stack trace, e nenhuma delas informando nada de novo.
   */
  it('para de tentar escrever depois da primeira falha', () => {
    const c = fakeController();
    const w = new SseWriter(c.controller);
    const enqueue = vi.spyOn(c.controller, 'enqueue');

    c.quebrar();
    w.send({ type: 'delta', text: 'a' });
    w.send({ type: 'delta', text: 'b' });
    w.send({ type: 'delta', text: 'c' });

    expect(enqueue).toHaveBeenCalledTimes(1); // só a primeira tentativa
    expect(w.aceitando).toBe(false);
  });

  it('close é idempotente e fecha uma vez só', () => {
    const c = fakeController();
    const w = new SseWriter(c.controller);

    w.close();
    w.close();

    expect(c.fechado).toBe(1);
  });

  it('depois de fechado não escreve mais', () => {
    const c = fakeController();
    const w = new SseWriter(c.controller);

    w.close();
    w.send({ type: 'done', answer: 'x', tool_calls: [], truncated: false });

    expect(c.escrito).toEqual([]);
  });
});
