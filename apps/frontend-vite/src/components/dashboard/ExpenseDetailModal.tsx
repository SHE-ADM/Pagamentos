// src/components/dashboard/ExpenseDetailModal.tsx
// Card de detalhe (drill-down) dos gráficos de /dashboard_despesas. Modal CENTRALIZADO
// (<dialog> nativo — foco preso, Esc, restauração de foco de graça; mesmo padrão do modal
// de edição do /consulta) com um DataGrid enxuto das contas que compõem a fatia/linha
// clicada. As linhas já vêm filtradas pela página (filterExpenseDetailRows) — o modal só
// ordena por valor e apresenta.
import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import type { ExpenseDetailRow } from '../../services/supabase';
import DataGrid from '../organisms/DataGrid';
import { getExpenseDetailColumns } from '../../hooks/useGridColumns';
import { fmtMoney } from '../../lib/format';

// Colunas fixas e read-only — sem estado, definidas uma vez.
const COLUMNS = getExpenseDetailColumns();

interface ExpenseDetailModalProps {
  open: boolean;
  title: string;
  rows: ExpenseDetailRow[];
  onClose: () => void;
}

export function ExpenseDetailModal({ open, title, rows, onClose }: Readonly<ExpenseDetailModalProps>) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  // Abre/fecha o <dialog> nativo conforme `open`. O jsdom não implementa showModal/close
  // (lançam): o fallback seta a propriedade `open` para o modal ficar visível/acessível no
  // teste. Em navegador o showModal SEMPRE funciona, então o catch nunca roda em produção.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) {
      try { el.showModal(); } catch { el.open = true; }
    } else if (!open && el.open) {
      try { el.close(); } catch { el.open = false; }
    }
  }, [open]);

  // Clique no backdrop fecha. Listener NATIVO (não onClick no <dialog>, que dispara o
  // SonarCloud S1082 — handler em elemento não-interativo). Esc já é coberto por onCancel.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const onBackdrop = (e: MouseEvent): void => { if (e.target === el) onClose(); };
    el.addEventListener('click', onBackdrop);
    return () => el.removeEventListener('click', onBackdrop);
  }, [onClose]);

  // `amount` é lido como veio do PostgREST (o front NÃO roda Zod aqui — cast cru), e numeric
  // pode chegar como STRING. Coerção Number(x)||0 espelha o `num()` do serviço → o total do
  // modal é PROVAVELMENTE igual ao valor da fatia (sem risco de concatenar strings) e a
  // ordenação não depende da coerção implícita da subtração.
  const amt = (r: ExpenseDetailRow): number => Number(r.amount) || 0;
  // Ordena por VALOR desc (maiores primeiro) sem mutar a prop.
  const ordered = [...rows].sort((a, b) => amt(b) - amt(a));
  const total = ordered.reduce((s, r) => s + amt(r), 0);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={open ? titleId : undefined}
      onCancel={onClose}
      className="fixed inset-0 m-auto h-fit max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-xl border-0 bg-white p-0 shadow-lg backdrop:bg-black/50"
    >
      {/* Conteúdo só quando aberto: evita renderizar o DataGrid fechado e mantém o
          aria-labelledby apontando para um id existente apenas com o modal visível. */}
      {open && (
        <>
          <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-3">
            <div className="min-w-0">
              <h2 id={titleId} className="truncate text-sm font-semibold text-ink-primary">{title}</h2>
              <p className="text-xs text-slate-500">{ordered.length} conta(s) · Total {fmtMoney(total)}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Fechar"
              className="shrink-0 rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-dark"
            >
              <X size={18} />
            </button>
          </div>
          <div className="p-3">
            <DataGrid
              columns={COLUMNS}
              rows={ordered}
              rowKey={(r) => String(r.id)}
              onRowClick={() => { /* linhas do detalhe não são selecionáveis */ }}
              sortCol={null}
              sortDir={null}
              onSort={() => { /* ordenação fixa (valor desc) — sem sort server-side */ }}
              ariaLabel={`Contas — ${title}`}
              emptyMessage="Sem contas."
              maxBodyHeight="55vh"
              enableRowVirtualization
            />
          </div>
        </>
      )}
    </dialog>
  );
}
