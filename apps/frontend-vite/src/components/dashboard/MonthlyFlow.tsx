// src/components/dashboard/MonthlyFlow.tsx
// Gráfico de barras "mês a mês" (A pagar vs. Pago por vencimento), compartilhado pelos
// dashboards. Prop `flow` (12 buckets) para servir vencimentos e financeiro. Alturas
// dinâmicas → inline style (exceção justificada — sem classe Tailwind equivalente).
import type { MonthlyFlow as MonthlyFlowData } from '../../services/supabase';
import { fmtMoney } from '../../lib/format';
import { MONTHS } from './constants';

export function MonthlyFlow({ flow }: { flow: MonthlyFlowData[] }) {
  const max = Math.max(1, ...flow.flatMap((d) => [d.aPagar, d.pago]));
  return (
    <div>
      <div className="flex items-end gap-1.5 h-28">
        {flow.map((d) => (
          <div key={d.month} className="flex-1 flex flex-col items-center justify-end h-full gap-1">
            <div className="flex items-end gap-0.5 w-full justify-center h-full">
              {/* altura dinâmica → inline style (sem classe Tailwind equivalente) */}
              <div className="w-[42%] max-w-4 bg-slate-300 rounded-t-sm transition-all" style={{ height: `${(d.aPagar / max) * 100}%` }} title={`A pagar: ${fmtMoney(d.aPagar)}`} />
              <div className="w-[42%] max-w-4 bg-brand rounded-t-sm transition-all" style={{ height: `${(d.pago / max) * 100}%` }} title={`Pago: ${fmtMoney(d.pago)}`} />
            </div>
            <span className="text-xs text-slate-500">{MONTHS[d.month]}</span>
          </div>
        ))}
      </div>
      <div className="flex gap-4 justify-center mt-2">
        <span className="inline-flex items-center gap-1.5 text-xs text-slate-600"><span className="h-2 w-3.5 rounded-xs bg-slate-300" /> A pagar</span>
        <span className="inline-flex items-center gap-1.5 text-xs text-slate-600"><span className="h-2 w-3.5 rounded-xs bg-brand" /> Pago</span>
      </div>
    </div>
  );
}
