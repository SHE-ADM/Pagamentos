import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GridToolbar from './GridToolbar';
import type { ColumnMenuItem } from './ColumnVisibilityMenu';

const COLUMN_ITEMS: ColumnMenuItem[] = [
  { id: 'a', label: 'Alpha', visible: true, canHide: true, pin: false },
];

const baseProps = {
  columnItems: COLUMN_ITEMS,
  onToggleVisible: vi.fn(),
  onSetPin: vi.fn(),
  onResetLayout: vi.fn(),
  density: 'comfortable' as const,
  onDensityChange: vi.fn(),
};

describe('GridToolbar', () => {
  it('alterna a densidade para compacto', async () => {
    const onDensityChange = vi.fn();
    render(<GridToolbar {...baseProps} onDensityChange={onDensityChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Compacto' }));
    expect(onDensityChange).toHaveBeenCalledWith('compact');
  });

  it('restaura o layout', async () => {
    const onResetLayout = vi.fn();
    render(<GridToolbar {...baseProps} onResetLayout={onResetLayout} />);
    await userEvent.click(screen.getByRole('button', { name: /Restaurar/ }));
    expect(onResetLayout).toHaveBeenCalled();
  });

  it('mostra a barra de seleção e exporta as selecionadas', async () => {
    const onExportSelected = vi.fn();
    render(
      <GridToolbar
        {...baseProps}
        selectedCount={3}
        onExportSelected={onExportSelected}
        onClearSelection={vi.fn()}
      />,
    );
    expect(screen.getByText('3 selecionadas')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Exportar selecionadas/ }));
    expect(onExportSelected).toHaveBeenCalled();
  });

  it('esconde a barra de seleção quando nada está selecionado', () => {
    render(<GridToolbar {...baseProps} selectedCount={0} onExportSelected={vi.fn()} />);
    expect(screen.queryByText(/selecionada/)).not.toBeInTheDocument();
  });

  // ── Modo portal (só /consulta): controles no slot da página, faixa de seleção aqui ──────
  describe('com controlsPortalTarget', () => {
    const montarSlot = () => {
      const slot = document.createElement('div');
      slot.id = 'slot';
      document.body.appendChild(slot);
      return slot;
    };

    it('renderiza os controles no slot, não no lugar de origem', () => {
      const slot = montarSlot();
      const { container } = render(<GridToolbar {...baseProps} controlsPortalTarget={slot} />);

      expect(slot.querySelector('[aria-label="Densidade das linhas"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="Densidade das linhas"]')).toBeNull();
    });

    // `null` = slot pedido mas ainda não montado (o callback ref só resolve depois do 1º
    // render da página). Renderizar inline nesse quadro faria os botões aparecerem acima do
    // grid e saltarem para o slot no render seguinte.
    it('com target null não renderiza os controles em lugar nenhum', () => {
      const { container } = render(<GridToolbar {...baseProps} controlsPortalTarget={null} />);
      expect(container.querySelector('[aria-label="Densidade das linhas"]')).toBeNull();
      expect(document.body.querySelector('[aria-label="Densidade das linhas"]')).toBeNull();
    });

    // 🔴 Enquanto a barra de seleção mora aqui, a faixa tem a altura RESERVADA mesmo vazia.
    // Sem isso, marcar a primeira linha empurra o grid inteiro para baixo — e quem seleciona
    // várias contas em sequência clica com o conteúdo se movendo sob o ponteiro. jsdom não faz
    // layout, então o guarda observa o que DECIDE a altura: a faixa existe e carrega o `min-h`.
    it('reserva a altura da faixa de seleção mesmo sem seleção (não empurra o grid)', () => {
      const slot = montarSlot();
      const { container } = render(
        <GridToolbar {...baseProps} controlsPortalTarget={slot} selectedCount={0} onExportSelected={vi.fn()} />,
      );

      const faixa = container.querySelector('.min-h-12');
      expect(faixa).not.toBeNull();
      // Sanidade: a faixa está VAZIA neste estado — se algo fosse renderizado aqui, o caso
      // deixaria de medir "altura reservada sem conteúdo".
      expect(faixa?.textContent).toBe('');
    });

    it('a mesma faixa acomoda a barra quando há seleção', () => {
      const slot = montarSlot();
      const { container } = render(
        <GridToolbar {...baseProps} controlsPortalTarget={slot} selectedCount={2} onExportSelected={vi.fn()} />,
      );

      const faixa = container.querySelector('.min-h-12');
      expect(faixa?.textContent).toContain('2 selecionadas');
    });
  });

  // ── Barra de seleção por portal (o que /consulta usa hoje) ─────────────────────────────
  //
  // O ganho de espaço INTEIRO depende de a faixa reservada deixar de ser emitida. Se ela
  // sobrevivesse, a barra renderizaria no destino E os 48px continuariam acima do grid —
  // pior que o estado anterior, e sem nenhum sintoma visível além do espaço em branco.
  describe('com selectionPortalTarget', () => {
    const montarSlot = () => {
      const slot = document.createElement('div');
      document.body.appendChild(slot);
      return slot;
    };

    it('renderiza a barra no slot e NÃO deixa faixa reservada acima do grid', async () => {
      const slot = montarSlot();
      const { container } = render(
        <GridToolbar
          {...baseProps}
          controlsPortalTarget={montarSlot()}
          selectionPortalTarget={slot}
          selectedCount={2}
          onExportSelected={vi.fn()}
        />,
      );

      expect(slot.textContent).toContain('2 selecionadas');
      expect(container.querySelector('.min-h-12')).toBeNull();
      // Sanidade do guarda: a barra existe de fato neste estado, então a ausência do `min-h`
      // acima mede "a faixa sumiu", não "não há barra nenhuma para reservar".
      await userEvent.click(screen.getByRole('button', { name: /Exportar selecionadas/ }));
    });

    it('sem seleção não reserva nem renderiza nada', () => {
      const slot = montarSlot();
      const { container } = render(
        <GridToolbar
          {...baseProps}
          controlsPortalTarget={montarSlot()}
          selectionPortalTarget={slot}
          selectedCount={0}
          onExportSelected={vi.fn()}
        />,
      );

      expect(container.querySelector('.min-h-12')).toBeNull();
      expect(slot.textContent).toBe('');
    });

    // A barra cabe na linha do cabeçalho (38px) por causa do padding vertical reduzido. Com
    // o `py-1.5` do modo inline ela mediria 46px e o cabeçalho cresceria 8px ao marcar a
    // primeira conta — o salto que mover a barra para lá existe para eliminar.
    it('usa o padding compacto que a faz caber na linha do cabeçalho', () => {
      const slot = montarSlot();
      render(
        <GridToolbar
          {...baseProps}
          selectionPortalTarget={slot}
          selectedCount={1}
          onExportSelected={vi.fn()}
        />,
      );

      const barra = slot.firstElementChild;
      expect(barra?.className).toContain('py-0.5');
      expect(barra?.className).not.toContain('py-1.5');
    });

    it('com target null não renderiza a barra em lugar nenhum', () => {
      const { container } = render(
        <GridToolbar
          {...baseProps}
          selectionPortalTarget={null}
          selectedCount={2}
          onExportSelected={vi.fn()}
        />,
      );

      expect(container.textContent).not.toContain('2 selecionadas');
      expect(document.body.textContent).not.toContain('2 selecionadas');
    });
  });
});
