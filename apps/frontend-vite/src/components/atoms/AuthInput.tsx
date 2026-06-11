import type { InputHTMLAttributes } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '../../lib/cn';

interface AuthInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
}

// Variante booleana `invalid` — estado de erro derivado de `!!error`.
const authInput = cva('input', {
  variants: {
    invalid: {
      true: 'border-red-300 focus:ring-red-200 focus:border-red-400',
      false: '',
    },
  },
  defaultVariants: { invalid: false },
});

// Atom — campo de formulario das telas de autenticacao: label + input
// controlado + mensagem de erro inline.
export default function AuthInput({ label, error, className, ...inputProps }: Readonly<AuthInputProps>) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-gray-700 mb-1">{label}</span>
      <input className={cn(authInput({ invalid: !!error }), className)} {...inputProps} />
      {error && <span className="block mt-1 text-xs text-red-600">{error}</span>}
    </label>
  );
}
