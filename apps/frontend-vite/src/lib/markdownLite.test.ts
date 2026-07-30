import { describe, it, expect } from 'vitest';
import { parseMarkdownLite, parseInline } from './markdownLite';

describe('parseInline', () => {
  it('separa negrito, código e texto preservando a ordem', () => {
    expect(parseInline('total **R$ 1.234,56** na tabela `contas`')).toEqual([
      { type: 'text', text: 'total ' },
      { type: 'strong', text: 'R$ 1.234,56' },
      { type: 'text', text: ' na tabela ' },
      { type: 'code', text: 'contas' },
    ]);
  });

  it('texto sem marcação vira um único token', () => {
    expect(parseInline('nada marcado aqui')).toEqual([{ type: 'text', text: 'nada marcado aqui' }]);
  });

  it('asterisco solto não é negrito (fica como texto)', () => {
    expect(parseInline('2 * 3 = 6')).toEqual([{ type: 'text', text: '2 * 3 = 6' }]);
  });
});

describe('parseMarkdownLite', () => {
  it('texto vazio devolve nenhum bloco', () => {
    expect(parseMarkdownLite('')).toEqual([]);
    expect(parseMarkdownLite('   \n  ')).toEqual([]);
  });

  it('parágrafo preserva as quebras simples como linhas', () => {
    const [block] = parseMarkdownLite('primeira linha\nsegunda linha');
    expect(block).toEqual({
      type: 'paragraph',
      lines: [[{ type: 'text', text: 'primeira linha' }], [{ type: 'text', text: 'segunda linha' }]],
    });
  });

  it('linha em branco separa parágrafos', () => {
    const blocks = parseMarkdownLite('um\n\ndois');
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.type === 'paragraph')).toBe(true);
  });

  it('reconhece lista com marcador e lista numerada', () => {
    const [bullet] = parseMarkdownLite('- alfa\n- beta');
    expect(bullet).toEqual({
      type: 'list',
      ordered: false,
      items: [[{ type: 'text', text: 'alfa' }], [{ type: 'text', text: 'beta' }]],
    });

    const [ordered] = parseMarkdownLite('1. alfa\n2. beta');
    expect(ordered.type === 'list' && ordered.ordered).toBe(true);
  });

  it('reconhece título e remove os hashes de fechamento', () => {
    expect(parseMarkdownLite('## Resumo ##')).toEqual([
      { type: 'heading', content: [{ type: 'text', text: 'Resumo' }] },
    ]);
  });

  it('reconhece tabela GFM com cabeçalho e linhas', () => {
    const md = [
      '| Fornecedor | Valor |',
      '| --- | ---: |',
      '| OBER | R$ 1.000,00 |',
      '| CIPATEX | R$ 2.500,00 |',
    ].join('\n');

    const [block] = parseMarkdownLite(md);
    expect(block.type).toBe('table');
    if (block.type !== 'table') return;
    expect(block.header.map((c) => c[0].text)).toEqual(['Fornecedor', 'Valor']);
    expect(block.rows).toHaveLength(2);
    expect(block.rows[1].map((c) => c[0].text)).toEqual(['CIPATEX', 'R$ 2.500,00']);
  });

  // O separador GFM é o que CONFIRMA a tabela: sem ele, uma frase que comece com "|" viraria
  // uma tabela de uma coluna — degradar para texto é o comportamento correto.
  it('linha com pipe SEM separador não vira tabela', () => {
    const blocks = parseMarkdownLite('| isto não é tabela');
    expect(blocks[0].type).toBe('paragraph');
  });

  it('combina blocos na ordem em que aparecem', () => {
    const md = 'Situação atual:\n\n- vencidas: 3\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nFim.';
    expect(parseMarkdownLite(md).map((b) => b.type)).toEqual([
      'paragraph',
      'list',
      'table',
      'paragraph',
    ]);
  });

  it('aceita CRLF (resposta com quebra do Windows)', () => {
    const blocks = parseMarkdownLite('- alfa\r\n- beta\r\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type === 'list' && blocks[0].items).toHaveLength(2);
  });
});
