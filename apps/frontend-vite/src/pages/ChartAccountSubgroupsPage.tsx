// src/pages/ChartAccountSubgroupsPage.tsx — CRUD "Sub grupos de plano de contas"
// (financial_chart_of_account_subgroup) sobre CrudTablePage. Carrega o lookup de
// grupos (FK obrigatória) para o <select> do formulário.
import { useEffect, useState } from 'react';
import { ListTree } from 'lucide-react';
import type { ChartAccountSubgroup, ChartAccountSubgroupCreateInput } from '@sheild/shared';
import CrudTablePage from '../components/organisms/CrudTablePage';
import ChartAccountSubgroupForm from '../components/organisms/ChartAccountSubgroupForm';
import type { SelectOption } from '../components/atoms/LabeledSelect';
import { getChartAccountSubgroupColumns } from '../hooks/useGridColumns';
import {
  listChartAccountSubgroupsPage,
  createChartAccountSubgroup,
  updateChartAccountSubgroup,
  deleteChartAccountSubgroup,
} from '../services/chartAccountSubgroups';
import { listChartAccountGroups } from '../services/lookups';

const optionLabel = (code?: string | null, desc?: string | null): string => [code, desc].filter(Boolean).join(' — ');

export default function ChartAccountSubgroupsPage() {
  const [groupOptions, setGroupOptions] = useState<SelectOption[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const groups = await listChartAccountGroups();
        setGroupOptions(
          groups.map((g) => ({
            value: g.chart_account_group_id,
            label: optionLabel(g.group_code, g.group_description),
          })),
        );
      } catch {
        /* lookup indisponível — o form ainda valida "Grupo é obrigatório" */
      }
    })();
  }, []);

  return (
    <CrudTablePage<ChartAccountSubgroup, ChartAccountSubgroupCreateInput>
      title="Sub grupos de plano de contas"
      subtitle="Tabelas"
      icon={ListTree}
      gridId="tabela-subgrupos-plano-de-contas"
      rowKey={(s) => String(s.chart_account_subgroup_id)}
      columns={getChartAccountSubgroupColumns}
      list={listChartAccountSubgroupsPage}
      onCreate={createChartAccountSubgroup}
      onUpdate={(row, data) => updateChartAccountSubgroup(row.chart_account_subgroup_id, data)}
      onDelete={(row) => deleteChartAccountSubgroup(row.chart_account_subgroup_id)}
      deleteItemName={(row) => row.subgroup_description ?? row.subgroup_code ?? `#${row.chart_account_subgroup_id}`}
      renderForm={(a) => (
        <ChartAccountSubgroupForm
          mode={a.mode}
          defaultValues={a.row}
          groupOptions={groupOptions}
          onSubmit={a.onSubmit}
          onCancel={a.onCancel}
          submitError={a.submitError}
          submitting={a.submitting}
        />
      )}
      newButtonLabel="Novo subgrupo"
      searchId="chart-account-subgroups-search"
      searchPlaceholder="Buscar por código, descrição ou grupo…"
      searchAriaLabel="Buscar subgrupo por código, descrição ou grupo"
      emptyMessage="Nenhum subgrupo encontrado"
      gridAriaLabel="Sub grupos de plano de contas cadastrados"
      countLabel={(n) => `${n} subgrupos`}
      messages={{
        created: 'Subgrupo cadastrado com sucesso.',
        updated: 'Subgrupo atualizado com sucesso.',
        deleted: 'Subgrupo excluído com sucesso.',
      }}
      formTitle={{ create: 'Novo subgrupo', edit: 'Editar subgrupo' }}
    />
  );
}
