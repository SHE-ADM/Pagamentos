// src/components/molecules/AttachmentList.tsx
// Molecule — lista de anexos, APRESENTACIONAL PURA (sem fetch, sem estado).
// Serve tanto para os anexos JÁ SALVOS (organisms/ContaAttachments) quanto para os
// PENDENTES ainda na fila do formulário (molecules/AttachmentPicker); por isso o item é
// uma forma genérica, não o tipo do banco.
import { FileText, Image as ImageIcon, Eye, Trash2, Mail } from 'lucide-react';
import { fmtBytes } from '../../lib/format';

export interface AttachmentListItem {
  /** Identidade estável para a `key` e para os callbacks. */
  id: string | number;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Anexo vindo do e-mail: exibe o selo de origem e nunca é removível. */
  fromEmail?: boolean;
}

interface AttachmentListProps {
  items: AttachmentListItem[];
  /** Ausente = não há o que visualizar ainda (fila de pendentes). */
  onView?: (item: AttachmentListItem) => void;
  /** Ausente = sem lixeira (ex.: sem permissão, ou anexo de e-mail). */
  onRemove?: (item: AttachmentListItem) => void;
  /** Desabilita as ações durante um envio/remoção em curso. */
  busy?: boolean;
  emptyText?: string;
}

export default function AttachmentList({
  items,
  onView,
  onRemove,
  busy = false,
  emptyText = 'Nenhum anexo.',
}: Readonly<AttachmentListProps>) {
  if (!items.length) {
    return <p className="text-sm text-slate-500">{emptyText}</p>;
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((item) => {
        const Icon = item.mimeType.startsWith('image/') ? ImageIcon : FileText;
        // Anexo de e-mail é o documento que ORIGINOU a conta (trilha de auditoria):
        // some a lixeira mesmo que o pai passe onRemove. O backend também recusa (403).
        const canRemove = !!onRemove && !item.fromEmail;
        return (
          <li
            key={item.id}
            className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2"
          >
            {/* 🔴 O NOME É O ALVO DE CLIQUE, e isso não é preferência de estilo.
                No painel de detalhe de /consulta esta lista vive num `<td colSpan>`, que tem a
                largura TOTAL da tabela — maior que a área visível sempre que o grid rola na
                horizontal. Um botão no FIM da linha flex cai fora da tela: ele existe, responde
                e é inalcançável sem rolar, que foi exatamente o relato ("mostra o anexo, mas não
                está clicável"). O nome fica na BORDA ESQUERDA, onde nenhuma largura de tabela o
                empurra, e ainda dá um alvo grande em vez de um ícone de 14px.
                O ícone de olho continua à direita para quem já o conhece — os dois disparam a
                mesma ação, e só um deles carrega o nome acessível (o outro é `aria-hidden`),
                senão o leitor de tela anunciaria "Ver X" duas vezes na mesma linha. */}
            {onView ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onView(item);
                }}
                // `cursor-pointer` é EXPLÍCITO: o padrão do navegador para <button> é
                // `cursor: default`, então sem esta classe o nome vira um alvo de clique que
                // não se anuncia como tal — quem já tem a `.btn` (o ícone de olho ao lado)
                // ganha a mãozinha de graça, e a diferença entre os dois confundiria.
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                aria-label={`Ver ${item.name}`}
                title="Ver o anexo"
              >
                <Icon size={16} aria-hidden="true" className="shrink-0 text-slate-500" />
                {/* `title` com o NOME (não com a ação): o texto trunca nesta lista estreita, e o
                    hover era a única forma de ler o nome inteiro. O `title` do botão vale sobre o
                    ícone; sobre o texto vence este, que é o interno. */}
                <span
                  className="min-w-0 flex-1 truncate text-sm text-slate-700 hover:underline"
                  title={item.name}
                >
                  {item.name}
                </span>
              </button>
            ) : (
              <>
                <Icon size={16} aria-hidden="true" className="shrink-0 text-slate-500" />
                <span className="min-w-0 flex-1 truncate text-sm text-slate-700" title={item.name}>
                  {item.name}
                </span>
              </>
            )}
            {item.fromEmail && (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-status-info-bg px-2 py-0.5 text-xs text-status-info-fg"
                title="Anexo recebido por e-mail — não pode ser removido"
              >
                <Mail size={11} aria-hidden="true" /> e-mail
              </span>
            )}
            <span className="shrink-0 text-xs text-slate-500">{fmtBytes(item.sizeBytes)}</span>
            {/* stopPropagation: a ação é encapsulada no botão e não pode vazar para ancestrais
                — no painel de detalhe de /consulta a lista fica DENTRO do <tr>, cujo onClick
                alterna a linha (abrir um anexo fecharia o próprio painel). Mesmo padrão dos
                botões do detalhe (Consulta.tsx). Funciona também no teclado: Enter/Espaço num
                <button> gera um `click`, que é contido aqui. */}
            {onView && (
              // `aria-hidden` + `tabIndex={-1}`: é o MESMO comando do nome, ali ao lado. Sem
              // isso o leitor de tela anunciaria dois botões "Ver <nome>" na mesma linha e o
              // Tab pararia duas vezes no mesmo destino. Fica como atalho visual para quem já
              // usa o ícone — e o mouse continua alcançando os dois.
              <button
                type="button"
                aria-hidden="true"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  onView(item);
                }}
                className="btn shrink-0"
                title="Ver o anexo"
              >
                <Eye size={14} aria-hidden="true" />
              </button>
            )}
            {canRemove && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(item);
                }}
                disabled={busy}
                className="btn shrink-0 text-status-error-fg disabled:opacity-50"
                aria-label={`Remover ${item.name}`}
                title="Remover o anexo"
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
