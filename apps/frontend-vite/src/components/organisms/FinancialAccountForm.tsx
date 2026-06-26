// src/components/organisms/FinancialAccountForm.tsx
// Organism — form de cadastro/edição de conta bancária/caixa (financial_account).
// Banco e Situação vêm de <select> (lookups: bankOptions / statusOptions). Os campos
// payment_type_id (sem tabela de domínio) e saldo são numéricos. Validação via
// financialAccountCreateSchema (@sheild/shared).
import { useForm } from 'react-hook-form';
import {
  financialAccountCreateSchema,
  type FinancialAccount,
  type FinancialAccountCreateInput,
} from '@sheild/shared';
import AuthInput from '../atoms/AuthInput';
import LabeledSelect, { type SelectOption } from '../atoms/LabeledSelect';
import Alert from '../atoms/Alert';

interface AccountFormValues {
  account_description: string;
  bank_id: number;
  status_id: number;
  payment_type_id: number;
  currency_code: string;
  balance_amount: number;
}

interface FinancialAccountFormProps {
  mode: 'create' | 'edit';
  defaultValues?: Partial<FinancialAccount>;
  bankOptions: SelectOption[];
  statusOptions: SelectOption[];
  onSubmit: (data: FinancialAccountCreateInput) => Promise<void>;
  onCancel: () => void;
  submitError?: string | null;
  submitting?: boolean;
}

// Banco aceita 0 ("não informado"/Caixa, conforme a base) → opção neutra prefixada.
const NONE_BANK: SelectOption = { value: 0, label: '— não informado —' };

function toFormValues(a?: Partial<FinancialAccount>): Partial<AccountFormValues> {
  return {
    account_description: a?.account_description ?? '',
    bank_id: a?.bank_id ?? 0,
    status_id: a?.status_id, // undefined no create → placeholder força escolha
    payment_type_id: a?.payment_type_id ?? 0,
    currency_code: a?.currency_code ?? 'R$',
    balance_amount: a?.balance_amount ?? 0,
  };
}

const FIELD_KEYS = [
  'account_description',
  'bank_id',
  'status_id',
  'payment_type_id',
  'currency_code',
  'balance_amount',
] as const;

export default function FinancialAccountForm({
  mode,
  defaultValues,
  bankOptions,
  statusOptions,
  onSubmit,
  onCancel,
  submitError,
  submitting = false,
}: Readonly<FinancialAccountFormProps>) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<AccountFormValues>({ defaultValues: toFormValues(defaultValues) });

  const submit = handleSubmit(async (raw) => {
    // Campo numérico/select esvaziado → NaN (valueAsNumber); normaliza para 0
    // (status_id 0 dispara o .min(1) "Situação é obrigatória").
    const num = (v: number): number => (Number.isNaN(v) ? 0 : v);
    const parsed = financialAccountCreateSchema.safeParse({
      ...raw,
      bank_id: num(raw.bank_id),
      status_id: num(raw.status_id),
      payment_type_id: num(raw.payment_type_id),
      balance_amount: num(raw.balance_amount),
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

      <AuthInput
        label="Descrição"
        autoComplete="off"
        error={errors.account_description?.message}
        {...register('account_description')}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <LabeledSelect
          label="Banco"
          options={[NONE_BANK, ...bankOptions]}
          error={errors.bank_id?.message}
          {...register('bank_id', { valueAsNumber: true })}
        />
        <LabeledSelect
          label="Situação"
          placeholder="Selecione…"
          options={statusOptions}
          error={errors.status_id?.message}
          {...register('status_id', { valueAsNumber: true })}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <AuthInput
          label="Tipo de pagamento (código)"
          type="number"
          autoComplete="off"
          error={errors.payment_type_id?.message}
          {...register('payment_type_id', { valueAsNumber: true })}
        />
        <AuthInput
          label="Moeda"
          autoComplete="off"
          error={errors.currency_code?.message}
          {...register('currency_code')}
        />
        <AuthInput
          label="Saldo"
          type="number"
          step="0.01"
          autoComplete="off"
          error={errors.balance_amount?.message}
          {...register('balance_amount', { valueAsNumber: true })}
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
