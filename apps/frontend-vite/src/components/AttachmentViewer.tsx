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
import { extractLargestDocxImage } from '../lib/docxPreview';

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
  // Pré-visualização de .docx: object URL da imagem embutida, e o flag de "já tentei" — sem
  // ele não dá para distinguir "ainda extraindo" de "não há imagem".
  const [docxImage, setDocxImage] = useState<string | null>(null);
  const [docxDone, setDocxDone] = useState(false);
  // 🔴 TERCEIRO estado, e ele não é redundante com os dois de cima: `docxDone` sem imagem tem
  // DUAS causas opostas — o documento não tem figura (fato sobre o arquivo) ou não conseguimos
  // lê-lo (fato sobre a leitura). Afirmar a primeira quando vale a segunda é mentir na tela.
  const [docxFalhou, setDocxFalhou] = useState(false);
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

  // Nenhum navegador renderiza .docx em <iframe> — ele mostraria um painel em branco ou
  // dispararia um download, o que se lê na tela como "o anexo sumiu".
  const isDocx = /\.docx$/i.test(sourceFile);

  // …mas o .docx que chega aqui É o boleto: medido nos 3 casos reais (guias do TJSP), os
  // documentos têm texto ZERO e uma única imagem embutida. Então em vez de mandar o usuário
  // baixar e abrir o Word, abrimos o ZIP no próprio navegador e exibimos a figura.
  // `docxImage`: object URL da imagem · null + docxDone = não havia imagem (cai na mensagem).
  useEffect(() => {
    if (!isDocx || state !== 'ok' || !url) return;
    let active = true;
    let objectUrl: string | null = null;
    const extrair = async () => {
      try {
        // `fetch` NÃO lança em 403/404 — e a signed URL expira em SIGNED_URL_TTL com o modal
        // aberto. Sem esta checagem, o corpo XML de erro do Storage seguiria como "ZIP" e o
        // extrator o classificaria como `nao-e-zip`: um diagnóstico sobre o CONTEÚDO quando o
        // que houve foi **403 na URL assinada**. A tela hoje acerta nos dois casos (ambos caem
        // em "não foi possível ler"), mas o log mandaria o suporte investigar o arquivo em vez
        // da expiração — e o arquivo está intacto no Storage.
        const res = await fetch(url);
        if (!res.ok) throw new Error(`download do .docx falhou: HTTP ${res.status}`);
        const bytes = await res.arrayBuffer();
        const resultado = await extractLargestDocxImage(bytes);
        if (!active) return;
        if (resultado.image) {
          objectUrl = URL.createObjectURL(resultado.image.blob);
          setDocxImage(objectUrl);
        }
        // 🔴 `failure` NÃO é erro do chamador — a extração é best-effort por contrato. Ele é a
        // diferença entre "não tem imagem" e "não deu para ler", e existe para NÃO deixar a
        // tela afirmar a primeira quando vale a segunda. `image` presente com `failure` é
        // anomalia parcial: mostra a imagem e registra o motivo, sem alarmar o usuário.
        if (resultado.failure) {
          if (!resultado.image) setDocxFalhou(true);
          console.error(
            `[AttachmentViewer] leitura do .docx: ${resultado.failure}`,
            resultado.error,
          );
        }
      } catch (e) {
        // Degrada para a mensagem de download (Baixar/Nova aba seguem no cabeçalho), mas
        // nunca em silêncio — sem rastro, um erro de rede vira diagnóstico no lugar errado.
        if (active) setDocxFalhou(true);
        console.error('[AttachmentViewer] pré-visualização de .docx indisponível', e);
      } finally {
        if (active) setDocxDone(true);
      }
    };
    void extrair();
    return () => {
      active = false;
      // Sem isto o blob fica retido na memória da aba a cada anexo aberto.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isDocx, state, url]);

  function renderBody() {
    if (state === 'loading') {
      return <div className="flex h-full items-center justify-center text-sm text-slate-500">Carregando anexo…</div>;
    }
    if (state === 'ok' && isDocx) {
      if (docxImage) {
        return (
          <div className="flex h-full items-center justify-center overflow-auto bg-slate-50 p-4">
            {/* Conteúdo, não decoração: o alt descreve o que é, sem repetir o nome do arquivo
                (já anunciado pelo título do modal, via aria-labelledby). */}
            <img
              src={docxImage}
              alt={`Documento anexado ao Word — ${label}`}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        );
      }
      if (!docxDone) {
        return (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">
            Abrindo documento do Word…
          </div>
        );
      }
      // As duas mensagens abaixo dizem coisas DIFERENTES de propósito. A de cima é um fato
      // sobre o ARQUIVO e só pode ser exibida quando a leitura terminou sem anomalia; a de
      // baixo é um fato sobre a LEITURA. Trocar uma pela outra manda o usuário (e o suporte)
      // investigar o lado errado — o documento fica sob suspeita quando o problema era nosso.
      if (docxFalhou) {
        return (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-status-warning-bg text-status-warning-fg">
              <FileWarning size={26} />
            </div>
            <p className="max-w-xs text-sm text-slate-600">
              Não foi possível ler este documento do Word (.docx) para pré-visualizar.
              Use <span className="font-medium">Baixar</span> ou <span className="font-medium">Nova aba</span> para abrir o arquivo.
            </p>
          </div>
        );
      }
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-status-info-bg text-status-info-fg">
            <FileWarning size={26} />
          </div>
          <p className="max-w-xs text-sm text-slate-600">
            Documento do Word (.docx) sem imagem para pré-visualizar.
            Use <span className="font-medium">Baixar</span> ou <span className="font-medium">Nova aba</span> para abrir o arquivo.
          </p>
        </div>
      );
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
