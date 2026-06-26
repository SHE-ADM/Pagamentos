// src/components/organisms/ChartAccountGroupForm.tsx
// Organism — form de cadastro/edição de grupo do plano de contas. Validação via
// react-hook-form + chartAccountGroupCreateSchema (@sheild/shared).
import { useForm } from 'react-hook-form';
import {
  chartAccountGroupCreateSchema,
  type ChartAccountGroup,
  type ChartAccountGroupCreateInput,
} from '@sheild/shared';
import AuthInput from '../atoms/AuthInput';
import Alert from '../atoms/Alert';

interface GroupFormValues {
  group_code: string;
  group_description: string;
  group_type: string;
}

interface ChartAccountGroupFormProps {
  mode: 'create' | 'edit';
  defaultValues?: Partial<ChartAccountGroup>;
  onSubmit: (data: ChartAccountGroupCreateInput) => Promise<void>;
  onCancel: () => void;
  submitError?: string | null;
  submitting?: boolean;
}

function toFormValues(g?: Partial<ChartAccountGroup>): GroupFormValues {
  return {
    group_code: g?.group_code ?? '',
    group_description: g?.group_description ?? '',
    group_type: g?.group_type ?? '',
  };
}

export default function ChartAccountGroupForm({
  mode,
  defaultValues,
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

  const submit = handleSubmit(async (raw) => {
    // group_type vazio → omitido (campo opcional).
    const parsed = chartAccountGroupCreateSchema.safeParse({
      group_code: raw.group_code,
      group_description: raw.group_description,
      ...(raw.group_type.trim() ? { group_type: raw.group_type } : {}),
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'group_code' || field === 'group_description' || field === 'group_type') {
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
        <AuthInput
          label="Tipo (1 caractere)"
          autoComplete="off"
          maxLength={1}
          error={errors.group_type?.message}
          {...register('group_type')}
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
          {submitting ? 'Salvando…' : mode === 'create' ? 'Cadastrar' : 'Salvar alterações'}
        </button>
      </div>
    </form>
  );
}
