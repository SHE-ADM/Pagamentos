// src/components/organisms/ChartAccountGroupForm.tsx
// Organism — form de cadastro/edição de grupo do plano de contas. Validação via
// react-hook-form + chartAccountGroupCreateSchema (@sheild/shared). A NATUREZA contábil
// (FK type_group_id → financial_type_group) vem de um <select> alimentado pelo lookup
// (props typeGroupOptions), substituindo o antigo campo "Tipo" (group_type, legado).
import { useForm } from 'react-hook-form';
import {
  chartAccountGroupCreateSchema,
  type ChartAccountGroup,
  type ChartAccountGroupCreateInput,
} from '@sheild/shared';
import AuthInput from '../atoms/AuthInput';
import LabeledSelect, { type SelectOption } from '../atoms/LabeledSelect';
import Alert from '../atoms/Alert';

interface GroupFormValues {
  group_code: string;
  group_description: string;
  type_group_id: number;
}

interface ChartAccountGroupFormProps {
  mode: 'create' | 'edit';
  defaultValues?: Partial<ChartAccountGroup>;
  typeGroupOptions: SelectOption[];
  onSubmit: (data: ChartAccountGroupCreateInput) => Promise<void>;
  onCancel: () => void;
  submitError?: string | null;
  submitting?: boolean;
}

function toFormValues(g?: Partial<ChartAccountGroup>): GroupFormValues {
  return {
    group_code: g?.group_code ?? '',
    group_description: g?.group_description ?? '',
    // 0 = "Não informado" (default do banco) — selecionado por padrão no create.
    type_group_id: g?.type_group_id ?? 0,
  };
}

export default function ChartAccountGroupForm({
  mode,
  defaultValues,
  typeGroupOptions,
  onSubmit,
  onCancel,
  submitError,
  submitting = false,
}: Readonly<ChartAccountGroupFormProps>) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<GroupFormValues>({ defaultValues: toFormValues(defaultValues) });

  // Robustez: se o lookup falhou (typeGroupOptions vazio/incompleto) ao editar um grupo já
  // classificado, garante que a Natureza ATUAL continue sendo uma opção — senão o <select>
  // não a exibiria e o submit a resetaria para 0 ("Não informado") silenciosamente.
  const currentTypeGroupId = defaultValues?.type_group_id;
  const options =
    currentTypeGroupId === undefined || typeGroupOptions.some((o) => o.value === currentTypeGroupId)
      ? typeGroupOptions
      : [
          {
            value: currentTypeGroupId,
            label: defaultValues?.type_group?.type_group_description ?? `#${currentTypeGroupId}`,
          },
          ...typeGroupOptions,
        ];

  // Rótulo do botão extraído em duas expressões (sem ternário aninhado — S3358).
  const idleLabel = mode === 'create' ? 'Cadastrar' : 'Salvar alterações';
  const submitLabel = submitting ? 'Salvando…' : idleLabel;

  const submit = handleSubmit(async (raw) => {
    // Sem seleção, o valueAsNumber devolve NaN — normaliza para 0 ("Não informado").
    const typeGroupId = Number.isNaN(raw.type_group_id) ? 0 : raw.type_group_id;
    const parsed = chartAccountGroupCreateSchema.safeParse({
      group_code: raw.group_code,
      group_description: raw.group_description,
      type_group_id: typeGroupId,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'group_code' || field === 'group_description' || field === 'type_group_id') {
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
        <AuthInput label="Código" autoComplete="off" error={errors.group_code?.message} {...register('group_code')} />
        <LabeledSelect
          label="Natureza"
          options={options}
          error={errors.type_group_id?.message}
          {...register('type_group_id', { valueAsNumber: true })}
        />
      </div>
      <AuthInput
        label="Descrição"
        autoComplete="off"
        error={errors.group_description?.message}
        {...register('group_description')}
      />

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onCancel} className="btn" disabled={submitting}>
          Cancelar
        </button>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
