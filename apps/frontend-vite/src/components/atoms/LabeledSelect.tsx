import { forwardRef, useId, type SelectHTMLAttributes } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '../../lib/cn';

export interface SelectOption {
  value: number | string;
  label: string;
}

interface LabeledSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  error?: string;
  options: SelectOption[];
  /** Opção neutra inicial (ex.: "Selecione…"), com value vazio. */
  placeholder?: string;
}

// Mesma base visual do AuthInput (.input) — estado de erro via cva booleano.
const labeledSelect = cva('input', {
  variants: {
    invalid: {
      true: 'border-status-error-border focus:ring-status-error-border focus:border-status-error-fg',
      false: '',
    },
  },
  defaultVariants: { invalid: false },
});

// Atom — <select> rotulado: label + select + erro inline. forwardRef para o
// register do react-hook-form. Os <option> vêm de `options` ({ value, label }).
// Associação via htmlFor/id (não envolvendo o select) — o texto das <option> não
// deve poluir o nome acessível do controle.
const LabeledSelect = forwardRef<HTMLSelectElement, LabeledSelectProps>(
  ({ label, error, options, placeholder, className, id, ...selectProps }, ref) => {
    const generatedId = useId();
    const selectId = id ?? generatedId;
    const errorId = useId();
    return (
      <div className="block">
        <label htmlFor={selectId} className="block text-sm font-medium text-gray-700 mb-1">
          {label}
        </label>
        <select
          id={selectId}
          ref={ref}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={cn(labeledSelect({ invalid: !!error }), className)}
          {...selectProps}
        >
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {error && (
          <span id={errorId} className="block mt-1 text-xs text-status-error-fg">
            {error}
          </span>
        )}
      </div>
    );
  },
);

LabeledSelect.displayName = 'LabeledSelect';

export default LabeledSelect;
