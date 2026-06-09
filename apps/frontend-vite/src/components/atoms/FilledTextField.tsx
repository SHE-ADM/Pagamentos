import { useState, type InputHTMLAttributes, type ReactNode } from 'react';

interface FilledTextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  endAdornment?: ReactNode;
}

// Atom — campo de formulario com label, fundo preenchido e estado de foco.
// Aceita `endAdornment` (ex.: botão olho) renderizado à direita do input.
export default function FilledTextField({ label, error, endAdornment, ...inputProps }: FilledTextFieldProps) {
  const [focused, setFocused] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-bold text-loginGreen-ink">{label}</label>
      <div
        className={`flex items-center h-12 px-3.5 gap-2.5 rounded-lg border-2 transition-colors
        ${
          focused
            ? 'bg-loginGreen-fieldFocus border-loginGreen-borderFocus'
            : 'bg-loginGreen-field border-loginGreen-borderField'
        }`}
      >
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
