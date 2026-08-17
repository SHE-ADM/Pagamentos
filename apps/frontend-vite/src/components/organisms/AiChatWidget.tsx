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
import { AiChatCancelledError, askAiChatStream, type ChatEntry } from '../../services/aiChat';
import { getErrorMessage } from '../../lib/getErrorMessage';
import type { PanelFeedback } from './AiChatPanel';
import type { StreamingState } from './aiChatProgress';

const AiChatPanel = lazy(() => import('./AiChatPanel'));

export default function AiChatWidget() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<PanelFeedback | null>(null);

  /**
   * O turno EM ANDAMENTO: texto parcial e ferramentas sendo consultadas.
   *
   * Estado à parte de `entries`, e não uma entrada provisória na conversa: uma entrada parcial
   * entraria no `buildHistory` da pergunta seguinte e um texto pela metade seria enviado ao modelo
   * como se fosse resposta. Só o `answer` canônico do evento `done` vira `ChatEntry`.
   */
  const [streaming, setStreaming] = useState<StreamingState | null>(null);

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
    setStreaming(null);
    setLoading(true);

    /**
     * A MESMA guarda de geração vale para o progresso, não só para a resposta.
     *
     * O streaming emite dezenas de vezes por turno; sem esta checagem, clicar em "Nova conversa"
     * com um turno em voo deixaria o texto parcial da conversa ANTIGA pingando na tela em branco
     * até o abort chegar ao servidor — janela pequena, mas visível, e exatamente o defeito que a
     * guarda de geração existe para impedir no caminho da resposta.
     */
    const vivo = (): boolean => generation === generationRef.current;

    try {
      const res = await askAiChatStream(
        question,
        next,
        {
          onText: (parcial) => {
            if (!vivo()) return;
            setStreaming((s) => ({ tools: s?.tools ?? [], text: parcial }));
          },
          onTool: (name) => {
            if (!vivo()) return;
            setStreaming((s) => ({
              text: s?.text ?? '',
              tools: [...(s?.tools ?? []), { name }],
            }));
          },
          onToolEnd: (name, rows, error) => {
            if (!vivo()) return;
            setStreaming((s) => {
              if (!s) return s;
              const tools = [...s.tools];
              // Fecha a ÚLTIMA pendente com esse nome: o modelo pode disparar a mesma ferramenta
              // duas vezes em paralelo (duas empresas, dois períodos), e casar pelo primeiro
              // encontrado marcaria a chamada errada como concluída.
              for (let i = tools.length - 1; i >= 0; i -= 1) {
                if (tools[i].name === name && tools[i].rows === undefined) {
                  tools[i] = { name, rows, error };
                  break;
                }
              }
              return { ...s, tools };
            });
          },
        },
        controller.signal,
      );
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
      // senão o painel fica preso em "Consultando…" para sempre. O mesmo vale para o parcial —
      // deixá-lo em tela mostraria um texto que não virou resposta, e que ninguém pode reenviar.
      setLoading(false);
      setStreaming(null);
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
    setStreaming(null);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Abrir assistente de contas a pagar"
        title="Assistente de contas a pagar"
        className="fixed bottom-5 right-5 z-30 flex h-12 w-12 items-center justify-center overflow-hidden rounded-full bg-white shadow-lg transition-all hover:shadow-xl hover:shadow-brand/30 focus-visible:ring-2 focus-visible:ring-brand-dark focus-visible:ring-offset-2 active:scale-95 motion-reduce:transition-none"
      >
        {/*
         * A MESMA imagem do favicon (`index.html`) — o logo é a identidade do app, então o
         * lançador do assistente é reconhecido antes de ser lido.
         *
         * `alt=""` (decorativo): quem nomeia o botão é o `aria-label`; um alt com texto seria
         * anunciado junto e duplicaria o nome acessível.
         *
         * O PNG tem fundo BRANCO OPACO (não é transparente) e o disco escuro do logo vai de 3 a
         * 252 dos 256px — daí o `overflow-hidden` + `rounded-full` do botão (recorta os cantos
         * brancos) e o `scale-105` na imagem (come a margem de ~1%, que a 48px apareceria como um
         * fio branco em volta do disco).
         */}
        <img src="/logos/otimotex.png" alt="" className="h-full w-full scale-105 object-cover" />
      </button>

      {open && (
        // fallback null: o chunk é pequeno e o <dialog> aparece assim que carrega — um
        // placeholder piscando seria pior que a espera.
        <Suspense fallback={null}>
          <AiChatPanel
            entries={entries}
            loading={loading}
            streaming={streaming}
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
