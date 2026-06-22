// components/organisms/ResendErrosAction.tsx
// Ação da barra de seleção de /cobranca/erros: reenvia as cobranças selecionadas
// (1 = individual, N = em lote). Confirmação inline antes de disparar (são e-mails
// reais), poll de progresso e desabilitação quando o backend de envio não está
// pronto (sem SMTP/Supabase ou offline) — recebe `ready`/`reason` da página.

import { useEffect, useRef, useState } from 'react';
import { Send, Loader2 } from 'lucide-react';
import { startResend, getResendProgress, type ResendProgress } from '../../services/cobrancaService';
import { getErrorMessage } from '../../lib/getErrorMessage';

const POLL_INTERVAL_MS = 1500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Props {
  /** Ids das linhas de erro selecionadas. */
  ids: number[];
  /** Prontidão do backend de reenvio (probe na página). */
  ready: boolean;
  reason: string | null;
  /** Limpa a seleção do grid (chamado ao concluir). */
  clearSelection: () => void;
  /** Avisa a página ao concluir (para banner + refresh do grid). */
  onFinished: (summary: ResendProgress) => void;
  /** Reporta erro de disparo/poll para a página exibir. */
  onError: (message: string) => void;
}

type Phase = 'idle' | 'confirming' | 'sending';

export default function ResendErrosAction({ ids, ready, reason, clearSelection, onFinished, onError }: Readonly<Props>) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<ResendProgress | null>(null);
  const aliveRef = useRef(true);

  // Guarda contra setState após desmontar (o poll pode estar em voo se a seleção
  // for limpa no meio do envio).
  useEffect(() => () => { aliveRef.current = false; }, []);

  // Botão desabilitado quando o ambiente não está apto a enviar — o motivo vai no title.
  if (!ready) {
    return (
      <button
        type="button"
        disabled
        title={reason ?? 'Reenvio indisponível: backend offline ou não configurado.'}
        className="btn btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Send size={14} /> Reenviar e-mails ({ids.length})
      </button>
    );
  }

  const runResend = async () => {
    setPhase('sending');
    setProgress(null);
    try {
      await startResend(ids);
      // Poll até o job terminar. O backend roda um job por vez; alreadyRunning também cai aqui.
      let last: ResendProgress | null = null;
      for (;;) {
        const p = await getResendProgress();
        if (!aliveRef.current) return;
        setProgress(p);
        last = p;
        if (!p.running) break;
        await sleep(POLL_INTERVAL_MS);
      }
      if (last) onFinished(last);
      clearSelection();
    } catch (e) {
      onError(getErrorMessage(e));
    } finally {
      if (aliveRef.current) {
        setPhase('idle');
        setProgress(null);
      }
    }
  };

  if (phase === 'sending') {
    const done = progress?.done ?? 0;
    const total = progress?.total ?? ids.length;
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-brand">
        <Loader2 size={14} className="animate-spin" />
        Enviando… {done}/{total}
      </span>
    );
  }

  if (phase === 'confirming') {
    return (
      <span className="inline-flex items-center gap-2 text-xs">
        <span className="font-medium text-slate-700">
          Reenviar {ids.length} e-mail{ids.length > 1 ? 's' : ''} de cobrança?
        </span>
        <button type="button" onClick={() => void runResend()} className="btn btn-primary">
          Confirmar
        </button>
        <button type="button" onClick={() => setPhase('idle')} className="btn">
          Cancelar
        </button>
      </span>
    );
  }

  return (
    <button type="button" onClick={() => setPhase('confirming')} className="btn btn-primary">
      <Send size={14} /> Reenviar e-mails ({ids.length})
    </button>
  );
}
