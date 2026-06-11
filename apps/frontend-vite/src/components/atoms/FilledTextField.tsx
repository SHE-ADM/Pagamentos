import { useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '../../lib/cn';

interface FilledTextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  endAdornment?: ReactNode;
}

// Wrapper do campo — variante booleana `focused` alterna fundo/borda.
const fieldWrapper = cva('flex items-center h-12 px-3.5 gap-2.5 rounded-lg border-2 transition-colors', {
  variants: {
    focused: {
      true: 'bg-loginGreen-fieldFocus border-loginGreen-borderFocus',
      false: 'bg-loginGreen-field border-loginGreen-borderField',
    },
  },
  defaultVariants: { focused: false },
});

// Atom — campo de formulario com label, fundo preenchido e estado de foco.
// Aceita `endAdornment` (ex.: botão olho) renderizado à direita do input.
export default function FilledTextField({ label, error, endAdornment, ...inputProps }: Readonly<FilledTextFieldProps>) {
  const [focused, setFocused] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-bold text-loginGreen-ink">{label}</label>
      <div className={cn(fieldWrapper({ focused }))}>
        <input
          {...inputProps}
          onFocus={(e) => {
            setFocused(true);
            inputProps.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            inputProps.onBlur?.(e);
          }}
          className="flex-1 bg-transparent border-0 outline-none text-sm font-medium text-loginGreen-ink placeholder:text-loginGreen-placeholder min-w-0"
        />
        {endAdornment}
      </div>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
