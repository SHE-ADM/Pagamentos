// src/pages/ContasNovaPage.tsx
// Página "Cadastro de contas" — lançamento RÁPIDO de contas a pagar via Next API
// (createConta). A escrita não passa pelo REST direto do Supabase (RLS só-leitura
// para authenticated); a Next API grava com service_role.
import { useState } from 'react';
import type { FinancialAccountControlCreate } from '@sheild/shared';
import { createConta } from '../services/contas';
import { getErrorMessage } from '../lib/getErrorMessage';
import ContaForm from '../components/organisms/ContaForm';
import Alert from '../components/atoms/Alert';

export default function ContasNovaPage() {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0); // remonta o form p/ limpar após sucesso

  const handleSubmit = async (data: FinancialAccountControlCreate) => {
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const conta = await createConta(data);
      setNotice(`Conta lançada com sucesso (id ${conta.id}).`);
      setFormKey((k) => k + 1);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-gray-200 bg-white">
        <h1 className="text-base font-semibold text-gray-900">Cadastro de contas</h1>
        <p className="text-xs text-gray-500 mt-0.5">Lançamento rápido de contas a pagar</p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {notice && (
          <Alert variant="success" className="mb-4 max-w-3xl mx-auto">
            {notice}
          </Alert>
        )}
        <div className="card p-6 max-w-3xl mx-auto">
          <ContaForm
            key={formKey}
            mode="create"
            onSubmit={handleSubmit}
            submitError={error}
            submitting={submitting}
          />
        </div>
      </div>
    </div>
  );
}
