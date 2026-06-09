import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'pagamentos — API',
  description: 'Camada de dados/CRUD (Next.js + TypeScript) do pipeline de contas a pagar',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
