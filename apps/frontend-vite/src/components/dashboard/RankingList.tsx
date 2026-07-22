// src/components/dashboard/RankingList.tsx
// Ranking horizontal (top N por valor) genérico, compartilhado pelos dashboards.
// Vencimentos → ranking de fornecedores; financeiro → ranking de subgrupos de despesa.
// Prop `rows` estrutural `{ name, value, count }` (compatível com SupplierRank), então o
// componente não acopla à semântica (fornecedor vs subgrupo). Larguras dinâmicas → inline.
import { fmtMoney } from '../../lib/format';

// `key` (opcional) = identidade do balde, repassada ao onSelect para o drill-down casar as
// contas daquela linha; ver SupplierRank.key. Sem onSelect, o componente ignora a key.
type RankRow = { name: string; value: number; count: number; key?: string };

export function RankingList({ rows, emptyLabel = 'Sem contas no período.', onSelect }: { rows: RankRow[]; emptyLabel?: string; onSelect?: (row: RankRow) => void }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="text-xs text-slate-500 py-4">{emptyLabel}</p>;
  return (
    <div>
      {/* A key inclui a posição porque `name` NÃO é garantidamente único: o ranking de
          fornecedores agrega por nome, e os cadastros de centro/plano não têm UNIQUE em
          descrição — dois homônimos gerariam key duplicada (React renderiza errado). A
          lista é estática (recriada a cada carga, sem reordenação incremental), então a
          posição é uma key estável o bastante. */}
      {rows.map((r, i) => {
        // Conteúdo idêntico em ambos os modos — só o invólucro muda (button vs div).
        const inner = (
          <>
            <span className={`shrink-0 h-5 w-5 rounded-full text-xs font-bold flex items-center justify-center ${i < 3 ? 'bg-brand-dark text-white' : 'bg-slate-200 text-slate-600'}`}>{i + 1}</span>
            <div className="flex-1 min-w-0">
              <div className="flex justify-between gap-2 mb-0.5">
                <span className="text-xs font-medium text-slate-700 truncate">{r.name}</span>
                <span className="font-mono text-xs font-semibold text-slate-900 whitespace-nowrap">{fmtMoney(r.value)}</span>
              </div>
              <div className="h-1 rounded-full bg-slate-100 overflow-hidden">
                {/* largura dinâmica → inline style */}
                <div className="h-full bg-brand rounded-full transition-all" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
              </div>
            </div>
            <span className="shrink-0 text-xs text-slate-500 w-14 text-right">{r.count} conta(s)</span>
          </>
        );
        const rowCls = 'flex items-center gap-2 py-0.5';
        // Com onSelect a linha vira <button> real (foco/teclado/nome acessível — evita S1082);
        // sem ele, mantém o <div> não-interativo (vencimentos).
        return onSelect ? (
          <button
            key={`${r.name}#${i}`}
            type="button"
            onClick={() => onSelect(r)}
            title={`Ver contas de ${r.name}`}
            className={`${rowCls} w-full text-left rounded px-1 -mx-1 hover:bg-slate-50 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-dark`}
          >
            {inner}
          </button>
        ) : (
          <div key={`${r.name}#${i}`} className={rowCls}>{inner}</div>
        );
      })}
    </div>
  );
}
