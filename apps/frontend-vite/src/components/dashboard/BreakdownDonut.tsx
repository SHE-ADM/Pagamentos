// src/components/dashboard/BreakdownDonut.tsx
// Donut genérico (conic-gradient + furo central + legenda), compartilhado pelos dashboards.
// Reusado por: situação por status, tipos de conta, formas de pagamento (vencimentos) e
// Natureza/Tipo (financeiro). Estilo 100% Tailwind; inline só no gradiente cônico e nas
// larguras dinâmicas (exceção justificada — sem classe equivalente).
import { fmtMoney } from '../../lib/format';

type DonutSeg = { key: string; label: string; count: number; value: number };

export function BreakdownDonut({ segs, colorFor }: { segs: DonutSeg[]; colorFor: (label: string, i: number) => string }) {
  // Ordena as fatias por VALOR (R$) decrescente — legenda e arcos na mesma ordem.
  const ordered = [...segs].sort((a, b) => b.value - a.value);
  const totalCount = ordered.reduce((s, x) => s + x.count, 0);
  // Arcos e % proporcionais ao VALOR (R$) — a nova realidade do gráfico.
  const totalValue = ordered.reduce((s, x) => s + x.value, 0) || 1;
  // Soma cumulativa sem mutar variável de closure no render (React Compiler).
  const stops = ordered.map((s, i) => {
    const start = ordered.slice(0, i).reduce((acc, x) => acc + x.value, 0);
    const a = (start / totalValue) * 360;
    const b = ((start + s.value) / totalValue) * 360;
    return `${colorFor(s.label, i)} ${a}deg ${b}deg`;
  });
  return (
    <div className="flex items-center gap-4">
      <div className="relative w-[120px] h-[120px] shrink-0">
        {/* gradiente cônico → inline style (sem equivalente Tailwind) */}
        <div className="w-full h-full rounded-full" style={{ background: `conic-gradient(${stops.join(', ') || 'var(--color-slate-200) 0deg 360deg'})` }} />
        <div className="absolute inset-4 rounded-full bg-white flex flex-col items-center justify-center shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)]">
          <span className="font-mono text-xl font-semibold text-slate-900 leading-none">{totalCount}</span>
          <span className="text-xs text-slate-500 mt-0.5">contas</span>
        </div>
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        {ordered.map((s, i) => (
          <div key={s.key} className="flex items-center gap-2 text-xs">
            <span className="h-2.5 w-2.5 rounded-xs shrink-0" style={{ background: colorFor(s.label, i) }} />
            <span className="text-slate-700 capitalize flex-1 truncate">{s.label}</span>
            <span className="font-mono text-slate-900 font-semibold whitespace-nowrap">{fmtMoney(s.value)}</span>
            <span className="font-mono text-slate-500 w-7 text-right">{s.count}</span>
            <span className="text-slate-600 w-9 text-right">{Math.round((s.value / totalValue) * 100)}%</span>
          </div>
        ))}
        {!ordered.length && <span className="text-xs text-slate-500">Sem contas no período.</span>}
      </div>
    </div>
  );
}
