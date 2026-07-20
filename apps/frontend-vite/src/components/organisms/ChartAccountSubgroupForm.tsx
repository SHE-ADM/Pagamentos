// src/components/organisms/ChartAccountSubgroupForm.tsx
// Organism — form de cadastro/edição de subgrupo do plano de contas. O grupo (FK
// obrigatória) vem de um <select> alimentado pelo lookup (props groupOptions). A
// TIPO contábil (FK type_group_id → financial_type_group) vem de outro <select>
// (props typeGroupOptions) — mesmo padrão do ChartAccountGroupForm, mas classificada
// por subgrupo (granularidade fina), não herdada do grupo.
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
  type_group_id: number;
}

interface ChartAccountSubgroupFormProps {
  mode: 'create' | 'edit';
  defaultValues?: Partial<ChartAccountSubgroup>;
  groupOptions: SelectOption[];
  typeGroupOptions: SelectOption[];
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
    // 0 = "Não informado" (default do banco) — selecionado por padrão no create.
    type_group_id: s?.type_group_id ?? 0,
  };
}

export default function ChartAccountSubgroupForm({
  mode,
  defaultValues,
  groupOptions,
  typeGroupOptions,
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

  // Robustez: se o lookup falhou (typeGroupOptions vazio/incompleto) ao editar um
  // subgrupo já classificado, garante que o Tipo ATUAL continue sendo uma opção —
  // senão o <select> não a exibiria e o submit a resetaria para 0 silenciosamente.
  const currentTypeGroupId = defaultValues?.type_group_id;
  const typeOptions =
    currentTypeGroupId === undefined || typeGroupOptions.some((o) => o.value === currentTypeGroupId)
      ? typeGroupOptions
      : [
          {
            value: currentTypeGroupId,
            label: defaultValues?.type_group?.type_group_description ?? `#${currentTypeGroupId}`,
          },
          ...typeGroupOptions,
        ];

  const submit = handleSubmit(async (raw) => {
    // Sem seleção, o valueAsNumber devolve NaN — grupo normaliza para 0 (dispara o
    // .min(1) com a mensagem "Grupo é obrigatório"); Tipo normaliza para 0
    // ("Não informado", válido).
    const groupId = Number.isNaN(raw.chart_account_group_id) ? 0 : raw.chart_account_group_id;
    const typeGroupId = Number.isNaN(raw.type_group_id) ? 0 : raw.type_group_id;
    const parsed = chartAccountSubgroupCreateSchema.safeParse({
      subgroup_code: raw.subgroup_code,
      subgroup_description: raw.subgroup_description,
      chart_account_group_id: groupId,
      type_group_id: typeGroupId,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (
          field === 'subgroup_code' ||
          field === 'subgroup_description' ||
          field === 'chart_account_group_id' ||
          field === 'type_group_id'
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
      <LabeledSelect
        label="Tipo"
        options={typeOptions}
        error={errors.type_group_id?.message}
        {...register('type_group_id', { valueAsNumber: true })}
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
