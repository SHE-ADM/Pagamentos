import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

afterEach(() => {
  delete (globalThis as { __roWidth?: number }).__roWidth;
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
  });
});
