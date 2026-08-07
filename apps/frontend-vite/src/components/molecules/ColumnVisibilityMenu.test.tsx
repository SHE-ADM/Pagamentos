import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ColumnVisibilityMenu, { type ColumnMenuItem } from './ColumnVisibilityMenu';

const ITEMS: ColumnMenuItem[] = [
  { id: 'a', label: 'Alpha', visible: true, canHide: true, pin: false },
  { id: 'b', label: 'Beta', visible: false, canHide: true, pin: 'left' },
];

describe('ColumnVisibilityMenu', () => {
  it('abre o popover e alterna a visibilidade de uma coluna', async () => {
    const onToggleVisible = vi.fn();
    render(<ColumnVisibilityMenu items={ITEMS} onToggleVisible={onToggleVisible} onSetPin={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /Colunas/ }));
    expect(screen.getByRole('dialog', { name: 'Gerenciar colunas' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Mostrar coluna Alpha' }));
    expect(onToggleVisible).toHaveBeenCalledWith('a', false);
  });

  it('fixa uma coluna à esquerda', async () => {
    const onSetPin = vi.fn();
    render(<ColumnVisibilityMenu items={ITEMS} onToggleVisible={vi.fn()} onSetPin={onSetPin} />);

    await userEvent.click(screen.getByRole('button', { name: /Colunas/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Fixar Alpha à esquerda' }));
    expect(onSetPin).toHaveBeenCalledWith('a', 'left');
  });

  it('exibe a contagem de colunas ocultas no botão', () => {
    render(<ColumnVisibilityMenu items={ITEMS} onToggleVisible={vi.fn()} onSetPin={vi.fn()} />);
    expect(screen.getByText('1 ocultas')).toBeInTheDocument();
  });

  // O painel passou a ser PORTALIZADO para o body (fugindo do `overflow-x-auto` da barra de
  // filtros de /consulta, que o cortava). Isso tira o painel da subárvore do wrapper, e o
  // clique-fora — que fechava comparando com `ref.current` — passaria a fechar o menu ao
  // primeiro clique DENTRO dele. Dois cliques em sequência é o que expõe isso: o teste de
  // "alterna a visibilidade" acima usa um só e continuaria verde.
  it('permanece aberto ao interagir DENTRO do painel portalizado', async () => {
    const onToggleVisible = vi.fn();
    const onSetPin = vi.fn();
    render(<ColumnVisibilityMenu items={ITEMS} onToggleVisible={onToggleVisible} onSetPin={onSetPin} />);

    await userEvent.click(screen.getByRole('button', { name: /Colunas/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Mostrar coluna Alpha' }));
    // Ainda aberto depois do 1º clique…
    expect(screen.getByRole('dialog', { name: 'Gerenciar colunas' })).toBeInTheDocument();

    // …e o 2º controle continua alcançável, que é a prova de que o menu segue utilizável.
    await userEvent.click(screen.getByRole('button', { name: 'Fixar Alpha à esquerda' }));
    expect(onSetPin).toHaveBeenCalledWith('a', 'left');
    expect(screen.getByRole('dialog', { name: 'Gerenciar colunas' })).toBeInTheDocument();
  });

  // O menu fecha ao rolar (um painel `fixed` descolaria do botão), e o listener usa `capture`
  // para alcançar contêineres internos — que é justamente o que faz a rolagem da PRÓPRIA lista
  // de colunas chegar nele. Com o grid de /consulta em ~14 colunas, rolar até a coluna
  // procurada é o uso normal: sem a guarda, o menu se fechava no meio dessa rolagem.
  it('NÃO fecha ao rolar a lista de colunas dentro do painel', async () => {
    render(<ColumnVisibilityMenu items={ITEMS} onToggleVisible={vi.fn()} onSetPin={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /Colunas/ }));
    const lista = screen.getByRole('list');
    fireEvent.scroll(lista);

    expect(screen.getByRole('dialog', { name: 'Gerenciar colunas' })).toBeInTheDocument();
  });

  // Contraparte: rolagem de FORA do painel continua fechando — é o que evita o painel
  // flutuando descolado do botão que o abriu.
  it('fecha ao rolar fora do painel', async () => {
    render(<ColumnVisibilityMenu items={ITEMS} onToggleVisible={vi.fn()} onSetPin={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /Colunas/ }));
    fireEvent.scroll(document);

    expect(screen.queryByRole('dialog', { name: 'Gerenciar colunas' })).not.toBeInTheDocument();
  });

  it('fecha ao clicar FORA do painel', async () => {
    render(
      <div>
        <button type="button">fora</button>
        <ColumnVisibilityMenu items={ITEMS} onToggleVisible={vi.fn()} onSetPin={vi.fn()} />
      </div>,
    );

    await userEvent.click(screen.getByRole('button', { name: /Colunas/ }));
    expect(screen.getByRole('dialog', { name: 'Gerenciar colunas' })).toBeInTheDocument();

    // Contraparte do caso acima: sem ela, um clique-fora quebrado (que nunca mais fecha o
    // menu) passaria despercebido.
    await userEvent.click(screen.getByRole('button', { name: 'fora' }));
    expect(screen.queryByRole('dialog', { name: 'Gerenciar colunas' })).not.toBeInTheDocument();
  });

  // ── Contenção vertical: o painel é `fixed`, então o que passar do rodapé da janela fica
  // FORA de alcance (rolar a página não move elemento fixo, e a rolagem ainda fecha o menu).
  // O clamp do eixo X existia desde o portal; a falta do vertical era a assimetria.
  // jsdom não faz layout, então o `getBoundingClientRect` é fixado no próprio botão.
  describe('contenção vertical', () => {
    // `window.innerHeight` é GLOBAL do jsdom e sobrevive ao caso: sem restaurar, qualquer
    // teste acrescentado depois herdaria 678px sem saber — a mesma armadilha de estado
    // herdado que já mordeu este projeto (CLAUDE.md §Regra 2, lição do `MainDryRunTest`).
    const alturaOriginal = window.innerHeight;
    afterEach(() => {
      window.innerHeight = alturaOriginal;
    });

    const abrirComBotaoEm = async (rect: Partial<DOMRect>, innerHeight: number) => {
      window.innerHeight = innerHeight;
      render(<ColumnVisibilityMenu items={ITEMS} onToggleVisible={vi.fn()} onSetPin={vi.fn()} />);
      const botao = screen.getByRole('button', { name: /Colunas/ });
      vi.spyOn(botao, 'getBoundingClientRect').mockReturnValue({
        top: 0, bottom: 0, left: 0, right: 300, width: 300, height: 30, x: 0, y: 0,
        toJSON: () => ({}), ...rect,
      });
      await userEvent.click(botao);
      return screen.getByRole('dialog', { name: 'Gerenciar colunas' });
    };

    it('limita a altura ao espaço visível abaixo do botão', async () => {
      // Caso real do achado: viewport de 678px, botão terminando em 350.
      const painel = await abrirComBotaoEm({ top: 320, bottom: 350 }, 678);
      // 678 − 350 − 4 (folga do botão) − 8 (margem do viewport) = 316.
      expect(painel.style.maxHeight).toBe('316px');
      expect(painel.style.top).toBe('354px');
    });

    it('abre ACIMA do botão quando embaixo não cabe e em cima cabe mais', async () => {
      // Botão colado no rodapé: 40px embaixo contra 590 em cima.
      const painel = await abrirComBotaoEm({ top: 630, bottom: 660 }, 700);
      expect(Number.parseInt(painel.style.top, 10)).toBeLessThan(630);
      expect(painel.style.maxHeight).toBe('618px');
    });

    // Sanidade do guarda: sem `flex-col` + `overflow-hidden` no painel e `flex-1` na lista,
    // o `maxHeight` acima recortaria o conteúdo em vez de fazer a lista rolar dentro dele.
    it('a lista rola DENTRO do painel limitado', async () => {
      const painel = await abrirComBotaoEm({ top: 320, bottom: 350 }, 678);
      expect(painel.className).toContain('flex-col');
      expect(painel.className).toContain('overflow-hidden');
      expect(painel.querySelector('ul')?.className).toContain('flex-1');
    });

    // 🔴 A largura do painel e o cálculo que o alinha pela direita do botão são o MESMO
    // número. Enquanto a largura vinha de uma classe (`w-72`) e o alinhamento de uma
    // constante (288), trocar a classe desalinharia o painel em silêncio — nenhum teste
    // olhava os dois juntos. Este caso amarra as duas pontas: a borda direita do painel tem
    // de cair exatamente sobre a borda direita do botão.
    it('a largura do painel é a MESMA que alinha a borda direita com a do botão', async () => {
      const painel = await abrirComBotaoEm({ top: 100, bottom: 130, right: 600 }, 900);

      const largura = Number.parseInt(painel.style.width, 10);
      const esquerda = Number.parseInt(painel.style.left, 10);
      expect(largura).toBeGreaterThan(0); // sanidade: veio do style, não de uma classe
      expect(esquerda + largura).toBe(600); // = r.right do botão
      // E a largura NÃO pode voltar para uma classe: com as duas fontes, elas divergem.
      expect(painel.className).not.toMatch(/\bw-\d/);
    });
  });
});
