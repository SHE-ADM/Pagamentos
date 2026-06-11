// src/components/AttachmentViewer.tsx
// Modal que exibe o PDF anexado a partir do Supabase Storage (bucket privado).
// Organism: tem estado (loading/ok/notfound) e lógica (gera URL assinada, Esc).
// O anexo vive na nuvem (migration 021) — visível de qualquer computador logado,
// independentemente de qual máquina rodou o leitor de e-mail.
import { useState, useEffect, useCallback } from 'react';
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

  // Fecha com a tecla Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const stop = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);

  function renderBody() {
    if (state === 'loading') {
      return <div className="flex h-full items-center justify-center text-sm text-slate-400">Carregando anexo…</div>;
    }
    if (state === 'notfound') {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-50 text-amber-500">
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-fade-in-up"
      onClick={onClose}
    >
      <div
        className="flex h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-lg"
        onClick={stop}
      >
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-3">
          <p className="flex-1 truncate text-sm font-medium text-slate-700" title={sourceFile}>
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
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
            title="Fechar"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 bg-slate-50">{renderBody()}</div>
      </div>
    </div>
  );
}
