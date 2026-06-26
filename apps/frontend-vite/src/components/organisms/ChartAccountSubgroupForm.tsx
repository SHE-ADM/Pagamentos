// src/components/organisms/ChartAccountSubgroupForm.tsx
// Organism — form de cadastro/edição de subgrupo do plano de contas. O grupo (FK
// obrigatória) vem de um <select> alimentado pelo lookup (props groupOptions).
import { useForm } from 'react-hook-form';
import {
  chartAccountSubgroupCreateSchema,
  type ChartAccountSubgroup,
  type ChartAccountSubgroupCreateInput,
} from '@sheild/shared';
import AuthInput from '../atoms/AuthInput';
import LabeledSelect, { type SelectOption } from '../atoms/LabeledSelect';
import Alert from '../atoms/Alert';

interface SubgroupFormValues {
  subgroup_code: string;
  subgroup_description: string;
  chart_account_group_id: number;
}

interface ChartAccountSubgroupFormProps {
  mode: 'create' | 'edit';
  defaultValues?: Partial<ChartAccountSubgroup>;
  groupOptions: SelectOption[];
  onSubmit: (data: ChartAccountSubgroupCreateInput) => Promise<void>;
  onCancel: () => void;
  submitError?: string | null;
  submitting?: boolean;
}

function toFormValues(s?: Partial<ChartAccountSubgroup>): Partial<SubgroupFormValues> {
  return {
    subgroup_code: s?.subgroup_code ?? '',
    subgroup_description: s?.subgroup_description ?? '',
    // undefined no create → o placeholder "Selecione…" fica selecionado (força escolha).
    chart_account_group_id: s?.chart_account_group_id,
  };
}

export default function ChartAccountSubgroupForm({
  mode,
  defaultValues,
  groupOptions,
  onSubmit,
  onCancel,
  submitError,
  submitting = false,
}: Readonly<ChartAccountSubgroupFormProps>) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<SubgroupFormValues>({ defaultValues: toFormValues(defaultValues) });

  const submit = handleSubmit(async (raw) => {
    // Sem seleção, o valueAsNumber devolve NaN — normaliza para 0 (dispara o
    // .min(1) com a mensagem "Grupo é obrigatório").
    const groupId = Number.isNaN(raw.chart_account_group_id) ? 0 : raw.chart_account_group_id;
    const parsed = chartAccountSubgroupCreateSchema.safeParse({
      subgroup_code: raw.subgroup_code,
      subgroup_description: raw.subgroup_description,
      chart_account_group_id: groupId,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (
          field === 'subgroup_code' ||
          field === 'subgroup_description' ||
          field === 'chart_account_group_id'
        ) {
          setError(field, { message: issue.message });
        }
      }
      return;
    }
    await onSubmit(parsed.data);
  });

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {submitError && <Alert variant="error">{submitError}</Alert>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <AuthInput label="Código" autoComplete="off" error={errors.subgroup_code?.message} {...register('subgroup_code')} />
        <LabeledSelect
          label="Grupo"
          placeholder="Selecione…"
          options={groupOptions}
          error={errors.chart_account_group_id?.message}
          {...register('chart_account_group_id', { valueAsNumber: true })}
        />
      </div>
      <AuthInput
        label="Descrição"
        autoComplete="off"
        error={errors.subgroup_description?.message}
        {...register('subgroup_description')}
      />

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onCancel} className="btn" disabled={submitting}>
          Cancelar
        </button>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Salvando…' : mode === 'create' ? 'Cadastrar' : 'Salvar alterações'}
        </button>
      </div>
    </form>
  );
}
