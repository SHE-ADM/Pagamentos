import { useEffect, useRef } from 'react';

interface SelectCheckboxProps {
  checked: boolean;
  /** Estado parcial (alguns selecionados) — só faz sentido no "selecionar todos". */
  indeterminate?: boolean;
  onToggle: (next: boolean) => void;
  /** Nome acessível obrigatório — a célula do grid não tem label visível. */
  ariaLabel: string;
}

/**
 * Checkbox de SELEÇÃO de linha do DataGrid (cabeçalho "selecionar todos" + por linha).
 * Distinto do `CheckToggle` (curadoria de NF/Boleto): este controla `rowSelection` do
 * TanStack, suporta estado `indeterminate` (aplicado via ref, pois é uma propriedade do
 * DOM sem atributo HTML) e impede que o clique borbulhe para o `onRowClick` da linha.
 */
export default function SelectCheckbox({
  checked,
  indeterminate = false,
  onToggle,
  ariaLabel,
}: Readonly<SelectCheckboxProps>) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      aria-label={ariaLabel}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onToggle(e.target.checked)}
      className="h-4 w-4 cursor-pointer align-middle accent-brand"
    />
  );
}
