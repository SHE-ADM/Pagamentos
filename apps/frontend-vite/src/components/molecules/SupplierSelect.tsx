// src/components/molecules/SupplierSelect.tsx
// Molecule — seletor de fornecedor com react-select (AsyncCreatable): pesquisa
// fornecedores existentes na Next API e PERMITE incluir um novo inline (creatable),
// retornando o sk_supplier escolhido. Usado no formulário de contas.
import { useState } from 'react';
import AsyncCreatableSelect from 'react-select/async-creatable';
import { listSuppliers, createSupplier } from '../../services/suppliers';

interface SupplierOption {
  value: number; // sk_supplier
  label: string;
}

interface SupplierSelectProps {
  /** sk_supplier selecionado (controlado pelo formulário). */
  value: number | null;
  /** Rótulo do fornecedor já selecionado (modo edição) — exibe sem refazer fetch. */
  defaultLabel?: string | null;
  onChange: (sk: number | null) => void;
  label: string;
  error?: string;
  id?: string;
}

const supplierLabel = (s: { trade_name: string | null; legal_name: string | null; cnpj: string | null; sk_supplier: number }): string =>
  s.trade_name ?? s.legal_name ?? s.cnpj ?? `#${s.sk_supplier}`;

// Carrega opções pela busca textual (nome/CNPJ/CPF/e-mails) na Next API, já
// ordenadas alfabeticamente por nome fantasia (sort=name no backend — ordem global,
// não só do subconjunto retornado).
async function loadOptions(input: string): Promise<SupplierOption[]> {
  const { data } = await listSuppliers({ search: input || undefined, limit: 20, sort: 'name' });
  return data.map((s) => ({ value: s.sk_supplier, label: supplierLabel(s) }));
}

export default function SupplierSelect({ value, defaultLabel, onChange, label, error, id }: Readonly<SupplierSelectProps>) {
  const [selected, setSelected] = useState<SupplierOption | null>(
    value == null ? null : { value, label: defaultLabel ?? `#${value}` },
  );
  const [creating, setCreating] = useState(false);

  // Cria um fornecedor novo a partir do texto digitado (apenas nome fantasia) e o seleciona.
  const handleCreate = async (inputValue: string): Promise<void> => {
    setCreating(true);
    try {
      const supplier = await createSupplier({ trade_name: inputValue.trim() });
      const opt: SupplierOption = { value: supplier.sk_supplier, label: supplierLabel(supplier) };
      setSelected(opt);
      onChange(opt.value);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      <span className="block text-sm font-medium text-gray-700 mb-1">{label}</span>
      <AsyncCreatableSelect<SupplierOption>
        inputId={id}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        value={selected}
        isClearable
        isLoading={creating}
        cacheOptions
        defaultOptions
        loadOptions={loadOptions}
        onChange={(opt) => {
          setSelected(opt);
          onChange(opt ? opt.value : null);
        }}
        onCreateOption={handleCreate}
        placeholder="Buscar fornecedor ou digitar para incluir…"
        loadingMessage={() => 'Buscando…'}
        noOptionsMessage={() => 'Digite para buscar um fornecedor'}
        formatCreateLabel={(input) => `Incluir fornecedor "${input}"`}
        classNamePrefix="rs"
        classNames={{
          control: () => 'min-h-[38px] rounded-lg border border-slate-200 bg-white text-sm',
          menu: () => 'rounded-lg border border-slate-200 bg-white shadow-lg text-sm z-20',
          option: ({ isFocused }) => (isFocused ? 'bg-brand/10 px-3 py-2' : 'px-3 py-2'),
        }}
      />
      {error && <span className="block mt-1 text-xs text-status-error-fg">{error}</span>}
    </div>
  );
}
