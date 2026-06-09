// Página informativa mínima — esta app é primariamente uma API (route handlers).
export default function Home() {
  return (
    <main style={{ padding: '2rem', fontFamily: 'ui-monospace, monospace' }}>
      <h1>pagamentos — API backend</h1>
      <p>Camada de dados/CRUD (Next.js + TypeScript). Endpoints disponíveis:</p>
      <ul>
        <li>
          <code>GET /api/health</code> — status da API e do serviço Python
        </li>
        <li>
          <code>POST /api/emails/read</code> — dispara a leitura IMAP (ponte para o Flask)
        </li>
      </ul>
    </main>
  );
}
