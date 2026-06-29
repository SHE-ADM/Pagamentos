// src/components/organisms/ChartAccountForm.tsx
// Organism — form de cadastro/edição do plano de contas. Centro de custo e subgrupo
// são FKs OPCIONAIS (DEFAULT 0 = "não informado") — <select> com a opção neutra 0.
// account_level (numérico) e is_postable (checkbox) têm defaults do banco.
import { useForm } from 'react-hook-form';
import { chartAccountCreateSchema, type ChartAccount, type ChartAccountCreateInput } from '@sheild/shared';
import AuthInput from '../atoms/AuthInput';
import LabeledSelect, { type SelectOption } from '../atoms/LabeledSelect';
import Alert from '../atoms/Alert';

interface ChartAccountFormValues {
  account_code: string;
  account_description: string;
  account_level: number;
  is_postable: boolean;
  cost_center_id: number;
  chart_account_group_id: number;
  chart_account_subgroup_id: number;
}

interface ChartAccountFormProps {
  mode: 'create' | 'edit';
  defaultValues?: Partial<ChartAccount>;
  costCenterOptions: SelectOption[];
  groupOptions: SelectOption[];
  subgroupOptions: SelectOption[];
  onSubmit: (data: ChartAccountCreateInput) => Promise<void>;
  onCancel: () => void;
  submitError?: string | null;
  submitting?: boolean;
}

// Opção neutra (FK opcional = "não informado", id 0) prefixada aos lookups.
const NONE_OPTION: SelectOption = { value: 0, label: '— não informado —' };

function toFormValues(c?: Partial<ChartAccount>): ChartAccountFormValues {
  return {
    account_code: c?.account_code ?? '',
    account_description: c?.account_description ?? '',
    account_level: c?.account_level ?? 2,
    is_postable: c?.is_postable ?? true,
    cost_center_id: c?.cost_center_id ?? 0,
    chart_account_group_id: c?.chart_account_group_id ?? 0,
    chart_account_subgroup_id: c?.chart_account_subgroup_id ?? 0,
  };
}

const FIELD_KEYS = [
  'account_code',
  'account_description',
  'account_level',
  'is_postable',
  'cost_center_id',
  'chart_account_group_id',
  'chart_account_subgroup_id',
] as const;

export default function ChartAccountForm({
  mode,
  defaultValues,
  costCenterOptions,
  groupOptions,
  subgroupOptions,
  onSubmit,
  onCancel,
  submitError,
  submitting = false,
}: Readonly<ChartAccountFormProps>) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<ChartAccountFormValues>({ defaultValues: toFormValues(defaultValues) });

  const submit = handleSubmit(async (raw) => {
    // Campo numérico esvaziado → NaN (valueAsNumber); normaliza para 0.
    const num = (v: number, fallback = 0): number => (Number.isNaN(v) ? fallback : v);
    const parsed = chartAccountCreateSchema.safeParse({
      ...raw,
      account_level: num(raw.account_level, 2),
      cost_center_id: num(raw.cost_center_id),
      chart_account_group_id: num(raw.chart_account_group_id),
      chart_account_subgroup_id: num(raw.chart_account_subgroup_id),
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (typeof field === 'string' && (FIELD_KEYS as readonly string[]).includes(field)) {
          setError(field as (typeof FIELD_KEYS)[number], { message: issue.message });
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
        <AuthInput label="Código" autoComplete="off" error={errors.account_code?.message} {...register('account_code')} />
        <AuthInput
          label="Nível"
          type="number"
          autoComplete="off"
          error={errors.account_level?.message}
          {...register('account_level', { valueAsNumber: true })}
        />
      </div>
      <AuthInput
        label="Descrição"
        autoComplete="off"
        error={errors.account_description?.message}
        {...register('account_description')}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <LabeledSelect
          label="Centro de custo"
          options={[NONE_OPTION, ...costCenterOptions]}
          error={errors.cost_center_id?.message}
          {...register('cost_center_id', { valueAsNumber: true })}
        />
        <LabeledSelect
          label="Grupo"
          options={[NONE_OPTION, ...groupOptions]}
          error={errors.chart_account_group_id?.message}
          {...register('chart_account_group_id', { valueAsNumber: true })}
        />
        <LabeledSelect
          label="Subgrupo"
          options={[NONE_OPTION, ...subgroupOptions]}
          error={errors.chart_account_subgroup_id?.message}
          {...register('chart_account_subgroup_id', { valueAsNumber: true })}
        />
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" className="h-4 w-4" {...register('is_postable')} />
        <span className="text-sm font-medium text-gray-700">Lançável (postável)</span>
      </label>

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
