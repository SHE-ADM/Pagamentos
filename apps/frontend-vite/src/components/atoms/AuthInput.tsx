import { forwardRef, useId, type InputHTMLAttributes } from 'react';
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
      true: 'border-status-error-border focus:ring-status-error-border focus:border-status-error-fg',
      false: '',
    },
  },
  defaultVariants: { invalid: false },
});

// Atom — campo de formulario das telas de autenticacao: label + input
// controlado + mensagem de erro inline.
// forwardRef necessário para integração com react-hook-form Controller.
const AuthInput = forwardRef<HTMLInputElement, AuthInputProps>(
  ({ label, error, className, ...inputProps }, ref) => {
    const errorId = useId();
    return (
      <label className="block">
        <span className="block text-sm font-medium text-gray-700 mb-1">{label}</span>
        <input
          ref={ref}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={cn(authInput({ invalid: !!error }), className)}
          {...inputProps}
        />
        {error && <span id={errorId} className="block mt-1 text-xs text-status-error-fg">{error}</span>}
      </label>
    );
  },
);

AuthInput.displayName = 'AuthInput';

export default AuthInput;
