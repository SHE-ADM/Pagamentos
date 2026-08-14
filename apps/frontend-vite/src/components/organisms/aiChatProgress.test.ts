import { describe, it, expect } from 'vitest';
import { rotuloDoProgresso, type StreamingState } from './aiChatProgress';

const estado = (p: Partial<StreamingState> = {}): StreamingState => ({
  text: '',
  tools: [],
  ...p,
});

describe('rotuloDoProgresso', () => {
  /**
   * Este rótulo é o ÚNICO progresso que chega a quem usa leitor de tela: os chips e o texto parcial
   * ficam `aria-hidden` porque mudam dezenas de vezes por turno dentro de um `role="log"` e seriam
   * reanunciados a cada token.
   */
  it('sem turno em andamento, diz que está consultando', () => {
    expect(rotuloDoProgresso(null)).toBe('Consultando os dados…');
  });

  it('com ferramenta em execução e nenhum texto, segue "consultando"', () => {
    expect(rotuloDoProgresso(estado({ tools: [{ name: 'resumo_situacao' }] })))
      .toBe('Consultando os dados…');
  });

  /** O único estado que muda de verdade para quem espera: a resposta COMEÇOU a chegar. */
  it('assim que o texto começa a chegar, muda para "escrevendo"', () => {
    expect(rotuloDoProgresso(estado({ text: 'Você tem ' }))).toBe('Escrevendo a resposta…');
  });

  /**
   * O `text_start` zera o buffer antes da mensagem seguinte. Nesse instante ainda não há texto, e o
   * rótulo tem de voltar a "consultando" — dizer "escrevendo" com a tela vazia seria descrever um
   * estado que não existe.
   */
  it('texto vazio depois de um reinício volta a "consultando"', () => {
    expect(rotuloDoProgresso(estado({ text: '', tools: [{ name: 'x', rows: 3 }] })))
      .toBe('Consultando os dados…');
  });
});
