// src/components/dashboard/BreakdownDonut.tsx
// Donut genérico (conic-gradient + furo central + legenda), compartilhado pelos dashboards.
// Reusado por: situação por status, tipos de conta, formas de pagamento (vencimentos) e
// Natureza/Tipo (financeiro). Estilo 100% Tailwind; inline só no gradiente cônico e nas
// larguras dinâmicas (exceção justificada — sem classe equivalente).
// `dense` (ex.: /dashboard_vencimentos): fonte menor, círculo menor e menos espaçamento
// lateral, para caber mais informação (R$ + contagem + %) sem truncar.
import { fmtMoney, fmtMoneyCompact } from '../../lib/format';

type DonutSeg = { key: string; label: string; value: number };

export function BreakdownDonut({ segs, colorFor, dense = false }: { segs: DonutSeg[]; colorFor: (label: string, i: number) => string; dense?: boolean }) {
  // Ordena as fatias por VALOR (R$) decrescente — legenda e arcos na mesma ordem.
  const ordered = [...segs].sort((a, b) => b.value - a.value);
  // Arcos, % e total central proporcionais ao VALOR (R$) — a contagem de contas saiu do gráfico.
  const sumValue = ordered.reduce((s, x) => s + x.value, 0);
  const totalValue = sumValue || 1; // evita divisão por zero no gradiente
  // Soma cumulativa sem mutar variável de closure no render (React Compiler).
  const stops = ordered.map((s, i) => {
    const start = ordered.slice(0, i).reduce((acc, x) => acc + x.value, 0);
    const a = (start / totalValue) * 360;
    const b = ((start + s.value) / totalValue) * 360;
    return `${colorFor(s.label, i)} ${a}deg ${b}deg`;
  });
  // Classes literais completas em cada ramo (Tailwind JIT — nunca concatenar nome de classe).
  const wrapCls = dense ? 'flex items-center gap-2' : 'flex items-center gap-4';
  const circleCls = dense ? 'relative w-[92px] h-[92px] shrink-0' : 'relative w-[120px] h-[120px] shrink-0';
  const centerNumCls = dense
    ? 'font-mono text-xs font-semibold text-slate-900 leading-none text-center'
    : 'font-mono text-sm font-semibold text-slate-900 leading-none text-center';
  const rowCls = dense ? 'flex items-center gap-1.5 donut-legend-dense' : 'flex items-center gap-2 text-xs';
  const pctCls = dense ? 'text-slate-600 w-8 text-right' : 'text-slate-600 w-9 text-right';
  const emptyCls = dense ? 'donut-legend-dense text-slate-500' : 'text-xs text-slate-500';
  return (
    <div className={wrapCls}>
      <div className={circleCls}>
        {/* gradiente cônico → inline style (sem equivalente Tailwind) */}
        <div className="w-full h-full rounded-full" style={{ background: `conic-gradient(${stops.join(', ') || 'var(--color-slate-200) 0deg 360deg'})` }} />
        <div className="absolute inset-3 rounded-full bg-white flex flex-col items-center justify-center shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)]">
          <span className={centerNumCls}>{fmtMoneyCompact(sumValue)}</span>
          <span className="text-xs text-slate-500 mt-0.5">total</span>
        </div>
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        {ordered.map((s, i) => (
          <div key={s.key} className={rowCls}>
            <span className="h-2.5 w-2.5 rounded-xs shrink-0" style={{ background: colorFor(s.label, i) }} />
            <span className="text-slate-700 capitalize flex-1 truncate">{s.label}</span>
            <span className="font-mono text-slate-900 font-semibold whitespace-nowrap">{fmtMoney(s.value)}</span>
            <span className={pctCls}>{Math.round((s.value / totalValue) * 100)}%</span>
          </div>
        ))}
        {!ordered.length && <span className={emptyCls}>Sem contas no período.</span>}
      </div>
    </div>
  );
}
