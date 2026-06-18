import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StatusSelectCell, { type StatusOption } from './StatusSelectCell';
import { STATUS_OPTIONS } from '../../hooks/useGridColumns';

const OPTIONS: StatusOption[] = [
  { value: 'pendente', label: 'Pendente' },
  { value: 'a vencer', label: 'A Vencer' },
  { value: 'pago', label: 'Pago' },
  { value: 'cancelado', label: 'Cancelado' },
];

describe('StatusSelectCell', () => {
  it('exibe botão com label de acessibilidade descrevendo o status atual', () => {
    render(
      <StatusSelectCell rowId={1} value="pendente" options={OPTIONS} onSave={vi.fn()} />,
    );
    expect(
      screen.getByRole('button', { name: /situação: pendente. clique para alterar/i }),
    ).toBeInTheDocument();
  });

  it('abre o select ao clicar no botão', async () => {
    const user = userEvent.setup();
    render(
      <StatusSelectCell rowId={1} value="pendente" options={OPTIONS} onSave={vi.fn()} />,
    );
    await user.click(screen.getByRole('button'));
    expect(screen.getByRole('combobox', { name: /alterar situação/i })).toBeInTheDocument();
  });

  it('chama onSave com o novo status ao selecionar opção diferente', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <StatusSelectCell rowId={42} value="pendente" options={OPTIONS} onSave={onSave} />,
    );
    await user.click(screen.getByRole('button'));
    await user.selectOptions(screen.getByRole('combobox'), 'pago');
    expect(onSave).toHaveBeenCalledWith(42, 'pago');
  });

  it('reverte ao valor anterior quando onSave rejeita', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('erro de rede'));
    const user = userEvent.setup();
    render(
      <StatusSelectCell rowId={1} value="pendente" options={OPTIONS} onSave={onSave} />,
    );
    await user.click(screen.getByRole('button'));
    await user.selectOptions(screen.getByRole('combobox'), 'pago');
    // Após rejeição, volta ao valor original
    expect(
      await screen.findByRole('button', { name: /situação: pendente/i }),
    ).toBeInTheDocument();
  });

  it('não chama onSave quando o mesmo valor é selecionado', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <StatusSelectCell rowId={1} value="pendente" options={OPTIONS} onSave={onSave} />,
    );
    await user.click(screen.getByRole('button'));
    await user.selectOptions(screen.getByRole('combobox'), 'pendente');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('volta ao modo de visualização após perda de foco no select', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <StatusSelectCell rowId={1} value="pago" options={OPTIONS} onSave={vi.fn()} />
        <button type="button">outro</button>
      </div>,
    );
    await user.click(screen.getByRole('button', { name: /situação: pago/i }));
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /outro/i }));
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('renderiza todas as opções no select aberto', async () => {
    const user = userEvent.setup();
    render(
      <StatusSelectCell rowId={1} value="pendente" options={OPTIONS} onSave={vi.fn()} />,
    );
    await user.click(screen.getByRole('button'));
    for (const opt of OPTIONS) {
      expect(screen.getByRole('option', { name: opt.label })).toBeInTheDocument();
    }
  });
});

describe('STATUS_OPTIONS — ordem de ciclo de vida', () => {
  const LIFECYCLE_ORDER = [
    'pendente', 'a vencer', 'vencido', 'prorrogado', 'baixado',
    'protestado', 'cartório', 'pago', 'cancelado', 'falha',
  ];

  it('contém exatamente 10 opções na sequência de ciclo de vida', () => {
    expect(STATUS_OPTIONS).toHaveLength(10);
    STATUS_OPTIONS.forEach((opt, i) => {
      expect(opt.value).toBe(LIFECYCLE_ORDER[i]);
    });
  });

  it('dropdown renderiza opções na ordem de ciclo de vida', async () => {
    const user = userEvent.setup();
    render(
      <StatusSelectCell rowId={1} value="pendente" options={STATUS_OPTIONS} onSave={vi.fn()} />,
    );
    await user.click(screen.getByRole('button'));

    const select = screen.getByRole('combobox', { name: /alterar situação/i });
    const rendered = within(select)
      .getAllByRole('option')
      .map((el) => el.getAttribute('value'));

    expect(rendered).toEqual(LIFECYCLE_ORDER);
  });
});
