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
