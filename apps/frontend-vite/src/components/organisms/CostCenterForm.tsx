// src/components/organisms/CostCenterForm.tsx
// Organism — formulário de cadastro/edição de centro de custo. Estado e validação
// via react-hook-form + o schema Zod compartilhado (@sheild/shared) como fonte
// única. A validação roda no submit com safeParse e mapeia os issues para erros de
// campo. O envio efetivo (POST/PATCH na Next API) é responsabilidade do pai.
import { useForm } from 'react-hook-form';
import { costCenterCreateSchema, type CostCenter, type CostCenterCreateInput } from '@sheild/shared';
import AuthInput from '../atoms/AuthInput';
import Alert from '../atoms/Alert';

interface CostCenterFormValues {
  cost_center_code: string;
  cost_center_description: string;
}

interface CostCenterFormProps {
  mode: 'create' | 'edit';
  defaultValues?: Partial<CostCenter>;
  onSubmit: (data: CostCenterCreateInput) => Promise<void>;
  onCancel: () => void;
  /** Erro vindo do backend (ex.: 409 código duplicado) exibido no topo do formulário. */
  submitError?: string | null;
  submitting?: boolean;
}

function toFormValues(c?: Partial<CostCenter>): CostCenterFormValues {
  return {
    cost_center_code: c?.cost_center_code ?? '',
    cost_center_description: c?.cost_center_description ?? '',
  };
}

export default function CostCenterForm({
  mode,
  defaultValues,
  onSubmit,
  onCancel,
  submitError,
  submitting = false,
}: Readonly<CostCenterFormProps>) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<CostCenterFormValues>({ defaultValues: toFormValues(defaultValues) });

  const submit = handleSubmit(async (raw) => {
    // Código e descrição são obrigatórios na criação E na edição — o create schema cobre ambos.
    const parsed = costCenterCreateSchema.safeParse({
      cost_center_code: raw.cost_center_code,
      cost_center_description: raw.cost_center_description,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'cost_center_code' || field === 'cost_center_description') {
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
        <AuthInput
          label="Código"
          autoComplete="off"
          error={errors.cost_center_code?.message}
          {...register('cost_center_code')}
        />
        <AuthInput
          label="Descrição"
          autoComplete="off"
          error={errors.cost_center_description?.message}
          {...register('cost_center_description')}
        />
      </div>

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
