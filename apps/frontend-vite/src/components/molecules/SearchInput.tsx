// src/components/molecules/SearchInput.tsx
// Molecule — campo de busca com ícone de lupa e botão de limpar (X). O X aparece
// só quando há texto e, ao clicar, zera o valor e devolve o foco ao input. Usado
// pelos grids de cadastro (grupo Tabelas + fornecedores). Estado é do pai (controlado).
import { useRef } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '../../lib/cn';

interface SearchInputProps {
  /** id + name do input (name resolve o alerta de autofill do Chrome). */
  id: string;
  /** Nome acessível (leitores de tela + axe). */
  ariaLabel: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  /** Classe do wrapper (largura). Padrão `w-72`. */
  className?: string;
}

export default function SearchInput({ id, ariaLabel, placeholder, value, onChange, className }: Readonly<SearchInputProps>) {
  const inputRef = useRef<HTMLInputElement>(null);

  const clear = () => {
    onChange('');
    inputRef.current?.focus();
  };

  return (
    <div className={cn('relative', className ?? 'w-72')}>
      <Search
        size={15}
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
      />
      <input
        ref={inputRef}
        id={id}
        name={id}
        aria-label={ariaLabel}
        className="input w-full pl-8 pr-9"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          type="button"
          aria-label="Limpar busca"
          onClick={clear}
          className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
