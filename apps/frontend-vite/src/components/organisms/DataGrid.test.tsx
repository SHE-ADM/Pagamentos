import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DataGrid from './DataGrid';
import type { ColumnDef } from '../../hooks/useGridColumns';

interface Row {
  id: number;
  name: string;
  tipo: string;
}

const COLUMNS: ColumnDef<Row>[] = [
  { key: 'name', header: 'Nome', sortKey: 'name', render: (r) => r.name },
  {
    key: 'tipo',
    header: 'Tipo',
    hideOn: ['sm', 'md'],
    secondLine: true,
    secondLineLabel: 'Tipo',
    render: (r) => r.tipo,
  },
];

const ROWS: Row[] = [
  { id: 1, name: 'Alpha', tipo: 'boleto' },
  { id: 2, name: 'Beta', tipo: 'pix' },
];

const baseProps = {
  columns: COLUMNS,
  rows: ROWS,
  rowKey: (r: Row) => String(r.id),
  onRowClick: vi.fn(),
  sortCol: null,
  sortDir: null,
  onSort: vi.fn(),
};

// Força um breakpoint definindo a largura do container observado pelo
// ResizeObserver stub (tests/setup.ts). <640 = 'sm'. Restaurado no afterEach.
const setContainerWidth = (px: number): void => {
  (globalThis as { __roWidth?: number }).__roWidth = px;
};

// Liga a virtualização nos testes: o DataGrid só virtualiza com altura de viewport
// medida (> 0). O stub de ResizeObserver lê __roHeight.
const setContainerHeight = (px: number): void => {
  (globalThis as { __roHeight?: number }).__roHeight = px;
};

afterEach(() => {
  delete (globalThis as { __roWidth?: number }).__roWidth;
  delete (globalThis as { __roHeight?: number }).__roHeight;
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('DataGrid', () => {
  it('renderiza cabeçalhos e linhas', () => {
    render(<DataGrid {...baseProps} />);
    expect(screen.getByRole('columnheader', { name: /Nome/ })).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('aciona onSort com o sortKey ao clicar em cabeçalho ordenável', async () => {
    const onSort = vi.fn();
    render(<DataGrid {...baseProps} onSort={onSort} />);
    await userEvent.click(screen.getByText('Nome'));
    expect(onSort).toHaveBeenCalledWith('name');
  });

  it('aciona onRowClick com a linha ao clicar nela', async () => {
    const onRowClick = vi.fn();
    render(<DataGrid {...baseProps} onRowClick={onRowClick} />);
    await userEvent.click(screen.getByText('Alpha'));
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });

  it('renderiza o painel de detalhe apenas da linha selecionada', () => {
    render(
      <DataGrid
        {...baseProps}
        selectedId="1"
        renderDetail={(r) => <div>Detalhe de {r.name}</div>}
      />,
    );
    expect(screen.getByText('Detalhe de Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Detalhe de Beta')).not.toBeInTheDocument();
  });

  it('renderiza o rodapé (renderRowFooter) só nas linhas com conteúdo, sem clique', () => {
    render(
      <DataGrid
        {...baseProps}
        renderRowFooter={(r) => (r.id === 1 ? <span>Obs de {r.name}</span> : null)}
      />,
    );
    // Rodapé sempre-visível: aparece na linha 1 sem nenhuma interação...
    expect(screen.getByText('Obs de Alpha')).toBeInTheDocument();
    // ...e não aparece na linha 2 (renderRowFooter retornou null).
    expect(screen.queryByText('Obs de Beta')).not.toBeInTheDocument();
  });

  it('aplica rowClassName na linha (tr e células) conforme a linha', () => {
    render(
      <DataGrid
        {...baseProps}
        rowClassName={(r) => (r.id === 1 ? 'bg-status-error-solid/15' : undefined)}
      />,
    );
    // A <tr> da linha 1 recebe o tom; a célula também (vence o fundo de fixadas).
    const tr = screen.getByText('Alpha').closest('tr');
    expect(tr).toHaveClass('bg-status-error-solid/15');
    expect(screen.getByText('Alpha').closest('td')).toHaveClass('bg-status-error-solid/15');
    // A linha 2 não recebe o tom.
    expect(screen.getByText('Beta').closest('tr')).not.toHaveClass('bg-status-error-solid/15');
  });

  it('mostra a mensagem de vazio quando não há linhas', () => {
    render(<DataGrid {...baseProps} rows={[]} emptyMessage="Nada aqui" />);
    expect(screen.getByText('Nada aqui')).toBeInTheDocument();
  });

  it('usa o aria-label informado na tabela', () => {
    render(<DataGrid {...baseProps} ariaLabel="Recebimento de e-mails" />);
    expect(screen.getByRole('table', { name: 'Recebimento de e-mails' })).toBeInTheDocument();
  });

  it('aplica o tema prata (silver) nos cabeçalhos', () => {
    render(<DataGrid {...baseProps} variant="silver" />);
    expect(screen.getByRole('columnheader', { name: /Nome/ })).toHaveClass('table-header-silver');
  });

  it('em telas pequenas (sm) desce a coluna marcada para a segunda linha', () => {
    setContainerWidth(400); // < 640 → breakpoint 'sm'
    render(<DataGrid {...baseProps} />);
    // 'Tipo' some do cabeçalho principal...
    expect(screen.queryByRole('columnheader', { name: /Tipo/ })).not.toBeInTheDocument();
    // ...e reaparece como rótulo da linha secundária (uma por registro).
    expect(screen.getAllByText('Tipo:')).toHaveLength(ROWS.length);
  });

  it('virtualização: re-mede ao voltar o foco/visibilidade sem quebrar o render', () => {
    // Simula o ambiente da /consulta (virtualização ligada + viewport medido).
    setContainerHeight(800);
    const raf = vi.fn((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    // Viewport com layout real (jsdom devolve 0) — necessário para o heal agir.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 1280,
      height: 800,
      top: 0,
      left: 0,
      right: 1280,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    render(
      <DataGrid
        {...baseProps}
        gridId="virt-grid"
        enableColumnManagement
        enableRowVirtualization
        maxBodyHeight="78vh"
      />,
    );
    // Grid montado (o render virtualizado em si é coberto pela camada e2e/Playwright,
    // pois o jsdom não tem layout real).
    expect(screen.getByRole('table')).toBeInTheDocument();

    // Voltar à aba / reganhar foco / resize agenda a re-medição (auto-recuperação do
    // scrollRect defasado) sem quebrar o grid — é a fiação que corrige o "sumiço" das
    // linhas após inatividade.
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('resize'));
    expect(raf).toHaveBeenCalled();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  describe('modo gerenciável (enableColumnManagement)', () => {
    it('renderiza a barra de ferramentas (botão Colunas)', () => {
      render(<DataGrid {...baseProps} gridId="test-grid" enableColumnManagement />);
      expect(screen.getByRole('button', { name: /Colunas/ })).toBeInTheDocument();
    });

    it('oculta uma coluna pelo menu de colunas', async () => {
      render(<DataGrid {...baseProps} gridId="test-grid" enableColumnManagement />);
      expect(screen.getByRole('columnheader', { name: /Nome/ })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /Colunas/ }));
      await userEvent.click(screen.getByRole('checkbox', { name: 'Mostrar coluna Nome' }));
      expect(screen.queryByRole('columnheader', { name: /Nome/ })).not.toBeInTheDocument();
    });

    it('seleção múltipla: "selecionar todos" marca as linhas e exporta as selecionadas', async () => {
      const onExportSelected = vi.fn();
      render(
        <DataGrid
          {...baseProps}
          gridId="test-grid"
          enableColumnManagement
          enableSelection
          onExportSelected={onExportSelected}
        />,
      );
      await userEvent.click(screen.getByRole('checkbox', { name: 'Selecionar todas as linhas' }));
      expect(screen.getByText(/2 selecionadas/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /Exportar selecionadas/ }));
      expect(onExportSelected).toHaveBeenCalledWith(ROWS);
    });

    it('renderSelectionActions recebe as linhas selecionadas e aparece na barra', async () => {
      render(
        <DataGrid
          {...baseProps}
          gridId="test-grid"
          enableColumnManagement
          enableSelection
          renderSelectionActions={(rows) => (
            <button type="button">Reenviar ({rows.length})</button>
          )}
        />,
      );
      await userEvent.click(screen.getByRole('checkbox', { name: 'Selecionar todas as linhas' }));
      expect(screen.getByRole('button', { name: 'Reenviar (2)' })).toBeInTheDocument();
    });

    it('bulk status: Aplicar envia linhas + situação e trava o duplo clique (applyingBulk)', async () => {
      // Promise controlada — mantém o PATCH "em voo" para provar a trava do botão.
      let resolveBulk!: () => void;
      const onBulkStatusChange = vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => { resolveBulk = resolve; }),
      );
      render(
        <DataGrid
          {...baseProps}
          gridId="bulk-grid"
          enableColumnManagement
          enableSelection
          bulkStatusOptions={[{ value: 8, label: 'pago' }]}
          onBulkStatusChange={onBulkStatusChange}
        />,
      );
      await userEvent.click(screen.getByRole('checkbox', { name: 'Selecionar todas as linhas' }));

      // Sem situação escolhida, Aplicar fica desabilitado.
      const apply = screen.getByRole('button', { name: 'Aplicar' });
      expect(apply).toBeDisabled();

      await userEvent.selectOptions(
        screen.getByRole('combobox', { name: 'Selecionar nova situação' }),
        '8',
      );
      await userEvent.click(apply);
      expect(onBulkStatusChange).toHaveBeenCalledWith(ROWS, 8);

      // Enquanto o await está em voo, o botão trava — o 2º clique não dispara outro PATCH.
      expect(apply).toBeDisabled();
      await userEvent.click(apply);
      expect(onBulkStatusChange).toHaveBeenCalledTimes(1);

      // Ao concluir, a seleção é limpa (a barra de "N selecionadas" some).
      resolveBulk();
      await waitFor(() => expect(screen.queryByText(/2 selecionadas/)).not.toBeInTheDocument());
    });
  });

  describe('scroll infinito (onLoadMore)', () => {
    const virtProps = {
      gridId: 'loadmore-grid',
      enableColumnManagement: true,
      enableRowVirtualization: true,
      maxBodyHeight: '78vh',
    } as const;

    // Liga a virtualização como no teste de auto-recuperação: altura via stub do
    // ResizeObserver + layout real simulado (jsdom devolve 0) + rAF síncrono (o
    // virtualizer agenda a medição via requestAnimationFrame). O virtual-core mede o
    // viewport por offsetWidth/offsetHeight (getRect) — os getters também são mockados.
    const enableVirtualLayout = (): void => {
      setContainerHeight(800);
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      });
      vi.stubGlobal('cancelAnimationFrame', vi.fn());
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1280);
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        width: 1280,
        height: 800,
        top: 0,
        left: 0,
        right: 1280,
        bottom: 800,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
    };

    it('não dispara onLoadMore enquanto loadingMore; dispara UMA vez ao liberar (idempotência)', async () => {
      enableVirtualLayout();
      const onLoadMore = vi.fn();
      // Página anterior ainda carregando → o gatilho de fim-de-lista fica mudo.
      const { rerender } = render(
        <DataGrid {...baseProps} {...virtProps} hasMore loadingMore onLoadMore={onLoadMore} />,
      );
      expect(onLoadMore).not.toHaveBeenCalled();

      // Carregamento concluiu (loadingMore=false) → pede a próxima página UMA vez.
      rerender(<DataGrid {...baseProps} {...virtProps} hasMore loadingMore={false} onLoadMore={onLoadMore} />);
      await waitFor(() => expect(onLoadMore).toHaveBeenCalledTimes(1));

      // Re-render com o mesmo estado não redispara (deps do efeito estáveis).
      rerender(<DataGrid {...baseProps} {...virtProps} hasMore loadingMore={false} onLoadMore={onLoadMore} />);
      expect(onLoadMore).toHaveBeenCalledTimes(1);
    });

    it('não dispara onLoadMore quando não há mais páginas (hasMore=false)', () => {
      enableVirtualLayout();
      const onLoadMore = vi.fn();
      render(<DataGrid {...baseProps} {...virtProps} hasMore={false} onLoadMore={onLoadMore} />);
      expect(onLoadMore).not.toHaveBeenCalled();
    });
  });
});
