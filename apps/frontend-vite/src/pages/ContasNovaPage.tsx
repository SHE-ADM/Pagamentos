// src/pages/ContasNovaPage.tsx
// Página "Cadastro de contas" — lançamento RÁPIDO de contas a pagar via Next API
// (createConta). A escrita não passa pelo REST direto do Supabase (RLS só-leitura
// para authenticated); a Next API grava com service_role.
import { useRef, useState, useEffect } from 'react';
import type { FinancialAccountControlCreate } from '@sheild/shared';
import { createConta } from '../services/contas';
import { uploadContaAttachments } from '../services/contaAttachments';
import { getErrorMessage } from '../lib/getErrorMessage';
import ContaForm, { type ContaFormHandle } from '../components/organisms/ContaForm';
import Alert from '../components/atoms/Alert';

const NOTICE_DISMISS_MS = 5000; // banner de sucesso some sozinho após este tempo

export default function ContasNovaPage() {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Falha PARCIAL (conta criada, algum anexo não subiu) não é erro nem sucesso limpo:
  // banner próprio, para não mentir que deu tudo certo nem sugerir que a conta se perdeu.
  const [warning, setWarning] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // Lançamento em série: após lançar, o form PERMANECE com os demais campos; só o
  // fornecedor é limpo e refocado (via handle do ContaForm), em vez de remontar tudo.
  const formRef = useRef<ContaFormHandle>(null);

  // Devolve ao ContaForm a fila que deve PERMANECER (ver o contrato de `onSubmit` lá).
  const handleSubmit = async (data: FinancialAccountControlCreate, files: File[]): Promise<File[] | void> => {
    setSubmitting(true);
    setError(null);
    setNotice(null);
    setWarning(null);
    try {
      // A conta vem PRIMEIRO: o upload precisa do id. Enviar antes exigiria uma área de
      // staging e um coletor de órfãos — aqui, abandonar o formulário não deixa lixo.
      const conta = await createConta(data);

      if (files.length) {
        setProgress({ done: 0, total: files.length });
        const { failed } = await uploadContaAttachments(conta.id, files, (done, total) =>
          setProgress({ done, total }),
        );
        setProgress(null);
        if (failed.length) {
          // A conta EXISTE — dizer só "erro" faria o usuário lançá-la de novo, duplicando.
          // O form é remontado (fila zerada): reenviar aqui recriaria a conta, então o
          // caminho de recuperação é a edição em /consulta, não este formulário.
          setWarning(
            `Conta lançada (id ${conta.id}), mas ${failed.length} anexo(s) não foram enviados: ` +
              `${failed.map((f) => f.file.name).join(', ')}. Anexe pela edição da conta em Gestão de contas.`,
          );
          // A conta EXISTE — segue o lançamento em série (limpa só o fornecedor e foca).
          formRef.current?.resetSupplier();
          return;
        }
      }

      const suffix = files.length ? ` com ${files.length} anexo(s)` : '';
      setNotice(`Conta lançada com sucesso (id ${conta.id})${suffix}.`);
      // Lançamento em série: mantém os campos, limpa só o fornecedor e o refoca.
      formRef.current?.resetSupplier();
    } catch (e) {
      // A conta NÃO foi criada (o erro é engolido aqui, não sobe ao form): devolver a fila
      // preserva os arquivos já escolhidos para o usuário corrigir e submeter de novo.
      setError(getErrorMessage(e));
      return files;
    } finally {
      setProgress(null);
      setSubmitting(false);
    }
  };

  // Auto-dispensa o banner de sucesso (evita `notice` stale entre lançamentos).
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_DISMISS_MS);
    return () => clearTimeout(t);
  }, [notice]);

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
        {warning && (
          <Alert variant="warning" className="mb-4 max-w-3xl mx-auto">
            {warning}
          </Alert>
        )}
        {progress && (
          <Alert variant="info" className="mb-4 max-w-3xl mx-auto">
            Enviando anexos… ({progress.done}/{progress.total})
          </Alert>
        )}
        <div className="card p-6 max-w-3xl mx-auto">
          <ContaForm
            ref={formRef}
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
