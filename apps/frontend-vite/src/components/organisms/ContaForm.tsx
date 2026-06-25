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
import CostCenterSelect from '../molecules/CostCenterSelect';
import ChartAccountSelect from '../molecules/ChartAccountSelect';

// Opções dos selects de enum ordenadas alfabeticamente (pt-BR) — os valores são os
// mesmos dos CHECK do banco; só a ordem de exibição muda.
const DOCUMENT_TYPE_OPTIONS = [...DOCUMENT_TYPES].sort((a, b) => a.localeCompare(b, 'pt-BR'));
const PAYMENT_METHOD_OPTIONS = [...PAYMENT_METHODS].sort((a, b) => a.localeCompare(b, 'pt-BR'));

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

// Data corrente no formato YYYY-MM-DD (local) — default de emissão/vencimento ao
// INCLUIR uma conta. Usa a data local (não UTC) para não "voltar um dia" à noite.
const todayISO = (): string => {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
};

function toFormValues(c?: FinancialAccountControl): ContaFormValues {
  // Inclusão (sem `c`): emissão e vencimento já vêm com a data de hoje. Edição:
  // mantém os valores da conta (sem fabricar data quando o campo está vazio).
  const dateDefault = c ? '' : todayISO();
  return {
    amount: c?.amount != null ? String(c.amount) : '',
    document_type: c?.document_type ?? '',
    payment_method: c?.payment_method ?? '',
    due_date: c?.due_date ?? dateDefault,
    issue_date: c?.issue_date ?? dateDefault,
    invoice_number: c?.invoice_number ?? '',
    description: c?.description ?? '',
    barcode: c?.barcode ?? '',
  };
}

const blankToNull = (v: string): string | null => (v.trim() ? v.trim() : null);

// id 0 = "não informado" (sentinela do banco) → tratado como vazio na UI.
const orNull = (id: number | null | undefined): number | null => (id ? id : null);

// Rótulo do centro de custo já vinculado (modo edição) — usa o embed do JOIN;
// undefined quando não há classificação (id 0/ausente).
const costCenterDefaultLabel = (c?: FinancialAccountControl): string | undefined => {
  if (!c?.cost_center_id) return undefined;
  return c.cost_center?.cost_center_description ?? c.cost_center?.cost_center_code ?? `#${c.cost_center_id}`;
};

const chartAccountDefaultLabel = (c?: FinancialAccountControl): string | undefined => {
  if (!c?.chart_account_id) return undefined;
  return c.chart_account?.account_description ?? c.chart_account?.account_code ?? `#${c.chart_account_id}`;
};

export default function ContaForm({ mode, defaultValues, onSubmit, onCancel, submitError, submitting = false }: Readonly<ContaFormProps>) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<ContaFormValues>({ defaultValues: toFormValues(defaultValues) });

  const [skSupplier, setSkSupplier] = useState<number | null>(defaultValues?.sk_supplier ?? null);
  const [supplierError, setSupplierError] = useState<string | null>(null);
  // Classificação contábil (opcional) — FKs cost_center_id / chart_account_id.
  // id 0 (sentinela "não informado") aparece vazio no select.
  const [costCenterId, setCostCenterId] = useState<number | null>(orNull(defaultValues?.cost_center_id));
  const [chartAccountId, setChartAccountId] = useState<number | null>(orNull(defaultValues?.chart_account_id));

  // Cascata: trocar (ou limpar) o centro de custo zera o plano de contas, que pode não
  // pertencer ao novo centro. O ChartAccountSelect remonta via `key={costCenterId}`.
  const handleCostCenterChange = (id: number | null) => {
    setCostCenterId(id);
    setChartAccountId(null);
  };

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
      // Não informado → 0 (sentinela). A coluna é NOT NULL DEFAULT 0 (migration 048).
      cost_center_id: costCenterId ?? 0,
      chart_account_id: chartAccountId ?? 0,
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

      <AuthInput label="Descrição" error={errors.description?.message} {...register('description')} />

      <CostCenterSelect
        id="conta-cost-center"
        label="Centro de custo"
        value={costCenterId}
        defaultLabel={costCenterDefaultLabel(defaultValues)}
        onChange={handleCostCenterChange}
      />

      <ChartAccountSelect
        // Remonta ao trocar o centro de custo: reinicia o select (vazio) e recarrega as
        // opções do novo centro, sem efeito de sincronização de estado.
        key={`chart-${costCenterId ?? 'none'}`}
        id="conta-chart-account"
        label="Plano de contas"
        value={chartAccountId}
        costCenterId={costCenterId}
        defaultLabel={chartAccountDefaultLabel(defaultValues)}
        onChange={setChartAccountId}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="block text-sm font-medium text-gray-700 mb-1">Tipo de documento</span>
          <select
            aria-invalid={errors.document_type ? true : undefined}
            className="input"
            {...register('document_type')}
          >
            <option value="">Selecione…</option>
            {DOCUMENT_TYPE_OPTIONS.map((t) => (
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
            {PAYMENT_METHOD_OPTIONS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          {errors.payment_method && <span className="block mt-1 text-xs text-status-error-fg">{errors.payment_method.message}</span>}
        </label>

        <AuthInput label="Nº do documento" error={errors.invoice_number?.message} {...register('invoice_number')} />
        <AuthInput label="Emissão" type="date" error={errors.issue_date?.message} {...register('issue_date')} />

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
      </div>

      <AuthInput label="Código de barras" error={errors.barcode?.message} {...register('barcode')} />

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
