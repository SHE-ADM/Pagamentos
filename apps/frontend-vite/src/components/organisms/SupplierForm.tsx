// src/components/organisms/SupplierForm.tsx
// Organism — formulário de cadastro/edição de fornecedor. Estado e validação via
// react-hook-form + os schemas Zod compartilhados (@sheild/shared) como fonte única.
// A validação roda no submit com safeParse (evita o atrito de tipos do zodResolver
// com os transforms de CNPJ/CPF) e mapeia os issues para erros de campo + a regra
// "ao menos um identificador". O envio efetivo (POST/PATCH na Next API) é do pai.
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  supplierCreateSchema,
  supplierUpdateSchema,
  type Supplier,
  type SupplierCreateInput,
} from '@sheild/shared';
import AuthInput from '../atoms/AuthInput';
import Alert from '../atoms/Alert';
import CostCenterSelect from '../molecules/CostCenterSelect';
import ChartAccountSelect from '../molecules/ChartAccountSelect';

// supplierCreate/UpdateSchema inferem o MESMO tipo (mesmos campos); um só basta.
interface SupplierFormValues {
  legal_name?: string;
  trade_name?: string;
  cnpj?: string;
  cpf?: string;
  email?: string;
  email2?: string;
  email3?: string;
  email4?: string;
  phone_ddd1?: string;
  phone1?: string;
  phone_ddd2?: string;
  phone2?: string;
  whatsapp1?: string;
  whatsapp2?: string;
  pix_key1?: string;
  pix_key2?: string;
}

interface SupplierFormProps {
  mode: 'create' | 'edit';
  defaultValues?: Partial<Supplier>;
  onSubmit: (data: SupplierCreateInput) => Promise<void>;
  onCancel: () => void;
  /** Erro vindo do backend (ex.: 409 CNPJ duplicado) exibido no topo do formulário. */
  submitError?: string | null;
  submitting?: boolean;
}

// Converte os campos do registro (nullable) para valores de formulário (string).
function toFormValues(s?: Partial<Supplier>): SupplierFormValues {
  return {
    legal_name: s?.legal_name ?? '',
    trade_name: s?.trade_name ?? '',
    cnpj: s?.cnpj ?? '',
    cpf: s?.cpf ?? '',
    email: s?.email ?? '',
    email2: s?.email2 ?? '',
    email3: s?.email3 ?? '',
    email4: s?.email4 ?? '',
    phone_ddd1: s?.phone_ddd1 ?? '',
    phone1: s?.phone1 ?? '',
    phone_ddd2: s?.phone_ddd2 ?? '',
    phone2: s?.phone2 ?? '',
    whatsapp1: s?.whatsapp1 ?? '',
    whatsapp2: s?.whatsapp2 ?? '',
    pix_key1: s?.pix_key1 ?? '',
    pix_key2: s?.pix_key2 ?? '',
  };
}

const FIELD_KEYS: (keyof SupplierFormValues)[] = [
  'legal_name', 'trade_name', 'cnpj', 'cpf', 'email', 'email2', 'email3', 'email4',
  'phone_ddd1', 'phone1', 'phone_ddd2', 'phone2', 'whatsapp1', 'whatsapp2', 'pix_key1', 'pix_key2',
];

// '' → omitido: campos opcionais vazios não devem disparar validação de formato.
// Itera as chaves conhecidas (Object.entries perderia o tipo, virando `any`).
function clean(values: SupplierFormValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of FIELD_KEYS) {
    const trimmed = values[k]?.trim();
    if (trimmed) out[k] = trimmed;
  }
  return out;
}

const FIELDS: { name: keyof SupplierFormValues; label: string; type?: string }[] = [
  { name: 'legal_name', label: 'Razão social' },
  { name: 'trade_name', label: 'Nome fantasia' },
  { name: 'cnpj', label: 'CNPJ (só dígitos)' },
  { name: 'cpf', label: 'CPF (só dígitos)' },
  { name: 'email', label: 'E-mail', type: 'email' },
  { name: 'email2', label: 'E-mail 2', type: 'email' },
  { name: 'email3', label: 'E-mail 3', type: 'email' },
  { name: 'email4', label: 'E-mail 4', type: 'email' },
  { name: 'phone_ddd1', label: 'DDD (fone 1)' },
  { name: 'phone1', label: 'Telefone 1' },
  { name: 'phone_ddd2', label: 'DDD (fone 2)' },
  { name: 'phone2', label: 'Telefone 2' },
  { name: 'whatsapp1', label: 'WhatsApp 1' },
  { name: 'whatsapp2', label: 'WhatsApp 2' },
  { name: 'pix_key1', label: 'Chave PIX 1' },
  { name: 'pix_key2', label: 'Chave PIX 2' },
];

// id 0 = "não informado" (sentinela do banco) → tratado como vazio na UI.
const orNull = (id: number | null | undefined): number | null => id || null;

// Fonte estrutural dos rótulos da classificação default (modo edição): cost_center_id/
// chart_account_id + embeds dos cadastros (GET /suppliers/:sk traz o JOIN).
type ClassificationSource = Partial<Pick<Supplier, 'cost_center_id' | 'chart_account_id' | 'cost_center' | 'chart_account'>>;

// Rótulo do centro de custo já vinculado — usa o embed do JOIN; undefined quando não
// há classificação (id 0/ausente) ou quando o embed não veio (lista sem JOIN → cai no #id).
const costCenterDefaultLabel = (c?: ClassificationSource): string | undefined => {
  if (!c?.cost_center_id) return undefined;
  return c.cost_center?.cost_center_description ?? c.cost_center?.cost_center_code ?? `#${c.cost_center_id}`;
};

const chartAccountDefaultLabel = (c?: ClassificationSource): string | undefined => {
  if (!c?.chart_account_id) return undefined;
  return c.chart_account?.account_description ?? c.chart_account?.account_code ?? `#${c.chart_account_id}`;
};

export default function SupplierForm({
  mode,
  defaultValues,
  onSubmit,
  onCancel,
  submitError,
  submitting = false,
}: Readonly<SupplierFormProps>) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<SupplierFormValues>({ defaultValues: toFormValues(defaultValues) });

  // Erro da regra "ao menos um identificador" (refine sem path no schema de criação).
  const [identifierError, setIdentifierError] = useState<string | null>(null);

  // Classificação contábil DEFAULT do fornecedor — FKs cost_center_id / chart_account_id.
  // id 0 (sentinela "não informado") aparece vazio no select. A `key` do form (sk_supplier,
  // em SuppliersPage) garante o remonte por fornecedor, então não é preciso sincronizar
  // o estado dos selects via efeito.
  const [costCenterId, setCostCenterId] = useState<number | null>(orNull(defaultValues?.cost_center_id));
  const [chartAccountId, setChartAccountId] = useState<number | null>(orNull(defaultValues?.chart_account_id));

  // Cascata: trocar (ou limpar) o centro de custo zera o plano de contas, que pode não
  // pertencer ao novo centro. O ChartAccountSelect remonta via `key={costCenterId}`.
  const handleCostCenterChange = (id: number | null) => {
    setCostCenterId(id);
    setChartAccountId(null);
  };

  const submit = handleSubmit(async (raw) => {
    setIdentifierError(null);
    const schema = mode === 'create' ? supplierCreateSchema : supplierUpdateSchema;
    // Classificação sempre enviada (0 quando não informada) — cobre tanto definir quanto
    // LIMPAR no modo edição (omitir não zeraria a coluna num PATCH parcial).
    const parsed = schema.safeParse({
      ...clean(raw),
      cost_center_id: costCenterId ?? 0,
      chart_account_id: chartAccountId ?? 0,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (typeof field === 'string' && field in raw) {
          setError(field as keyof SupplierFormValues, { message: issue.message });
        } else {
          setIdentifierError(issue.message);
        }
      }
      return;
    }
    await onSubmit(parsed.data);
  });

  // Texto do botão sem ternário aninhado no JSX (regra SonarLint S3358).
  const actionLabel = mode === 'create' ? 'Cadastrar' : 'Salvar alterações';
  const submitLabel = submitting ? 'Salvando…' : actionLabel;

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {submitError && <Alert variant="error">{submitError}</Alert>}
      {identifierError && <Alert variant="warning">{identifierError}</Alert>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {FIELDS.map(({ name, label, type }) => (
          <AuthInput
            key={name}
            label={label}
            type={type ?? 'text'}
            autoComplete="off"
            error={errors[name]?.message}
            {...register(name)}
          />
        ))}
      </div>

      {/* Classificação contábil default (cascata: o plano depende do centro). */}
      <CostCenterSelect
        id="supplier-cost-center"
        label="Centro de custo"
        value={costCenterId}
        defaultLabel={costCenterDefaultLabel(defaultValues)}
        onChange={handleCostCenterChange}
      />

      <ChartAccountSelect
        // Remonta ao trocar o centro de custo (reinicia + recarrega as opções do novo centro).
        key={`chart-${costCenterId ?? 'none'}`}
        id="supplier-chart-account"
        label="Plano de contas"
        value={chartAccountId}
        costCenterId={costCenterId}
        defaultLabel={chartAccountDefaultLabel(defaultValues)}
        onChange={setChartAccountId}
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
