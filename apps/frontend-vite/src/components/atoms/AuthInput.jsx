// src/components/atoms/AuthInput.jsx
// Atom — campo de formulario das telas de autenticacao: label + input
// controlado + mensagem de erro inline.

export default function AuthInput({ label, error, className = '', ...inputProps }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-gray-700 mb-1">{label}</span>
      <input className={`input ${error ? 'border-red-300 focus:ring-red-200 focus:border-red-400' : ''} ${className}`} {...inputProps} />
      {error && <span className="block mt-1 text-xs text-red-600">{error}</span>}
    </label>
  )
}
