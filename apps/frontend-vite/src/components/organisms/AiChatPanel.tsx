// src/components/organisms/AiChatPanel.tsx
// Organism — o painel do assistente de IA (side sheet à direita). APRESENTACIONAL: recebe a
// conversa e os callbacks; o estado vive no AiChatWidget, para sobreviver a fechar/reabrir.
//
// Carregado por lazy() no widget: o parser de markdown e este painel não entram no bundle
// inicial (o launcher, que fica no Layout, é só um botão).
//
// Acessibilidade: <dialog> NATIVO + showModal() — role/aria-modal, foco inicial (no textarea, via
// autoFocus), trap de foco, Esc (evento `cancel`) e retorno do foco vêm do navegador. Mesmo padrão
// de AttachmentViewer.tsx e dashboard/ExpenseDetailModal.tsx.
import { useEffect, useId, useRef, useState } from 'react';
import { Send, X, RotateCcw, Sparkles, Square, Wrench } from 'lucide-react';
import type { ChatEntry } from '../../services/aiChat';
import Alert from '../atoms/Alert';
import MarkdownMessage from '../molecules/MarkdownMessage';
import { cn } from '../../lib/cn';
import { rotuloDoProgresso, type StreamingState } from './aiChatProgress';

/**
 * Aviso ao usuário no fim da conversa.
 *
 * Uma variante em vez de dois estados (`error` + `cancelled`): o cancelamento não é falha, e um
 * `Alert variant="error"` dizendo "Consulta cancelada" culparia o usuário pelo que ele pediu. Com a
 * variante no dado, o painel não precisa saber POR QUE a mensagem apareceu — só como pintá-la.
 */
export interface PanelFeedback {
  variant: 'error' | 'info';
  text: string;
}

interface AiChatPanelProps {
  entries: readonly ChatEntry[];
  loading: boolean;
  /** Progresso do turno em voo; `null` quando não há nada em andamento. */
  streaming: StreamingState | null;
  feedback: PanelFeedback | null;
  onSend: (question: string) => void;
  /** Aborta a requisição em voo (botão "Parar"). */
  onCancel: () => void;
  /** Reenvia a última pergunta sem duplicá-la na conversa (429 do provedor, timeout, cancelamento). */
  onRetry: () => void;
  onReset: () => void;
  onClose: () => void;
}

/**
 * Perguntas de partida, agrupadas por tema (Onda 1 — docs/roadmap-enriquecimento-dados.md §6).
 *
 * SUGESTÃO É UM CONTRATO: o usuário clica confiando que aquilo responde. Por isso a lista contém
 * SÓ perguntas cobertas por alguma tool e verificadas contra o banco — as do documento de auditoria
 * que dependiam de dado inexistente ficaram de fora, não foram "adaptadas".
 *
 * (A pergunta de auditoria SAIU dessa lista de exclusões na Onda 7: as migrations 117/118 criaram
 * a trilha e as tools que a expõem. As demais seguem fora.)
 *
 * (A pergunta de PONTUALIDADE saiu da lista de exclusões na Onda 9, pelo mesmo motivo: o gatilho
 * era histórico acumulado e ele ocorreu. Quando esta lista foi escrita, 97% das contas pagas
 * traziam a data do backfill da migration 096 e a resposta seria "atraso médio zero" — falso.
 * Medido em 2026-08-13: 218 contas com carimbo real da trigger, 3 semanas contínuas. A cobertura
 * ainda é parcial, e a tool devolve o quanto ficou de fora para o modelo declarar.)
 *
 * Segue fora, e o motivo continua valendo:
 *   - Taxa de sucesso da extração → as falhas nem viram linha em financial_account_control; vivem
 *     em email_control, que nenhuma tool alcança (Onda 2).
 *
 * Cada uma destas está coberta pela bateria de regressão (ai-chat-regression), que é o mesmo
 * artefato: pergunta sugerida é pergunta testada.
 */
const SUGGESTION_GROUPS: ReadonlyArray<{ theme: string; questions: readonly string[] }> = [
  {
    theme: 'Panorama',
    questions: [
      'Como estamos de contas a pagar?',
      'Quanto vence nos próximos 7 dias?',
      'Qual a distribuição das contas vencidas por faixa de atraso?',
      'Quais os 5 maiores fornecedores com contas vencidas?',
    ],
  },
  {
    theme: 'Despesas e custos',
    questions: [
      'Mostre o demonstrativo de custos e despesas do mês',
      'Quanto foi despesa fixa e quanto foi variável neste mês?',
      'Quanto gastamos por centro de custo neste mês?',
      'Quanto pagamos de tributos no período?',
    ],
  },
  {
    theme: 'Compliance',
    questions: [
      'Quais contas têm boleto mas não têm nota fiscal?',
      'Quanto pagamos de juros e multa, e por qual fornecedor?',
      'Quanto capturamos em descontos por antecipação?',
      'Quais contas estão sem centro de custo ou plano de contas definido?',
    ],
  },
  {
    theme: 'Evolução',
    questions: [
      'Como evoluíram os pagamentos mês a mês neste ano?',
      'Qual a diferença entre o que vence e o que saiu de caixa neste mês?',
      'Compare os gastos entre OTIMOTEX TECIDOS, LEBIANCO e OTIMOTEX FARDOS',
    ],
  },
  {
    // Onda 2: a busca alcança os e-mails recebidos, não as contas. A cobertura do corpo é parcial
    // (completo só a partir de 31/07/2026), e o system prompt instrui o modelo a dizer isso em vez
    // de afirmar que o assunto nunca foi mencionado.
    theme: 'E-mails recebidos',
    questions: ['Em quais e-mails falaram sobre reajuste?'],
  },
  {
    // Onda 3: documento fiscal (CT-e/NF-e) NÃO é conta a pagar e não tem valor — o frete já entra
    // como boleto. A pergunta é sobre o que foi EMITIDO/recebido, nunca sobre quanto se gastou.
    theme: 'Documentos fiscais',
    questions: ['Quantos CT-e recebemos neste mês, e de quais transportadoras?'],
  },
  {
    // Onda 7: a trilha COMEÇA em 11/08/2026 (migration 117) — antes disso o sistema só guardava o
    // último editor de cada conta. O system prompt instrui o modelo a dizer isso em vez de
    // concluir que nada mudou, e a distinguir alteração de rotina automática de edição humana.
    theme: 'Auditoria',
    questions: ['Quem alterou o valor ou o vencimento das contas neste mês?'],
  },
  {
    // Onda 9: o gatilho do item "DPO / pontualidade" era histórico pós-096 acumulado, e ele
    // ocorreu — medido em 2026-08-13, 218 contas pagas com carimbo REAL da trigger (33% das
    // pagas), em 3 semanas contínuas, com desvio de verdade (média 2,9 dias nas atrasadas, máximo
    // 31). A cobertura segue PARCIAL: as pagas antes de 29/07 carregam a data do backfill e ficam
    // de fora, e o system prompt manda declarar isso. Continua NÃO sendo DPO — ver a nota acima.
    theme: 'Pontualidade',
    questions: ['Estamos pagando as contas em dia?'],
  },
];

export default function AiChatPanel({
  entries,
  loading,
  streaming,
  feedback,
  onSend,
  onCancel,
  onRetry,
  onReset,
  onClose,
}: Readonly<AiChatPanelProps>) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const hintId = useId();
  // id gerado, não literal: mesmo padrão do resto do projeto (AuthInput/FilledTextField) e imune a
  // colisão se o painel algum dia coexistir com outro. O <label htmlFor> segue ligado a ele, então
  // `getByLabel('Sua pergunta')` (testes e e2e) continua valendo.
  const questionId = useId();
  const [draft, setDraft] = useState('');

  // Abre como modal ao montar. O try/catch cobre o jsdom, que não implementa showModal/close
  // (o fallback deixa o conteúdo visível/acessível no teste); em navegador o catch nunca roda.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    try {
      el.showModal();
    } catch {
      el.open = true;
    }
    return () => {
      try {
        el.close();
      } catch {
        el.open = false;
      }
    };
  }, []);

  // Clique no backdrop fecha. Listener NATIVO no elemento, não onClick no <dialog>: handler de
  // clique em elemento não-interativo é o smell S1082 do SonarCloud, e o onClick do dialog
  // dispararia também para cliques no conteúdo.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const onBackdrop = (e: MouseEvent): void => {
      if (e.target === el) onClose();
    };
    el.addEventListener('click', onBackdrop);
    return () => el.removeEventListener('click', onBackdrop);
  }, [onClose]);

  // Mantém a conversa rolada no fim quando chega mensagem ou o "consultando" aparece; SEM
  // conversa (mount inicial ou depois de "Nova conversa"), rola para o TOPO — é ali que fica a
  // primeira sugestão, e sem este ramo o usuário abria o painel já no fim da lista de sugestões
  // (efeito roda também no mount, com entries.length=0/loading=false — scrollTop virava
  // scrollHeight de um conteúdo que o usuário ainda não pediu para ver).
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = entries.length === 0 && !loading ? 0 : el.scrollHeight;
  }, [entries.length, loading]);

  const submit = (text: string): void => {
    const question = text.trim();
    if (!question || loading) return;
    setDraft('');
    onSend(question);
  };

  const rotuloProgresso = rotuloDoProgresso(streaming);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={onClose}
      className={cn(
        // m-0 + ml-auto: cola o painel à direita (o default do <dialog> é centralizado).
        //
        // LARGURA — 32rem até `lg`, METADE da tela a partir dali. O `w-full` é a largura pedida
        // (o <dialog> modal vive na top layer, então seu bloco contêiner é o viewport) e os
        // `max-w-*` é que a limitam. Em telas estreitas o painel ocupa tudo; a partir de `lg` a
        // conversa ganha o espaço que as tabelas das respostas pediam.
        //
        // O breakpoint é `lg` (64rem) por ARITMÉTICA, não por hábito: 50vw de 1024px são
        // exatamente os 32rem do `max-w-lg`, então a troca é CONTÍNUA — o painel cresce a partir
        // da largura que já tinha. Em `md` (48rem) ele encolheria de 32rem para 24rem ao cruzar o
        // breakpoint, que é o oposto do pedido.
        'm-0 ml-auto h-dvh max-h-dvh w-full max-w-lg lg:max-w-[50vw]',
        'bg-white text-slate-700 shadow-2xl backdrop:bg-black/40',
        'flex flex-col overflow-hidden',
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold text-gray-900">
            <Sparkles size={16} aria-hidden="true" className="text-brand-dark" />
            Assistente de contas a pagar
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Consulta os dados que você já vê pelas telas — nada além disso.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {entries.length > 0 && (
            <button
              type="button"
              onClick={onReset}
              className="btn text-slate-500"
              title="Nova conversa"
            >
              <RotateCcw size={14} aria-hidden="true" /> Nova conversa
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar assistente"
            className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-gray-900"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* role="log" + aria-live: leitor de tela anuncia a resposta que chega. */}
      <div
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-label="Conversa com o assistente"
        className="flex-1 space-y-3 overflow-y-auto bg-gray-50 px-4 py-4"
      >
        {entries.length === 0 && !loading && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Pergunte em português. Alguns exemplos:
            </p>
            {SUGGESTION_GROUPS.map((group) => (
              <div key={group.theme} className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {group.theme}
                </h3>
                {group.questions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => submit(s)}
                    className="block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-sm text-slate-700 transition-colors hover:border-brand hover:bg-slate-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}

        {entries.map((entry, i) => {
          const key = `${entry.role}-${i}`;
          if (entry.role === 'user') {
            return (
              <div key={key} className="flex justify-end">
                <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-brand-dark px-3 py-2 text-sm whitespace-pre-wrap text-white">
                  {entry.content}
                </p>
              </div>
            );
          }
          return (
            <div key={key} className="space-y-1.5">
              <div className="max-w-[95%] rounded-2xl rounded-bl-sm border border-slate-200 bg-white px-3 py-2">
                <MarkdownMessage text={entry.content} />
              </div>
              {entry.truncated && (
                <Alert variant="warning">
                  Esta resposta pode estar incompleta — o assistente atingiu o limite de consultas.
                  Pergunte de forma mais específica para completar.
                </Alert>
              )}
              {entry.toolCalls && entry.toolCalls.length > 0 && (
                <ul className="flex flex-wrap gap-1.5" aria-label="Consultas executadas">
                  {entry.toolCalls.map((t, ti) => (
                    <li
                      key={`${t.name}-${ti}`}
                      className="badge flex items-center gap-1 bg-slate-50 text-slate-600"
                    >
                      <Wrench size={11} aria-hidden="true" />
                      {t.name} · {t.rows} linha{t.rows === 1 ? '' : 's'}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}

        {loading && (
          // Sem aria-live próprio: já está dentro do role="log", e região viva aninhada
          // faz o leitor de tela anunciar duas vezes.
          <div className="space-y-1.5">
            {streaming && streaming.tools.length > 0 && (
              // aria-hidden: os chips mudam várias vezes por turno e estão DENTRO do role="log".
              // Sem isto, o leitor de tela anunciaria cada início e cada fim de consulta, soterrando
              // a resposta — que é o que a pessoa está esperando. O rótulo textual abaixo já informa
              // o estado, e ele muda pouco.
              <ul className="flex flex-wrap gap-1.5" aria-hidden="true">
                {streaming.tools.map((t, ti) => (
                  <li
                    key={`${t.name}-${ti}`}
                    className={cn(
                      'badge flex items-center gap-1',
                      t.rows === undefined
                        ? 'bg-brand-light text-brand-dark'
                        : 'bg-slate-50 text-slate-600',
                    )}
                  >
                    <Wrench size={11} aria-hidden="true" />
                    {t.name}
                    {t.rows === undefined && ' · consultando…'}
                    {t.rows !== undefined && ` · ${t.rows} linha${t.rows === 1 ? '' : 's'}`}
                  </li>
                ))}
              </ul>
            )}

            {streaming && streaming.text !== '' && (
              // 🔴 aria-hidden pelo mesmo motivo, e aqui o efeito seria pior: o texto chega token a
              // token, então um leitor de tela reanunciaria a resposta inteira dezenas de vezes por
              // segundo. Quem usa leitor recebe a resposta uma vez, completa, quando ela vira
              // `ChatEntry` — que é o comportamento correto.
              <div
                aria-hidden="true"
                className="max-w-[95%] rounded-2xl rounded-bl-sm border border-slate-200 bg-white px-3 py-2"
              >
                <MarkdownMessage text={streaming.text} />
              </div>
            )}

            <div className="flex items-center gap-3">
              <p className="flex items-center gap-2 text-sm text-slate-600">
                <span className="h-2 w-2 animate-pulse rounded-full bg-brand-dark" aria-hidden="true" />
                {rotuloProgresso}
              </p>
              {/* "Parar" ABORTA de verdade: o corte da conexão chega ao gateway pelo
                  `request.signal`, que interrompe o loop de tool use. Sem ele, desistir era só
                  fechar o painel — e o servidor seguia gastando tokens até o fim. */}
              <button type="button" onClick={onCancel} className="btn text-slate-600">
                <Square size={12} aria-hidden="true" /> Parar
              </button>
            </div>
          </div>
        )}

        {feedback && (
          <div className="space-y-1.5">
            <Alert variant={feedback.variant}>{feedback.text}</Alert>
            <button type="button" onClick={onRetry} disabled={loading} className="btn text-slate-600">
              <RotateCcw size={14} aria-hidden="true" /> Tentar novamente
            </button>
          </div>
        )}
      </div>

      <form
        className="border-t border-slate-200 px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
      >
        <label htmlFor={questionId} className="sr-only">
          Sua pergunta
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id={questionId}
            name="ai-chat-question"
            // autoFocus: o showModal() honra o atributo e põe o cursor direto no campo — é o
            // foco inicial DENTRO do modal, não um roubo de foco da página.
            autoFocus
            rows={2}
            // Espelha o teto do Zod da rota (2000): melhor impedir aqui do que gastar um
            // round-trip para receber 422 "Pergunta muito longa".
            maxLength={2000}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter envia; Shift+Enter quebra linha (convenção de chat). `isComposing` protege
              // quem usa IME/tecla morta: ali o Enter confirma o caractere, não a mensagem.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit(draft);
              }
            }}
            placeholder="Ex.: quanto tenho a pagar em agosto?"
            aria-describedby={hintId}
            disabled={loading}
            className="input min-h-16 resize-y"
          />
          <button
            type="submit"
            disabled={loading || draft.trim().length === 0}
            className="btn btn-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Send size={14} aria-hidden="true" /> Enviar
          </button>
        </div>
        <p id={hintId} className="mt-1.5 text-xs text-slate-500">
          Enter envia · Shift+Enter quebra linha
        </p>
      </form>
    </dialog>
  );
}
