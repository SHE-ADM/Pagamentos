// src/components/organisms/ContaForm.tsx
// Organism — formulário de conta a pagar (criação rápida / edição). Estado via
// react-hook-form; validação no submit com financialAccountControlCreateSchema
// (@sheild/shared). Fornecedor via react-select (SupplierSelect). Tipo de documento
// e tipo de pagamento são selects de APENAS CONSULTA (valores pré-definidos dos enums,
// obrigatórios). O envio (POST/PATCH na Next API) é responsabilidade do pai.
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  financialAccountControlCreateSchema,
  DOCUMENT_TYPES,
  PAYMENT_METHODS,
  type FinancialAccountControl,
  type FinancialAccountControlCreate,
} from '@sheild/shared';
import AuthInput from '../atoms/AuthInput';
import Alert from '../atoms/Alert';
import SupplierSelect from '../molecules/SupplierSelect';

interface ContaFormValues {
  amount: string;
  document_type: string;
  payment_method: string;
  due_date: string;
  issue_date: string;
  invoice_number: string;
  description: string;
  barcode: string;
}

interface ContaFormProps {
  mode: 'create' | 'edit';
  defaultValues?: FinancialAccountControl;
  onSubmit: (data: FinancialAccountControlCreate) => Promise<void>;
  onCancel?: () => void;
  submitError?: string | null;
  submitting?: boolean;
}

function toFormValues(c?: FinancialAccountControl): ContaFormValues {
  return {
    amount: c?.amount != null ? String(c.amount) : '',
    document_type: c?.document_type ?? '',
    payment_method: c?.payment_method ?? '',
    due_date: c?.due_date ?? '',
    issue_date: c?.issue_date ?? '',
    invoice_number: c?.invoice_number ?? '',
    description: c?.description ?? '',
    barcode: c?.barcode ?? '',
  };
}

const blankToNull = (v: string): string | null => (v.trim() ? v.trim() : null);

export default function ContaForm({ mode, defaultValues, onSubmit, onCancel, submitError, submitting = false }: Readonly<ContaFormProps>) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<ContaFormValues>({ defaultValues: toFormValues(defaultValues) });

  const [skSupplier, setSkSupplier] = useState<number | null>(defaultValues?.sk_supplier ?? null);
  const [supplierError, setSupplierError] = useState<string | null>(null);

  const submit = handleSubmit(async (raw) => {
    setSupplierError(null);
    let ok = true;
    if (skSupplier == null) {
      setSupplierError('Selecione um fornecedor');
      ok = false;
    }
    if (!raw.document_type) {
      setError('document_type', { message: 'Selecione o tipo de documento' });
      ok = false;
    }
    if (!raw.payment_method) {
      setError('payment_method', { message: 'Selecione o tipo de pagamento' });
      ok = false;
    }

    const payload = {
      sk_supplier: skSupplier ?? undefined,
      amount: raw.amount ? Number(raw.amount.replace(',', '.')) : undefined,
      document_type: raw.document_type || null,
      payment_method: raw.payment_method || null,
      due_date: blankToNull(raw.due_date),
      issue_date: blankToNull(raw.issue_date),
      invoice_number: blankToNull(raw.invoice_number),
      description: blankToNull(raw.description),
      barcode: blankToNull(raw.barcode),
    };

    const parsed = financialAccountControlCreateSchema.safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        // Mensagem amigável para o fornecedor (o Zod diria "expected number, received undefined").
        if (field === 'sk_supplier') setSupplierError('Selecione um fornecedor');
        else if (typeof field === 'string' && field in raw) setError(field as keyof ContaFormValues, { message: issue.message });
      }
      ok = false;
    }

    if (!ok || !parsed.success) return;
    await onSubmit(parsed.data);
  });

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {submitError && <Alert variant="error">{submitError}</Alert>}

      <SupplierSelect
        id="conta-supplier"
        label="Fornecedor"
        value={skSupplier}
        defaultLabel={defaultValues?.supplier?.trade_name ?? defaultValues?.supplier?.legal_name}
        onChange={setSkSupplier}
        error={supplierError ?? undefined}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <AuthInput
          label="Valor (R$)"
          type="number"
          step="0.01"
          min="0"
          placeholder="0,00"
          error={errors.amount?.message}
          {...register('amount')}
        />
        <AuthInput label="Vencimento" type="date" error={errors.due_date?.message} {...register('due_date')} />

        <label className="block">
          <span className="block text-sm font-medium text-gray-700 mb-1">Tipo de documento</span>
          <select
            aria-invalid={errors.document_type ? true : undefined}
            className="input"
            {...register('document_type')}
          >
            <option value="">Selecione…</option>
            {DOCUMENT_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          {errors.document_type && <span className="block mt-1 text-xs text-status-error-fg">{errors.document_type.message}</span>}
        </label>

        <label className="block">
          <span className="block text-sm font-medium text-gray-700 mb-1">Tipo de pagamento</span>
          <select
            aria-invalid={errors.payment_method ? true : undefined}
            className="input"
            {...register('payment_method')}
          >
            <option value="">Selecione…</option>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          {errors.payment_method && <span className="block mt-1 text-xs text-status-error-fg">{errors.payment_method.message}</span>}
        </label>

        <AuthInput label="Emissão" type="date" error={errors.issue_date?.message} {...register('issue_date')} />
        <AuthInput label="Nº do documento" error={errors.invoice_number?.message} {...register('invoice_number')} />
        <AuthInput label="Código de barras" error={errors.barcode?.message} {...register('barcode')} />
        <AuthInput label="Descrição" error={errors.description?.message} {...register('description')} />
      </div>

      <div className="flex justify-end gap-2 pt-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className="btn" disabled={submitting}>
            Cancelar
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Salvando…' : mode === 'create' ? 'Lançar conta' : 'Salvar alterações'}
        </button>
      </div>
    </form>
  );
}
