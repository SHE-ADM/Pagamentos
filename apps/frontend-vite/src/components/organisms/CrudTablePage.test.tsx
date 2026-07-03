import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Landmark } from 'lucide-react';
import type { Bank, BankCreateInput } from '@sheild/shared';
import CrudTablePage from './CrudTablePage';
import { getBankColumns } from '../../hooks/useGridColumns';

// isAdminGroup controla se o botão de excluir (hard delete) é oferecido. vi.hoisted evita
// o TDZ ao referenciar o estado dentro da factory hoisteada do vi.mock.
const authState = vi.hoisted(() => ({ isAdminGroup: false }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ isAdminGroup: authState.isAdminGroup, session: null, user: null, loading: false, signOut: vi.fn() }),
}));

const banks: Bank[] = [{ bank_id: 5, bank_code: '001', bank_name: 'Banco do Brasil' }];
const listMock = vi.fn();
const onDelete = vi.fn();

function renderPage() {
  render(
    <CrudTablePage<Bank, BankCreateInput>
      title="Bancos"
      subtitle="Tabelas"
      icon={Landmark}
      gridId="test-tabela-bancos"
      rowKey={(b) => String(b.bank_id)}
      columns={getBankColumns}
      list={listMock}
      onCreate={vi.fn()}
      onUpdate={vi.fn()}
      onDelete={onDelete}
      deleteItemName={(b) => b.bank_name ?? String(b.bank_id)}
      renderForm={() => null}
      newButtonLabel="Novo banco"
      searchId="banks-search"
      searchPlaceholder="Buscar…"
      searchAriaLabel="Buscar banco"
      emptyMessage="Nenhum banco"
      gridAriaLabel="Bancos"
      countLabel={(n) => `${n} bancos`}
      messages={{ created: 'c', updated: 'u', deleted: 'Banco excluído com sucesso.' }}
      formTitle={{ create: 'Novo banco', edit: 'Editar banco' }}
    />,
  );
}

beforeEach(() => {
  authState.isAdminGroup = false;
  listMock.mockReset().mockResolvedValue({ data: banks, total: 1 });
  onDelete.mockReset().mockResolvedValue(undefined);
});

describe('CrudTablePage — hard delete admin-only', () => {
  it('não-admin: mostra editar, mas NÃO mostra o botão de excluir', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('Editar 001')).toBeInTheDocument());
    expect(screen.queryByLabelText('Excluir 001')).toBeNull();
  });

  it('admin: mostra o botão de excluir na linha', async () => {
    authState.isAdminGroup = true;
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('Excluir 001')).toBeInTheDocument());
  });

  it('admin: confirmar a exclusão chama onDelete e recarrega a lista', async () => {
    authState.isAdminGroup = true;
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('Excluir 001')).toBeInTheDocument());

    // Abre a confirmação a partir do botão da linha.
    fireEvent.click(screen.getByLabelText('Excluir 001'));
    await waitFor(() => expect(screen.getByText('Excluir registro')).toBeInTheDocument());

    // Confirma no botão do diálogo (nome acessível exatamente "Excluir"). jsdom não
    // implementa <dialog>.showModal — o conteúdo fica hidden na a11y tree (hidden: true).
    fireEvent.click(screen.getByRole('button', { name: 'Excluir', hidden: true }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(banks[0]));
    // Recarrega após excluir: chamada inicial + reload.
    await waitFor(() => expect(listMock.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});
