// src/pages/ChartAccountGroupsPage.tsx — CRUD "Grupos de plano de contas"
// (financial_chart_of_account_group) sobre CrudTablePage.
import { FolderTree } from 'lucide-react';
import type { ChartAccountGroup, ChartAccountGroupCreateInput } from '@sheild/shared';
import CrudTablePage from '../components/organisms/CrudTablePage';
import ChartAccountGroupForm from '../components/organisms/ChartAccountGroupForm';
import { getChartAccountGroupColumns } from '../hooks/useGridColumns';
import {
  listChartAccountGroupsPage,
  createChartAccountGroup,
  updateChartAccountGroup,
  deleteChartAccountGroup,
} from '../services/chartAccountGroups';

export default function ChartAccountGroupsPage() {
  return (
    <CrudTablePage<ChartAccountGroup, ChartAccountGroupCreateInput>
      title="Grupos de plano de contas"
      subtitle="Tabelas"
      icon={FolderTree}
      gridId="tabela-grupos-plano-de-contas"
      rowKey={(g) => String(g.chart_account_group_id)}
      columns={getChartAccountGroupColumns}
      list={listChartAccountGroupsPage}
      onCreate={createChartAccountGroup}
      onUpdate={(row, data) => updateChartAccountGroup(row.chart_account_group_id, data)}
      onDelete={(row) => deleteChartAccountGroup(row.chart_account_group_id)}
      deleteItemName={(row) => row.group_description ?? row.group_code ?? `#${row.chart_account_group_id}`}
      renderForm={(a) => (
        <ChartAccountGroupForm
          mode={a.mode}
          defaultValues={a.row}
          onSubmit={a.onSubmit}
          onCancel={a.onCancel}
          submitError={a.submitError}
          submitting={a.submitting}
        />
      )}
      newButtonLabel="Novo grupo"
      searchId="chart-account-groups-search"
      searchPlaceholder="Buscar por código, descrição ou tipo…"
      searchAriaLabel="Buscar grupo por código, descrição ou tipo"
      emptyMessage="Nenhum grupo encontrado"
      gridAriaLabel="Grupos de plano de contas cadastrados"
      countLabel={(n) => `${n} grupos`}
      messages={{
        created: 'Grupo cadastrado com sucesso.',
        updated: 'Grupo atualizado com sucesso.',
        deleted: 'Grupo excluído com sucesso.',
      }}
      formTitle={{ create: 'Novo grupo', edit: 'Editar grupo' }}
    />
  );
}
