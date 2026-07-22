// src/components/dashboard/RankingList.tsx
// Ranking horizontal (top N por valor) genérico, compartilhado pelos dashboards.
// Vencimentos → ranking de fornecedores; financeiro → ranking de subgrupos de despesa.
// Prop `rows` estrutural `{ name, value, count }` (compatível com SupplierRank), então o
// componente não acopla à semântica (fornecedor vs subgrupo). Larguras dinâmicas → inline.
import { fmtMoney } from '../../lib/format';

// `key` (opcional) = identidade do balde, repassada ao onSelect para o drill-down casar as
// contas daquela linha; ver SupplierRank.key. Sem onSelect, o componente ignora a key.
// `pct` (opcional) = % do total de registros do escopo que esta linha representa (não da
// soma dos valores exibidos — ver `rankBy` em services/supabase.ts). Quando presente, a
// célula à direita mostra o percentual em vez de "N conta(s)" — troca automática por linha,
// sem prop dedicada no componente (rankings de fornecedores/vencimentos não o preenchem e
// continuam mostrando a contagem, sem qualquer mudança nos call sites existentes).
type RankRow = { name: string; value: number; count: number; pct?: number; key?: string };

export function RankingList({
  rows,
  emptyLabel = 'Sem contas no período.',
  onSelect,
  dense = false,
}: {
  rows: RankRow[];
  emptyLabel?: string;
  onSelect?: (row: RankRow) => void;
  // Linhas um pouco mais compactas (padding/margem verticais reduzidos a 1px, gap menor) —
  // opt-in: usado pelos rankings de /dashboard_despesas (centro de custo e contas), que têm
  // até 12 linhas; o ranking de fornecedores de /dashboard_vencimentos não liga (inalterado).
  dense?: boolean;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="text-xs text-slate-500 py-4">{emptyLabel}</p>;
  // Badge de posição SEM redução (h-5 w-5 nos dois modos, 2026-07-22): reduzi-lo deixava o
  // ranking "muito compactado" visualmente (feedback do usuário) sem ganho de altura real —
  // a linha de texto+barra já é mais alta que o badge nos dois casos (ver conta abaixo).
  const badgeCls = 'h-5 w-5';
  // `py-px`/`mb-px` (1px), não `py-0`/`mb-0`: compactação um pouco mais SUAVE (pedido do
  // usuário 2026-07-22) — ainda cabe mais linhas que o normal (py-0.5/mb-0.5), mas sem
  // ficar tão apertado quanto a 1ª versão (que zerava padding/margem por completo).
  const rowCls = dense ? 'flex items-center gap-1.5 py-px' : 'flex items-center gap-2 py-0.5';
  const contentMbCls = dense ? 'mb-px' : 'mb-0.5';
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
            <span className={`shrink-0 ${badgeCls} rounded-full text-xs font-bold flex items-center justify-center ${i < 3 ? 'bg-brand-dark text-white' : 'bg-slate-200 text-slate-600'}`}>{i + 1}</span>
            <div className="flex-1 min-w-0">
              <div className={`flex justify-between gap-2 ${contentMbCls}`}>
                <span className="text-xs font-medium text-slate-700 truncate">{r.name}</span>
                <span className="font-mono text-xs font-semibold text-slate-900 whitespace-nowrap">{fmtMoney(r.value)}</span>
              </div>
              <div className="h-1 rounded-full bg-slate-100 overflow-hidden">
                {/* largura dinâmica → inline style */}
                <div className="h-full bg-brand rounded-full transition-all" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
              </div>
            </div>
            <span className="shrink-0 text-xs text-slate-500 w-14 text-right">
              {r.pct != null ? `${Math.round(r.pct)}%` : `${r.count} conta(s)`}
            </span>
          </>
        );
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
