import { describe, expect, it } from 'vitest';
import { appendUniqueById } from './appendUniqueById';

describe('appendUniqueById', () => {
  it('acrescenta registros novos preservando a ordem', () => {
    expect(appendUniqueById([{ id: 1 }, { id: 2 }], [{ id: 3 }, { id: 4 }]))
      .toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
  });

  // O caso que motivou o helper: uma conta inserida entre as páginas desloca a janela do
  // offset e a página seguinte devolve uma linha JÁ exibida.
  it('descarta registro que já está na lista (a duplicata da tela)', () => {
    expect(appendUniqueById([{ id: 1 }, { id: 708 }], [{ id: 708 }, { id: 707 }]))
      .toEqual([{ id: 1 }, { id: 708 }, { id: 707 }]);
  });

  it('descarta duplicata vinda DENTRO da mesma página', () => {
    expect(appendUniqueById([{ id: 1 }], [{ id: 2 }, { id: 2 }, { id: 3 }]))
      .toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  // As linhas em tela carregam edições otimistas (curadoria NF/Boleto, situação) que
  // podem ser mais novas que a página recém-lida — sobrescrever faria a marcação piscar.
  it('preserva a versão JÁ em tela, não a recém-chegada', () => {
    const atual = [{ id: 1, has_invoice: true }];
    const pagina = [{ id: 1, has_invoice: false }];
    expect(appendUniqueById(atual, pagina)).toEqual([{ id: 1, has_invoice: true }]);
  });

  it('preserva a referência quando nada é acrescentado (evita re-render do grid)', () => {
    const atual = [{ id: 1 }, { id: 2 }];
    expect(appendUniqueById(atual, [])).toBe(atual);
    expect(appendUniqueById(atual, [{ id: 1 }])).toBe(atual);
  });

  it('funciona com a lista vazia (primeira página)', () => {
    expect(appendUniqueById([], [{ id: 5 }])).toEqual([{ id: 5 }]);
  });
});
