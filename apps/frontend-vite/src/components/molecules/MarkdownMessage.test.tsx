import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MarkdownMessage from './MarkdownMessage';

describe('MarkdownMessage', () => {
  it('renderiza parágrafo com negrito e código', () => {
    const { container } = render(<MarkdownMessage text="total **R$ 10,00** em `contas`" />);
    expect(container.querySelector('strong')?.textContent).toBe('R$ 10,00');
    expect(container.querySelector('code')?.textContent).toBe('contas');
  });

  it('renderiza tabela GFM com cabeçalho e células', () => {
    const md = '| Fornecedor | Valor |\n| --- | --- |\n| OBER | R$ 1.000,00 |';
    render(<MarkdownMessage text={md} />);
    expect(screen.getByRole('columnheader', { name: 'Fornecedor' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'OBER' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'R$ 1.000,00' })).toBeInTheDocument();
  });

  // Regra de responsividade do projeto: conteúdo largo rola no PRÓPRIO contêiner, o corpo
  // nunca rola na horizontal.
  it('a tabela fica dentro de um contêiner com rolagem horizontal', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    const { container } = render(<MarkdownMessage text={md} />);
    const table = container.querySelector('table');
    expect(table?.parentElement?.className).toContain('overflow-x-auto');
  });

  it('alinha à direita a célula que é valor/número', () => {
    const md = '| Fornecedor | Valor |\n| --- | --- |\n| OBER | R$ 1.000,00 |';
    render(<MarkdownMessage text={md} />);
    expect(screen.getByRole('cell', { name: 'R$ 1.000,00' }).className).toContain('text-right');
    expect(screen.getByRole('cell', { name: 'OBER' }).className).not.toContain('text-right');
  });

  // O defeito real: a célula ia para a direita e o cabeçalho ficava à esquerda (`table-header`
  // traz `text-left`), então o rótulo não ficava sobre a coluna que ele nomeia.
  it('alinha o CABEÇALHO junto com a coluna numérica', () => {
    const md = '| Situação | Contas | Valor |\n| --- | --- | --- |\n| Vencido | 22 | R$ 218.489,83 |';
    render(<MarkdownMessage text={md} />);
    expect(screen.getByRole('columnheader', { name: 'Contas' }).className).toContain('text-right');
    expect(screen.getByRole('columnheader', { name: 'Valor' }).className).toContain('text-right');
    expect(screen.getByRole('columnheader', { name: 'Situação' }).className).not.toContain('text-right');
  });

  // Coluna mista (número numa linha, texto noutra) fica inteira à esquerda — meia coluna
  // alinhada à direita é pior que nenhuma.
  it('coluna com célula não-numérica NÃO vira coluna numérica', () => {
    const md = '| Item | Valor |\n| --- | --- |\n| a | 10,00 |\n| b | não informado |';
    render(<MarkdownMessage text={md} />);
    expect(screen.getByRole('columnheader', { name: 'Valor' }).className).not.toContain('text-right');
    expect(screen.getByRole('cell', { name: '10,00' }).className).not.toContain('text-right');
  });

  // Vazio e traço são a MESMA coisa — ausência de dado. O chat escreve `—` onde a função de
  // analytics devolve NULL, e uma linha dessas não pode derrubar o alinhamento da coluna.
  it('célula vazia não desalinha a coluna numérica', () => {
    const md = '| Item | Valor |\n| --- | --- |\n| a | 10,00 |\n| b |  |';
    render(<MarkdownMessage text={md} />);
    expect(screen.getByRole('columnheader', { name: 'Valor' }).className).toContain('text-right');
  });

  it('traço de "sem dado" não desalinha a coluna numérica', () => {
    const md = '| Fornecedor | Atraso médio |\n| --- | --- |\n| OBER | 12 |\n| LMED | — |';
    render(<MarkdownMessage text={md} />);
    expect(screen.getByRole('columnheader', { name: 'Atraso médio' }).className).toContain('text-right');
    expect(screen.getByRole('cell', { name: '12' }).className).toContain('text-right');
  });

  // Linha curta: sem completar as colunas, a última célula sobe para a coluna errada.
  it('linha com menos células que o cabeçalho é completada à direita', () => {
    const md = '| A | B | C |\n| --- | --- | --- |\n| x | y |';
    const { container } = render(<MarkdownMessage text={md} />);
    const cells = [...container.querySelectorAll('tbody tr td')];
    expect(cells).toHaveLength(3);
    expect(cells.map((c) => c.textContent)).toEqual(['x', 'y', '']);
  });

  // O parser reconhece `##`, mas quem decide COMO o título aparece é este componente — e um
  // subtítulo que renderizasse igual a um parágrafo passaria despercebido no teste do parser.
  it('renderiza título com destaque visual distinto do parágrafo', () => {
    const { container } = render(<MarkdownMessage text={'## Resumo\n\ntexto normal'} />);
    const [titulo, paragrafo] = [...container.querySelectorAll('p')];
    expect(titulo.textContent).toBe('Resumo');
    expect(titulo.className).toContain('font-semibold');
    expect(paragrafo.className).not.toContain('font-semibold');
  });

  it('renderiza lista com marcador', () => {
    render(<MarkdownMessage text={'- alfa\n- beta'} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  // Degradação: o pior caso é o usuário ver o texto cru — nunca perder o conteúdo.
  // (getByText normaliza espaços, então a asserção é no DOM: o texto tem de estar lá.)
  it('texto sem markdown reconhecível continua visível', () => {
    const { container } = render(<MarkdownMessage text="   " />);
    const p = container.querySelector('p');
    expect(p?.textContent).toBe('   ');
    expect(p?.className).toContain('whitespace-pre-wrap');
  });

  it('não injeta HTML vindo do modelo', () => {
    const { container } = render(<MarkdownMessage text="<img src=x onerror=alert(1)>" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
