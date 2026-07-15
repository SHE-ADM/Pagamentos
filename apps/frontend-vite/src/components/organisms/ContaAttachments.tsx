// src/components/organisms/ContaAttachments.tsx
// Organism — anexos JÁ SALVOS de uma conta: lista, abre o viewer e remove (soft delete).
//
// Reúne as duas origens sob o mesmo padrão: o documento que veio do e-mail
// (origin='pipeline') e os arquivos enviados pelo usuário ('manual'). O de e-mail é a
// trilha de auditoria da conta — aparece com selo e sem lixeira (o backend também recusa).
//
// Assimetria deliberada com o AttachmentPicker: lá, ADICIONAR é rascunho (efetiva no
// submit); aqui, REMOVER é imediato (com confirmação). Enfileirar remoções custaria
// complexidade por um "desfazer" que o soft delete já dá.
import { useState, useEffect, useCallback, useRef, useId } from 'react';
import type { FinancialAccountAttachment } from '@sheild/shared';
import AttachmentList, { type AttachmentListItem } from '../molecules/AttachmentList';
import AttachmentViewer from '../AttachmentViewer';
import Alert from '../atoms/Alert';
import { listContaAttachments, deleteContaAttachment } from '../../services/contaAttachments';
import { getErrorMessage } from '../../lib/getErrorMessage';

interface ContaAttachmentsProps {
  accountId: number;
  /** Anexos já carregados (embed da conta). Ausente → o componente busca na API. */
  items?: FinancialAccountAttachment[];
  /**
   * `source_file` da conta — rede de segurança para o anexo do e-mail.
   * O registro na tabela é NÃO-FATAL no pipeline (uma falha ali não derruba a conta), então
   * uma conta pode ter source_file e nenhuma linha de anexo. Sem este fallback o anexo
   * sumiria da tela — regressão contra o botão "Ver anexo" que existia antes.
   */
  legacySourceFile?: string | null;
  /** Chamado após remover — o pai reflete a mudança na sua cópia da conta. */
  onChanged?: (attachments: FinancialAccountAttachment[]) => void;
  /** false = esconde a lixeira (o backend continua sendo a trava real). */
  canRemove?: boolean;
  title?: string;
}

interface ViewTarget {
  storageKey: string;
  fileName: string;
}

export default function ContaAttachments({
  accountId,
  items,
  legacySourceFile,
  onChanged,
  canRemove = true,
  title = 'Anexos',
}: Readonly<ContaAttachmentsProps>) {
  // Anexos buscados na API — null = ainda não buscou. Só usado quando o pai NÃO passa
  // `items`; a prop nunca é copiada para o estado (a lista é DERIVADA no render, para não
  // haver duas fontes de verdade nem setState dentro de effect).
  const [fetched, setFetched] = useState<FinancialAccountAttachment[] | null>(null);
  // Ids removidos nesta sessão: o soft delete já foi gravado, mas quando a lista vem do pai
  // (`items`) não podemos editá-la — então filtramos aqui e avisamos via onChanged.
  const [removed, setRemoved] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<ViewTarget | null>(null);
  const [confirming, setConfirming] = useState<AttachmentListItem | null>(null);
  // Descarta resposta obsoleta quando o accountId muda com uma busca em voo (mesmo padrão do
  // supplierReqRef do ContaForm / do `active` do AttachmentViewer).
  const loadReqRef = useRef(0);
  const confirmId = useId();
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    const reqId = ++loadReqRef.current;
    try {
      const rows = await listContaAttachments(accountId);
      if (loadReqRef.current !== reqId) return; // outra conta assumiu
      setFetched(rows);
      setError(null);
    } catch (e) {
      if (loadReqRef.current !== reqId) return;
      setFetched([]);
      setError(getErrorMessage(e));
    }
  }, [accountId]);

  // Busca só quando o pai NÃO passou os anexos (o embed da conta já os traz em /consulta).
  // load() é fetch-on-mount (busca em sistema externo) — o effect é a ferramenta certa;
  // a regra do React Compiler é conservadora aqui, como em Consulta/Emails/Erros.
  useEffect(() => {
    if (items) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [items, load]);

  // Foca a confirmação de remoção: sem isto o leitor de tela não anuncia o painel (o foco
  // ficaria na lixeira já removida da árvore) — WCAG 4.1.3, e é uma ação destrutiva.
  useEffect(() => {
    if (confirming) confirmButtonRef.current?.focus();
  }, [confirming]);

  const source = items ?? fetched;
  const loading = source === null;
  const rows = (source ?? []).filter((r) => !removed.has(r.id));

  const handleRemove = async (item: AttachmentListItem) => {
    setBusy(true);
    setError(null);
    const id = Number(item.id);
    try {
      await deleteContaAttachment(accountId, id);
      setRemoved((prev) => new Set(prev).add(id));
      onChanged?.(rows.filter((r) => r.id !== id));
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  const toItem = (a: FinancialAccountAttachment): AttachmentListItem => ({
    id: a.id,
    name: a.file_name,
    mimeType: a.mime_type,
    sizeBytes: a.size_bytes,
    fromEmail: a.origin === 'pipeline',
  });

  // Fallback: conta com source_file mas SEM a linha de pipeline registrada (ver
  // legacySourceFile). A condição é "não há anexo DE E-MAIL", não "não há anexo nenhum":
  // com `rows.length === 0` o boleto do e-mail sumia da tela assim que o usuário anexasse
  // um arquivo manual — justamente a regressão que este fallback existe para evitar.
  const useLegacy = !loading && !!legacySourceFile && !rows.some((r) => r.origin === 'pipeline');
  const legacyItem: AttachmentListItem[] = useLegacy
    ? [{ id: legacySourceFile, name: legacySourceFile, mimeType: 'application/pdf', sizeBytes: 0, fromEmail: true }]
    : [];
  const listItems: AttachmentListItem[] = [...legacyItem, ...rows.map(toItem)];

  const handleView = (item: AttachmentListItem) => {
    const row = rows.find((r) => r.id === item.id);
    setViewing({ storageKey: row?.storage_key ?? String(item.id), fileName: item.name });
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-gray-700">{title}</span>

      {error && <Alert variant="error">{error}</Alert>}

      {loading ? (
        <p className="text-sm text-slate-500">Carregando anexos…</p>
      ) : (
        <AttachmentList
          items={listItems}
          onView={handleView}
          onRemove={canRemove ? setConfirming : undefined}
          busy={busy}
          emptyText="Nenhum anexo nesta conta."
        />
      )}

      {confirming && (
        // role=alertdialog + foco no botão de confirmar: a lixeira que abriu este painel sai
        // da árvore, então sem isso o leitor de tela não anunciaria nada e a ação pareceria
        // não ter efeito (WCAG 4.1.3) — e é uma ação destrutiva.
        <div
          role="alertdialog"
          aria-labelledby={confirmId}
          className="flex flex-col gap-2 rounded-lg border border-status-warning-border bg-status-warning-bg p-3"
        >
          <p id={confirmId} className="text-sm text-status-warning-fg">
            Remover o anexo &quot;{confirming.name}&quot;?
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setConfirming(null)} disabled={busy}>
              Cancelar
            </button>
            <button
              ref={confirmButtonRef}
              type="button"
              className="btn text-status-error-fg"
              onClick={() => void handleRemove(confirming)}
              disabled={busy}
            >
              {busy ? 'Removendo…' : 'Remover'}
            </button>
          </div>
        </div>
      )}

      {viewing && (
        <AttachmentViewer
          sourceFile={viewing.storageKey}
          title={viewing.fileName}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}
