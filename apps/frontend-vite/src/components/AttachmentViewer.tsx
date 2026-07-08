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
  sourceFile: string;
  onClose: () => void;
}

type LoadState = 'loading' | 'ok' | 'notfound';

export default function AttachmentViewer({ sourceFile, onClose }: Readonly<AttachmentViewerProps>) {
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
    return <iframe src={url ?? ''} title={sourceFile} className="h-full w-full border-0" />;
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={onClose}
      className="h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border-0 bg-white p-0 shadow-lg open:flex backdrop:bg-black/50"
    >
      <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-3">
        <p id={titleId} className="flex-1 truncate text-sm font-medium text-slate-700" title={sourceFile}>
          {sourceFile}
        </p>
        {state === 'ok' && url && (
          <>
            <a href={downloadUrl ?? url} download className="btn" title="Baixar o PDF">
              <Download size={14} /> Baixar
            </a>
            <a href={url} target="_blank" rel="noopener noreferrer" className="btn" title="Abrir em nova aba">
              <ExternalLink size={14} /> Nova aba
            </a>
          </>
        )}
        <button
          type="button"
          onClick={onClose}
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
