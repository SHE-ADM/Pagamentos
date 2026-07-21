// src/components/dashboard/BreakdownDonut.tsx
// Donut genérico (conic-gradient + furo central + legenda), compartilhado pelos dashboards.
// Reusado por: situação por status, tipos de conta, formas de pagamento (vencimentos) e
// Natureza/Tipo (financeiro). Estilo 100% Tailwind; inline só no gradiente cônico e nas
// larguras dinâmicas (exceção justificada — sem classe equivalente).
// `size` controla SÓ o círculo (fonte/gaps da legenda são iguais nos três):
//   sm  — /dashboard_vencimentos, onde 4 donuts dividem a mesma linha (xl)
//   md  — padrão
//   lg  — /dashboard_financeiro, onde só 2 donuts dividem a linha e sobra largura
import { fmtMoney, fmtMoneyCompact } from '../../lib/format';

type DonutSeg = { key: string; label: string; value: number };
// Exportado para os call sites que repassam o tamanho (ex.: StatusDonut em Dashboard.tsx)
// não redeclararem a união literal — fonte única do domínio de tamanhos.
export type DonutSize = 'sm' | 'md' | 'lg';

// Classes literais completas por tamanho (Tailwind JIT — nunca concatenar nome de classe).
// `hole` acompanha o diâmetro para a espessura do anel ficar proporcional.
const SIZE_CLS: Record<DonutSize, { circle: string; hole: string; centerNum: string }> = {
  sm: { circle: 'relative w-[108px] h-[108px] shrink-0', hole: 'absolute inset-3', centerNum: 'font-mono text-sm font-semibold text-slate-900 leading-none text-center' },
  md: { circle: 'relative w-[120px] h-[120px] shrink-0', hole: 'absolute inset-3', centerNum: 'font-mono text-sm font-semibold text-slate-900 leading-none text-center' },
  lg: { circle: 'relative w-[176px] h-[176px] shrink-0', hole: 'absolute inset-5', centerNum: 'font-mono text-base font-semibold text-slate-900 leading-none text-center' },
};

export function BreakdownDonut({ segs, colorFor, size = 'md' }: { segs: DonutSeg[]; colorFor: (label: string, i: number) => string; size?: DonutSize }) {
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
  const { circle: circleCls, hole: holeCls, centerNum: centerNumCls } = SIZE_CLS[size];
  const rowCls = 'flex items-center gap-2 text-xs';
  const pctCls = 'text-slate-600 w-9 text-right';
  const emptyCls = 'text-xs text-slate-500';
  return (
    <div className="flex items-center gap-4">
      <div className={circleCls}>
        {/* gradiente cônico → inline style (sem equivalente Tailwind) */}
        <div className="w-full h-full rounded-full" style={{ background: `conic-gradient(${stops.join(', ') || 'var(--color-slate-200) 0deg 360deg'})` }} />
        <div className={`${holeCls} rounded-full bg-white flex flex-col items-center justify-center shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)]`}>
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
