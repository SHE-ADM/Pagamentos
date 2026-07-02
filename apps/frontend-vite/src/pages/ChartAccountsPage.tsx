// src/pages/ChartAccountsPage.tsx — CRUD "Plano de contas"
// (financial_chart_of_account) sobre CrudTablePage. Carrega lookups de centro de
// custo e subgrupo (FKs opcionais) para os <select> do formulário.
import { useEffect, useState } from 'react';
import { BookText } from 'lucide-react';
import type { ChartAccount, ChartAccountCreateInput } from '@sheild/shared';
import CrudTablePage from '../components/organisms/CrudTablePage';
import ChartAccountForm from '../components/organisms/ChartAccountForm';
import type { SelectOption } from '../components/atoms/LabeledSelect';
import { getChartAccountColumns } from '../hooks/useGridColumns';
import {
  listChartAccountsPage,
  createChartAccount,
  updateChartAccount,
  deleteChartAccount,
} from '../services/chartAccounts';
import { listCostCenters, listChartAccountGroups, listChartAccountSubgroups } from '../services/lookups';

const optionLabel = (code?: string | null, desc?: string | null): string => [code, desc].filter(Boolean).join(' — ');

export default function ChartAccountsPage() {
  const [costCenterOptions, setCostCenterOptions] = useState<SelectOption[]>([]);
  const [groupOptions, setGroupOptions] = useState<SelectOption[]>([]);
  const [subgroupOptions, setSubgroupOptions] = useState<SelectOption[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const [centers, groups, subgroups] = await Promise.all([
          listCostCenters(),
          listChartAccountGroups(),
          listChartAccountSubgroups(),
        ]);
        setCostCenterOptions(
          centers.map((c) => ({
            value: c.cost_center_id,
            label: optionLabel(c.cost_center_code, c.cost_center_description),
          })),
        );
        setGroupOptions(
          groups.map((g) => ({
            value: g.chart_account_group_id,
            label: optionLabel(g.group_code, g.group_description),
          })),
        );
        setSubgroupOptions(
          subgroups.map((s) => ({
            value: s.chart_account_subgroup_id,
            label: optionLabel(s.subgroup_code, s.subgroup_description),
          })),
        );
      } catch {
        /* lookups indisponíveis — selects ficam só com "não informado" */
      }
    })();
  }, []);

  return (
    <CrudTablePage<ChartAccount, ChartAccountCreateInput>
      title="Plano de contas"
      subtitle="Tabelas"
      icon={BookText}
      gridId="tabela-plano-de-contas"
      rowKey={(c) => String(c.chart_account_id)}
      columns={getChartAccountColumns}
      list={listChartAccountsPage}
      onCreate={createChartAccount}
      onUpdate={(row, data) => updateChartAccount(row.chart_account_id, data)}
      onDelete={(row) => deleteChartAccount(row.chart_account_id)}
      deleteItemName={(row) => row.account_description ?? row.account_code ?? `#${row.chart_account_id}`}
      // Lançamento rápido: cadastrar mantém o modal aberto, limpa só a descrição e
      // foca o código — agiliza o cadastro de vários planos de contas em sequência.
      keepOpenOnCreate
      renderForm={(a) => (
        <ChartAccountForm
          mode={a.mode}
          defaultValues={a.row}
          costCenterOptions={costCenterOptions}
          groupOptions={groupOptions}
          subgroupOptions={subgroupOptions}
          onSubmit={a.onSubmit}
          onCancel={a.onCancel}
          submitError={a.submitError}
          submitting={a.submitting}
          resetSignal={a.resetSignal}
        />
      )}
      newButtonLabel="Novo plano de contas"
      searchId="chart-accounts-search"
      searchPlaceholder="Buscar por código, descrição, centro de custo, grupo ou sub grupo…"
      searchAriaLabel="Buscar plano de contas por código, descrição, centro de custo, grupo ou sub grupo"
      emptyMessage="Nenhum plano de contas encontrado"
      gridAriaLabel="Plano de contas cadastrado"
      countLabel={(n) => `${n} planos de contas`}
      messages={{
        created: 'Plano de contas cadastrado com sucesso.',
        updated: 'Plano de contas atualizado com sucesso.',
        deleted: 'Plano de contas excluído com sucesso.',
      }}
      formTitle={{ create: 'Novo plano de contas', edit: 'Editar plano de contas' }}
    />
  );
}
