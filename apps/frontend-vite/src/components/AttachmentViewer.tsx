// src/components/AttachmentViewer.tsx
// Modal que exibe o PDF anexado a partir do Supabase Storage (bucket privado).
// Organism: tem estado (loading/ok/notfound) e lógica (gera URL assinada).
// O anexo vive na nuvem (migration 021) — visível de qualquer computador logado,
// independentemente de qual máquina rodou o leitor de e-mail.
//
// Acessibilidade: usa o elemento NATIVO <dialog> + showModal() — o navegador
// garante de graça role="dialog"/aria-modal, foco inicial movido para dentro,
// trap de foco (Tab não vaza para o fundo), retorno do foco ao fechar e Esc
// (evento `cancel`). Só falta o nome acessível, via aria-labelledby no título.
import { useState, useEffect, useId, useRef } from 'react';
import { X, Download, ExternalLink, FileWarning } from 'lucide-react';
import { supabase } from '../lib/supabaseClient';

const BUCKET = 'attachments';
const SIGNED_URL_TTL = 300; // segundos de validade da URL assinada

interface AttachmentViewerProps {
  /** Chave CRUA do objeto no bucket. Pipeline: nome flat. Manual: `manual/{id}/…`. */
  sourceFile: string;
  /**
   * Nome amigável no cabeçalho. Sem isto cairia a chave crua, que para anexo manual é
   * ruído (`manual/512/20260715T120000Z_a1b2c3d4_Boleto.pdf`). Default: a própria chave —
   * preserva o comportamento de quem passa só `sourceFile`.
   */
  title?: string;
  onClose: () => void;
}

type LoadState = 'loading' | 'ok' | 'notfound';

export default function AttachmentViewer({ sourceFile, title, onClose }: Readonly<AttachmentViewerProps>) {
  const label = title ?? sourceFile;
  const [state, setState] = useState<LoadState>('loading');
  const [url, setUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Gera a URL assinada (visualização + download) a partir do nome do arquivo.
  // Objeto inexistente no bucket -> erro -> estado 'notfound'.
  useEffect(() => {
    let active = true;
    const sign = async () => {
      const store = supabase.storage.from(BUCKET);
      const [view, dl] = await Promise.all([
        store.createSignedUrl(sourceFile, SIGNED_URL_TTL),
        store.createSignedUrl(sourceFile, SIGNED_URL_TTL, { download: true }),
      ]);
      if (!active) return;
      if (view.error || !view.data?.signedUrl) {
        setState('notfound');
        return;
      }
      setUrl(view.data.signedUrl);
      setDownloadUrl(dl.data?.signedUrl ?? view.data.signedUrl);
      setState('ok');
    };
    void sign();
    return () => {
      active = false;
    };
  }, [sourceFile]);

  // Abre como modal ao montar (foco/trap/Esc nativos) e fecha ao desmontar.
  // O try/catch cobre o jsdom, que não implementa showModal (no teste o conteúdo
  // segue no DOM; a varredura axe real do modal roda na camada de navegador).
  useEffect(() => {
    const el = dialogRef.current;
    try {
      el?.showModal();
    } catch {
      /* showModal indisponível (jsdom) — ignorado */
    }
    return () => {
      try {
        el?.close();
      } catch {
        /* close indisponível (jsdom) — ignorado */
      }
    };
  }, []);

  // Clique no ::backdrop (fora do conteúdo) fecha — o alvo do clique é o próprio
  // <dialog>; cliques no conteúdo têm alvos internos. Listener nativo (não onClick
  // no JSX) porque o <dialog> não é tratado como elemento interativo para cliques.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const onBackdrop = (e: MouseEvent) => {
      if (e.target === el) onClose();
    };
    el.addEventListener('click', onBackdrop);
    return () => el.removeEventListener('click', onBackdrop);
  }, [onClose]);

  function renderBody() {
    if (state === 'loading') {
      return <div className="flex h-full items-center justify-center text-sm text-slate-500">Carregando anexo…</div>;
    }
    if (state === 'notfound') {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-status-warning-bg text-status-warning-fg">
            <FileWarning size={26} />
          </div>
          <p className="max-w-xs text-sm text-slate-500">
            Anexo não encontrado no Storage. O PDF pode ainda não ter sido publicado para este registro.
          </p>
        </div>
      );
    }
    // SEM `sandbox` (intencional — NÃO reintroduzir): o visualizador de PDF do Chrome
    // (MimeHandlerView/PDFium) NÃO renderiza em iframe sandboxed de forma confiável, nem
    // mesmo com `allow-scripts allow-same-origin` (verificado em produção: mostrava o ícone
    // de "documento quebrado", só o download funcionava). O S5-1 introduziu o sandbox e
    // quebrou a visualização do boleto; revertido ao comportamento pré-S5. A defesa que
    // permanece: a signed URL é da origem SUPABASE (cross-origin ao app), então o conteúdo é
    // isolado pela política de mesma-origem — não acessa DOM/token/localStorage do app.
    // `referrerPolicy="no-referrer"` evita vazar a signed URL no header Referer. (Trade-off
    // aceito: sem sandbox, um "PDF" que fosse HTML+JS poderia navegar a janela top; mitigado
    // por o bucket receber só anexos do nosso próprio pipeline, servidos como application/pdf.)
    return (
      <iframe
        src={url ?? ''}
        title={label}
        referrerPolicy="no-referrer"
        className="h-full w-full border-0"
      />
    );
  }

  // Os botões abaixo contêm o próprio clique (`stopPropagation`) — NÃO REGREDIR. O viewer é
  // usado dentro do painel de detalhe de /consulta, isto é, dentro de um <tr> cujo onClick
  // alterna a linha: sem isso, fechar/baixar o anexo fecharia o painel junto.
  // Um `createPortal` para o body NÃO resolveria: o React propaga o evento pela árvore de
  // COMPONENTES, não pela do DOM — o clique chegaria ao <tr> mesmo com o dialog fora dele
  // (verificado em teste). E `onClick` no próprio <dialog> seria handler em elemento
  // não-interativo (S1082). Conter no botão é o padrão do projeto (ver Consulta.tsx).
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={onClose}
      className="h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border-0 bg-white p-0 shadow-lg open:flex backdrop:bg-black/50"
    >
      <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-3">
        <p id={titleId} className="flex-1 truncate text-sm font-medium text-slate-700" title={label}>
          {label}
        </p>
        {state === 'ok' && url && (
          <>
            <a
              href={downloadUrl ?? url}
              download
              className="btn"
              title="Baixar o PDF"
              onClick={(e) => e.stopPropagation()}
            >
              <Download size={14} /> Baixar
            </a>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn"
              title="Abrir em nova aba"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink size={14} /> Nova aba
            </a>
          </>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label="Fechar"
          title="Fechar"
          className="flex h-8 w-8 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-600 transition-colors"
        >
          <X size={16} />
        </button>
      </div>
      <div className="flex-1 bg-slate-50">{renderBody()}</div>
    </dialog>
  );
}
