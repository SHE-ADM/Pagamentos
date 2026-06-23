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
  };
}

const FIELD_KEYS: (keyof SupplierFormValues)[] = [
  'legal_name', 'trade_name', 'cnpj', 'cpf', 'email', 'email2', 'email3', 'email4',
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
];

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

  const submit = handleSubmit(async (raw) => {
    setIdentifierError(null);
    const schema = mode === 'create' ? supplierCreateSchema : supplierUpdateSchema;
    const parsed = schema.safeParse(clean(raw));
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
