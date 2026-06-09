// src/components/molecules/InlineMessage.jsx
// Molecule — banner de feedback inline (sucesso/erro) para as telas de
// autenticacao. Nunca usar alert() do navegador.

const styles = {
  error:   'bg-red-50 text-red-700',
  success: 'bg-green-50 text-green-700',
}

export default function InlineMessage({ type = 'error', children }) {
  if (!children) return null
  return (
    <p className={`rounded-lg px-3 py-2 text-sm ${styles[type]}`}>
      {children}
    </p>
  )
}
