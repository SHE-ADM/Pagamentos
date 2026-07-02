// src/pages/BanksPage.tsx — CRUD "Bancos" (financial_bank) sobre CrudTablePage.
import { Landmark } from 'lucide-react';
import type { Bank, BankCreateInput } from '@sheild/shared';
import CrudTablePage from '../components/organisms/CrudTablePage';
import BankForm from '../components/organisms/BankForm';
import { getBankColumns } from '../hooks/useGridColumns';
import { listBanksPage, createBank, updateBank, deleteBank } from '../services/banks';

export default function BanksPage() {
  return (
    <CrudTablePage<Bank, BankCreateInput>
      title="Bancos"
      subtitle="Tabelas"
      icon={Landmark}
      gridId="tabela-bancos"
      rowKey={(b) => String(b.bank_id)}
      columns={getBankColumns}
      list={listBanksPage}
      onCreate={createBank}
      onUpdate={(row, data) => updateBank(row.bank_id, data)}
      onDelete={(row) => deleteBank(row.bank_id)}
      deleteItemName={(row) => row.bank_name ?? row.bank_code ?? String(row.bank_id)}
      renderForm={(a) => (
        <BankForm
          mode={a.mode}
          defaultValues={a.row}
          onSubmit={a.onSubmit}
          onCancel={a.onCancel}
          submitError={a.submitError}
          submitting={a.submitting}
        />
      )}
      newButtonLabel="Novo banco"
      searchId="banks-search"
      searchPlaceholder="Buscar por código ou nome…"
      searchAriaLabel="Buscar banco por código ou nome"
      emptyMessage="Nenhum banco encontrado"
      gridAriaLabel="Bancos cadastrados"
      countLabel={(n) => `${n} bancos`}
      messages={{
        created: 'Banco cadastrado com sucesso.',
        updated: 'Banco atualizado com sucesso.',
        deleted: 'Banco excluído com sucesso.',
      }}
      formTitle={{ create: 'Novo banco', edit: 'Editar banco' }}
    />
  );
}
