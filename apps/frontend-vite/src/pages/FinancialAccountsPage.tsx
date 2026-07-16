// src/pages/FinancialAccountsPage.tsx — CRUD "Contas" (financial_account: contas
// bancárias/caixa) sobre CrudTablePage. Carrega lookups de banco e situação (status).
// Distinto de /contas (financial_account_control, lançamentos).
import { useEffect, useMemo, useState } from 'react';
import { Wallet } from 'lucide-react';
import type { FinancialAccount, FinancialAccountCreateInput } from '@sheild/shared';
import CrudTablePage from '../components/organisms/CrudTablePage';
import FinancialAccountForm from '../components/organisms/FinancialAccountForm';
import type { SelectOption } from '../components/atoms/LabeledSelect';
import { getFinancialAccountColumns } from '../hooks/useGridColumns';
import {
  listFinancialAccountsPage,
  createFinancialAccount,
  updateFinancialAccount,
  deleteFinancialAccount,
} from '../services/financialAccounts';
import { listBanks, listStatuses, type StatusOption } from '../services/lookups';

const bankLabel = (code?: string | null, name?: string | null): string => [code, name].filter(Boolean).join(' — ');

export default function FinancialAccountsPage() {
  const [bankOptions, setBankOptions] = useState<SelectOption[]>([]);
  const [statuses, setStatuses] = useState<StatusOption[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const [banks, sts] = await Promise.all([listBanks(), listStatuses()]);
        setBankOptions(banks.map((b) => ({ value: b.bank_id, label: bankLabel(b.bank_code, b.bank_name) })));
        setStatuses(sts);
      } catch {
        /* lookups indisponíveis */
      }
    })();
  }, []);

  // Mapa id → nome da situação para a coluna do grid (fallback "#id").
  const statusLabelMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const s of statuses) if (s.status_name) m.set(s.status_id, s.status_name);
    return m;
  }, [statuses]);
  const statusLabel = (id: number): string => statusLabelMap.get(id) ?? `#${id}`;

  const statusOptions: SelectOption[] = statuses.map((s) => ({ value: s.status_id, label: s.status_name ?? `#${s.status_id}` }));

  return (
    <CrudTablePage<FinancialAccount, FinancialAccountCreateInput>
      title="Contas bancárias"
      subtitle="Tabelas"
      icon={Wallet}
      gridId="tabela-contas"
      rowKey={(a) => String(a.financial_account_id)}
      columns={(onEdit, onDelete) => getFinancialAccountColumns(statusLabel, onEdit, onDelete)}
      list={listFinancialAccountsPage}
      onCreate={createFinancialAccount}
      onUpdate={(row, data) => updateFinancialAccount(row.financial_account_id, data)}
      onDelete={(row) => deleteFinancialAccount(row.financial_account_id)}
      deleteItemName={(row) => row.account_description ?? `#${row.financial_account_id}`}
      renderForm={(a) => (
        <FinancialAccountForm
          mode={a.mode}
          defaultValues={a.row}
          bankOptions={bankOptions}
          statusOptions={statusOptions}
          onSubmit={a.onSubmit}
          onCancel={a.onCancel}
          submitError={a.submitError}
          submitting={a.submitting}
        />
      )}
      newButtonLabel="Nova conta"
      searchId="financial-accounts-search"
      searchPlaceholder="Buscar por descrição, banco, moeda, saldo, tipo pgto ou situação…"
      searchAriaLabel="Buscar conta por descrição, banco, moeda, saldo, tipo de pagamento ou situação"
      emptyMessage="Nenhuma conta encontrada"
      gridAriaLabel="Contas bancárias cadastradas"
      countLabel={(n) => `${n} contas`}
      messages={{
        created: 'Conta cadastrada com sucesso.',
        updated: 'Conta atualizada com sucesso.',
        deleted: 'Conta excluída com sucesso.',
      }}
      formTitle={{ create: 'Nova conta', edit: 'Editar conta' }}
    />
  );
}
