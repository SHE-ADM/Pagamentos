// src/components/organisms/BankForm.tsx
// Organism — form de cadastro/edição de banco. Validação via react-hook-form +
// bankCreateSchema (@sheild/shared). O envio (POST/PATCH) é do pai.
import { useForm } from 'react-hook-form';
import { bankCreateSchema, type Bank, type BankCreateInput } from '@sheild/shared';
import AuthInput from '../atoms/AuthInput';
import Alert from '../atoms/Alert';

interface BankFormValues {
  bank_code: string;
  bank_name: string;
}

interface BankFormProps {
  mode: 'create' | 'edit';
  defaultValues?: Partial<Bank>;
  onSubmit: (data: BankCreateInput) => Promise<void>;
  onCancel: () => void;
  submitError?: string | null;
  submitting?: boolean;
}

function toFormValues(b?: Partial<Bank>): BankFormValues {
  return { bank_code: b?.bank_code ?? '', bank_name: b?.bank_name ?? '' };
}

export default function BankForm({
  mode,
  defaultValues,
  onSubmit,
  onCancel,
  submitError,
  submitting = false,
}: Readonly<BankFormProps>) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<BankFormValues>({ defaultValues: toFormValues(defaultValues) });

  const submit = handleSubmit(async (raw) => {
    const parsed = bankCreateSchema.safeParse({ bank_code: raw.bank_code, bank_name: raw.bank_name });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'bank_code' || field === 'bank_name') setError(field, { message: issue.message });
      }
      return;
    }
    await onSubmit(parsed.data);
  });

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {submitError && <Alert variant="error">{submitError}</Alert>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <AuthInput label="Código (3 dígitos)" autoComplete="off" error={errors.bank_code?.message} {...register('bank_code')} />
        <AuthInput label="Nome" autoComplete="off" error={errors.bank_name?.message} {...register('bank_name')} />
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
