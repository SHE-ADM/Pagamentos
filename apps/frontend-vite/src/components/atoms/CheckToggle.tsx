interface CheckToggleProps {
  checked: boolean;
  onToggle: (next: boolean) => void;
  /** Nome acessível obrigatório — célula de grid não tem label visível. */
  ariaLabel: string;
  disabled?: boolean;
}

/**
 * Checkbox de curadoria usado nas células do DataGrid (ex.: "Tem NF ?" e "Tem
 * Boleto" em /consulta). `stopPropagation` no clique impede que marcar/desmarcar
 * dispare o `onRowClick` do DataGrid (que abre/fecha o painel de detalhe da linha).
 */
export default function CheckToggle({
  checked,
  onToggle,
  ariaLabel,
  disabled = false,
}: Readonly<CheckToggleProps>) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onToggle(e.target.checked)}
      className="h-4 w-4 cursor-pointer align-middle accent-brand disabled:cursor-not-allowed disabled:opacity-50"
    />
  );
}
