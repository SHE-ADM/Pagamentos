// src/components/organisms/AiChatWidget.tsx
// Organism — o assistente de IA disponível em TODAS as telas: botão flutuante + painel.
//
// Montado uma única vez no Layout (que só envolve rotas protegidas), então o widget nunca
// aparece nas telas de auth.
//
// O ESTADO DA CONVERSA VIVE AQUI, não no painel: assim fechar e reabrir o assistente preserva a
// conversa da sessão. O painel entra por lazy() — o launcher é um botão, e o parser de markdown
// só é baixado quando o usuário abre o chat de fato.
import { lazy, Suspense, useRef, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { AiChatCancelledError, askAiChat, type ChatEntry } from '../../services/aiChat';
import { getErrorMessage } from '../../lib/getErrorMessage';
import type { PanelFeedback } from './AiChatPanel';

const AiChatPanel = lazy(() => import('./AiChatPanel'));

export default function AiChatWidget() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<PanelFeedback | null>(null);

  /**
   * Geração da conversa. Incrementada em "Nova conversa" — respostas de uma geração anterior são
   * DESCARTADAS ao chegar (não regredir).
   *
   * Sem isto: o usuário envia uma pergunta, clica em "Nova conversa" enquanto a resposta está em
   * voo e, quando ela volta, o `setEntries` a anexa a uma conversa VAZIA — um balão de resposta sem
   * pergunta nenhuma, e um histórico que começa em `assistant`. Uma requisição leva dezenas de
   * segundos, então a janela para isso acontecer é larga, não teórica.
   *
   * Ref e não state: é lido dentro de um callback assíncrono já em execução, onde state seria o
   * valor congelado do render que iniciou a chamada.
   */
  const generationRef = useRef(0);

  /**
   * Controller da requisição em voo — o que o botão "Parar" aborta.
   *
   * NÃO há trava de reentrância aqui de propósito: enquanto `loading` é `true` o painel desabilita
   * campo, botão de envio e "Tentar novamente", e nem renderiza as sugestões; e o React libera
   * eventos discretos já com o estado novo aplicado. Ou seja, a exclusão mútua é estrutural. Uma
   * trava adicional seria código que nenhum caminho alcança — e, por não ter como ser exercitada,
   * daria a impressão de garantir um invariante que na verdade quem mantém é o `loading`.
   */
  const abortRef = useRef<AbortController | null>(null);

  /**
   * Envia a pergunta ao gateway.
   *
   * @param append `true` numa pergunta nova (entra na conversa); `false` no "tentar novamente",
   *   que reusa a última pergunta sem duplicá-la na tela.
   *
   * O histórico é montado a partir da lista COM a pergunta atual: `buildHistory` (dentro de
   * `askAiChat`) só aproveita pares (user, assistant) completos, então a pergunta pendente é
   * descartada sozinha — é o formato que a rota exige (histórico par e alternado, senão 422).
   */
  const ask = async (question: string, append: boolean): Promise<void> => {
    const generation = generationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;

    const next: ChatEntry[] = append ? [...entries, { role: 'user', content: question }] : entries;
    if (append) setEntries(next);
    setFeedback(null);
    setLoading(true);
    try {
      const res = await askAiChat(question, next, controller.signal);
      if (generation !== generationRef.current) return; // conversa trocada: resposta obsoleta
      setEntries((cur) => [
        ...cur,
        {
          role: 'assistant',
          content: res.answer,
          toolCalls: res.tool_calls,
          truncated: res.truncated,
        },
      ]);
    } catch (e) {
      if (generation !== generationRef.current) return;
      // Cancelamento é aviso, não erro: a pergunta fica na conversa e o "Tentar novamente" parte
      // dela. Pintar de vermelho o que o usuário pediu seria culpá-lo pela própria ação.
      setFeedback(
        e instanceof AiChatCancelledError
          ? { variant: 'info', text: 'Consulta cancelada.' }
          : { variant: 'error', text: getErrorMessage(e) },
      );
    } finally {
      abortRef.current = null;
      // O loading é do widget, não da geração: precisa desligar mesmo em resposta descartada,
      // senão o painel fica preso em "Consultando…" para sempre.
      setLoading(false);
    }
  };

  const retry = (): void => {
    const lastQuestion = entries.findLast((m) => m.role === 'user');
    if (lastQuestion) void ask(lastQuestion.content, false);
  };

  const reset = (): void => {
    generationRef.current += 1;
    // Aborta o que estiver em voo: sem isto, "Nova conversa" descartaria a resposta na chegada
    // (guarda de geração) mas o servidor seguiria pagando o loop até o fim.
    abortRef.current?.abort();
    setEntries([]);
    setFeedback(null);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Abrir assistente de contas a pagar"
        title="Assistente de contas a pagar"
        className="fixed bottom-5 right-5 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-brand-dark text-white shadow-lg transition-all hover:shadow-xl hover:shadow-brand/30 focus-visible:ring-2 focus-visible:ring-brand-dark focus-visible:ring-offset-2 active:scale-95 motion-reduce:transition-none"
      >
        <MessageCircle size={20} aria-hidden="true" />
      </button>

      {open && (
        // fallback null: o chunk é pequeno e o <dialog> aparece assim que carrega — um
        // placeholder piscando seria pior que a espera.
        <Suspense fallback={null}>
          <AiChatPanel
            entries={entries}
            loading={loading}
            feedback={feedback}
            onSend={(q) => void ask(q, true)}
            onCancel={() => abortRef.current?.abort()}
            onRetry={retry}
            onReset={reset}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}
