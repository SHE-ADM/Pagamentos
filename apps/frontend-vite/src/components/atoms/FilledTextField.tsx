import { useId, useState, forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '../../lib/cn';

interface FilledTextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  endAdornment?: ReactNode;
}

// Wrapper do campo — variante booleana `focused` alterna fundo/borda.
const fieldWrapper = cva('flex items-center h-10 px-3.5 gap-2.5 rounded-lg border-2 transition-colors', {
  variants: {
    focused: {
      true: 'bg-loginGreen-fieldFocus border-loginGreen-borderFocus',
      false: 'bg-loginGreen-field border-loginGreen-borderField',
    },
  },
  defaultVariants: { focused: false },
});

// Atom — campo de formulario com label, fundo preenchido e estado de foco.
// forwardRef necessário para integração com react-hook-form Controller.
const FilledTextField = forwardRef<HTMLInputElement, FilledTextFieldProps>(
  ({ label, error, endAdornment, id, ...inputProps }, ref) => {
    const [focused, setFocused] = useState(false);
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const errorId = `${inputId}-error`;

    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={inputId} className="text-sm font-bold text-loginGreen-ink">{label}</label>
        <div className={cn(fieldWrapper({ focused }))}>
          <input
            {...inputProps}
            id={inputId}
            ref={ref}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
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
        {error && <span id={errorId} className="text-xs text-status-error-fg">{error}</span>}
      </div>
    );
  },
);

FilledTextField.displayName = 'FilledTextField';

export default FilledTextField;
