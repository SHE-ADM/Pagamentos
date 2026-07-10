// src/pages/Dashboard.tsx
// Dashboard financeiro de contas a pagar. Abre SEMPRE no mês atual.
// Dados reais via getDashboardData (services/supabase.ts).
// Estilo 100% Tailwind (Regra 1). Estilo inline só onde não há classe equivalente:
// gradiente cônico do donut e larguras dinâmicas de barra (exceções justificadas).
import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, FileText, CheckCircle2, Clock, TrendingUp, AlertCircle, Building2, Zap, Droplet, Wifi, Home, Receipt } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { getDashboardData, type DashboardData, type DashboardScope, type PriorityKind } from '../services/supabase';
import { getErrorMessage } from '../lib/getErrorMessage';
import Alert from '../components/atoms/Alert';
import StatusBadge from '../components/StatusBadge';
import { fmtMoney, fmtDate } from '../lib/format';

const MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const MONTHS_FULL = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

// Cor (CSS var do @theme) por status — usada no donut e na legenda.
const STATUS_VAR: Record<string, string> = {
  pago: 'var(--color-status-success-fg)',
  'a vencer': 'var(--color-status-info-fg)',
  vencido: 'var(--color-status-error-solid)',
  pendente: 'var(--color-status-neutral-fg)',
  prorrogado: 'var(--color-status-prorrogado-fg)',
  baixado: 'var(--color-status-baixado-fg)',
  'cartório': 'var(--color-status-warning-fg)',
  protestado: 'var(--color-status-error-fg)',
};
const statusColor = (s: string): string => STATUS_VAR[s] ?? 'var(--color-slate-300)';

// Paleta cíclica para donuts sem cor semântica por categoria (tipos de conta/pagamento).
// Só tokens --color-status-* já validados ≥3:1 sobre branco (preenchimento gráfico, 1.4.11).
const DONUT_PALETTE = [
  'var(--color-status-info-fg)',        // #1d4ed8 azul
  'var(--color-status-success-fg)',     // #15803d verde
  'var(--color-status-warning-fg)',     // #b45309 âmbar
  'var(--color-status-error-fg)',       // #b91c1c vermelho
  'var(--color-status-source-fg)',      // #0f766e teal
  'var(--color-status-prorrogado-fg)',  // #7c3aed violeta
  'var(--color-status-baixado-fg)',     // #0e7490 ciano
  'var(--color-status-neutral-fg)',     // #475569 slate
];
const paletteColor = (label: string, i: number): string =>
  label === 'outros' || label === 'não informado' ? 'var(--color-slate-300)' : DONUT_PALETTE[i % DONUT_PALETTE.length];

const PRIORITY_ICON: Record<PriorityKind, LucideIcon> = {
  agua: Droplet, luz: Zap, internet: Wifi, telefone: Receipt, aluguel: Home, tributo: Receipt, outro: Receipt,
};

export default function Dashboard() {
  // Estado inicial via inicializador LAZY — não chamar new Date() no corpo do render
  // (impureza; §5 / React Compiler). Ver achado A2-2.
  const [month, setMonth] = useState(() => new Date().getMonth());
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [scope, setScope] = useState<DashboardScope>('month');
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getDashboardData(month, year, scope));
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [month, year, scope]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const k = data?.kpis;
  const kpis: { icon: LucideIcon; label: string; amount: number; count: number; tone: 'neutral' | 'success' | 'muted' | 'danger' }[] = [
    { icon: FileText, label: scope === 'all' ? 'Total a pagar' : 'Total a pagar no mês', amount: k?.totalValue ?? 0, count: k?.totalCount ?? 0, tone: 'neutral' },
    { icon: CheckCircle2, label: 'Pagos', amount: k?.pagoValue ?? 0, count: k?.pagoCount ?? 0, tone: 'success' },
    { icon: Clock, label: 'A vencer', amount: k?.aVencerValue ?? 0, count: k?.aVencerCount ?? 0, tone: 'muted' },
    { icon: TrendingUp, label: 'A vencer em 7 dias', amount: k?.vencendoValue ?? 0, count: k?.vencendoCount ?? 0, tone: 'muted' },
    { icon: AlertCircle, label: 'Vencidas', amount: k?.vencidasValue ?? 0, count: k?.vencidasCount ?? 0, tone: 'danger' },
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="h-0.5 bg-linear-to-r from-brand to-brand-dark" />
      <div className="px-6 py-2 border-b border-slate-200 bg-white flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-sm font-semibold text-slate-800">Dashboard financeiro</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Contas a pagar · {scope === 'all' ? 'Todas as contas' : `${MONTHS_FULL[month]} ${year}`}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap justify-end">
          {/* Escopo: mês selecionado vs. todas as contas */}
          <div className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5" role="group" aria-label="Escopo do dashboard">
            <button
              onClick={() => setScope('month')}
              aria-pressed={scope === 'month'}
              className={`text-xs font-medium px-2.5 py-1 rounded-sm transition-colors ${scope === 'month' ? 'bg-white text-slate-800 shadow-xs' : 'text-slate-500 hover:text-slate-700'}`}
            >
              Este mês
            </button>
            <button
              onClick={() => setScope('all')}
              aria-pressed={scope === 'all'}
              className={`text-xs font-medium px-2.5 py-1 rounded-sm transition-colors ${scope === 'all' ? 'bg-white text-slate-800 shadow-xs' : 'text-slate-500 hover:text-slate-700'}`}
            >
              Todas as contas
            </button>
          </div>
          <div className={`flex gap-0.5 flex-wrap transition-opacity ${scope === 'all' ? 'opacity-40 pointer-events-none' : ''}`} aria-hidden={scope === 'all'}>
            {MONTHS.map((m, i) => (
              <button
                key={m}
                onClick={() => setMonth(i)}
                aria-label={`Mês ${MONTHS_FULL[i]}`}
                aria-pressed={i === month}
                className={`text-xs px-2 py-0.5 rounded-sm transition-colors ${i === month ? 'bg-brand-light text-brand-dark font-semibold' : 'text-slate-500 hover:bg-slate-100'}`}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {[year - 1, year, year + 1].map((y) => (
              <button
                key={y}
                onClick={() => setYear(y)}
                aria-pressed={y === year}
                className={`text-xs font-medium px-2.5 py-1 rounded-md border transition-colors ${y === year ? 'bg-brand-dark border-brand-dark text-white' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}
              >
                {y}
              </button>
            ))}
          </div>
          <button onClick={load} disabled={loading} className="btn">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Atualizar
          </button>
        </div>
      </div>

      {/* Região rolável precisa de acesso por teclado (WCAG 2.1.1): diferente de
          /consulta e /emails (cujos grids têm botões/checkboxes focáveis), o corpo do
          Dashboard só tem cards/gráficos não-focáveis — tabIndex=0 + região nomeada
          deixam o usuário de teclado focar e rolar (axe: scrollable-region-focusable). */}
      <div
        className="flex-1 overflow-y-auto px-6 py-3"
        tabIndex={0}
        role="region"
        aria-label="Indicadores e gráficos"
      >
        {error && (
          <Alert variant="error" className="mb-4">
            <strong>Erro:</strong> {error}
          </Alert>
        )}

        {/* Faixa de KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2 mb-3">
          {kpis.map(({ icon: Icon, label, amount, count, tone }) => {
            const borderLeft = tone === 'danger' ? 'border-l-status-error-solid' : tone === 'success' ? 'border-l-status-success-fg' : 'border-l-brand';
            const iconCls = tone === 'danger' ? 'bg-status-error-solid/10 text-status-error-fg' : tone === 'success' ? 'bg-status-success-bg text-status-success-fg' : 'bg-brand/10 text-brand';
            const valueCls = tone === 'danger' ? 'text-status-error-fg' : tone === 'success' ? 'text-status-success-fg' : tone === 'muted' ? 'text-slate-500' : 'text-slate-800';
            return (
              <div key={label} className={`flex items-center gap-2 rounded-lg p-2 border-l-2 bg-white shadow-xs hover:shadow-sm transition-shadow animate-fade-in-up ${borderLeft}`}>
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${iconCls}`}>
                  <Icon size={14} />
                </div>
                <div className="min-w-0">
                  <div className={`font-mono text-xl font-semibold leading-tight truncate ${valueCls}`}>{fmtMoney(amount)}</div>
                  <div className={`text-base leading-tight ${valueCls}`}>
                    {count}<span className="text-xs font-normal text-slate-500 ml-1">conta(s)</span>
                  </div>
                  <div className="text-xs text-slate-500 truncate">{label}</div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Movimentações mês a mês (largura total) */}
        <div className="card p-3 mb-3">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-800">Movimentações mês a mês</h3>
              <p className="text-xs text-slate-500">Total a pagar vs. pago por vencimento — {year}</p>
            </div>
            <span className="text-xs text-slate-500">valores em R$</span>
          </div>
          <MonthlyFlow data={data} />
        </div>

        {/* Três donuts na mesma linha: situação, tipos de conta e formas de pagamento */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
          <div className="card p-3">
            <div className="mb-2">
              <h3 className="text-sm font-semibold text-slate-800">Minha situação</h3>
              <p className="text-xs text-slate-500">Por status · {scope === 'all' ? 'Todas as contas' : MONTHS_FULL[month]}</p>
            </div>
            <StatusDonut data={data} />
          </div>

          <div className="card p-3">
            <div className="mb-2">
              <h3 className="text-sm font-semibold text-slate-800">Tipos de contas</h3>
              <p className="text-xs text-slate-500">Por tipo de documento · {scope === 'all' ? 'Todas as contas' : MONTHS_FULL[month]}</p>
            </div>
            <BreakdownDonut
              segs={(data?.documentTypeBreakdown ?? []).map((s) => ({ key: s.label, label: s.label, count: s.count }))}
              colorFor={paletteColor}
            />
          </div>

          <div className="card p-3">
            <div className="mb-2">
              <h3 className="text-sm font-semibold text-slate-800">Tipos de pagamentos</h3>
              <p className="text-xs text-slate-500">Por forma de pagamento · {scope === 'all' ? 'Todas as contas' : MONTHS_FULL[month]}</p>
            </div>
            <BreakdownDonut
              segs={(data?.paymentMethodBreakdown ?? []).map((s) => ({ key: s.label, label: s.label, count: s.count }))}
              colorFor={paletteColor}
            />
          </div>
        </div>

        {/* Ranking + Prioritárias */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="card p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-brand/10 text-brand"><Building2 size={14} /></span>
              <div>
                <h3 className="text-sm font-semibold text-slate-800">Ranking de fornecedores</h3>
                <p className="text-xs text-slate-500">Maiores valores no período</p>
              </div>
            </div>
            <SupplierRanking data={data} />
          </div>

          <div className="card p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-status-error-solid/10 text-status-error-fg"><Zap size={14} /></span>
              <div>
                <h3 className="text-sm font-semibold text-slate-800">Contas críticas e prioritárias</h3>
                <p className="text-xs text-slate-500">Água, luz, internet, aluguel, tributos e vencidas</p>
              </div>
            </div>
            <PriorityList data={data} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── sub-componentes (locais, não exportados) ────────────────────────────────

function MonthlyFlow({ data }: { data: DashboardData | null }) {
  const flow = data?.monthlyFlow ?? [];
  const max = Math.max(1, ...flow.flatMap((d) => [d.aPagar, d.pago]));
  return (
    <div>
      <div className="flex items-end gap-1.5 h-36">
        {flow.map((d) => (
          <div key={d.month} className="flex-1 flex flex-col items-center justify-end h-full gap-1">
            <div className="flex items-end gap-0.5 w-full justify-center h-full">
              {/* altura dinâmica → inline style (sem classe Tailwind equivalente) */}
              <div className="w-[42%] max-w-4 bg-brand rounded-t-sm transition-all" style={{ height: `${(d.aPagar / max) * 100}%` }} title={`A pagar: ${fmtMoney(d.aPagar)}`} />
              <div className="w-[42%] max-w-4 bg-slate-300 rounded-t-sm transition-all" style={{ height: `${(d.pago / max) * 100}%` }} title={`Pago: ${fmtMoney(d.pago)}`} />
            </div>
            <span className="text-xs text-slate-500">{MONTHS[d.month]}</span>
          </div>
        ))}
      </div>
      <div className="flex gap-4 justify-center mt-2.5">
        <span className="inline-flex items-center gap-1.5 text-xs text-slate-600"><span className="h-2 w-3.5 rounded-xs bg-brand" /> A pagar</span>
        <span className="inline-flex items-center gap-1.5 text-xs text-slate-600"><span className="h-2 w-3.5 rounded-xs bg-slate-300" /> Pago</span>
      </div>
    </div>
  );
}

// Donut genérico (conic-gradient + furo central + legenda). Reusado pelos três
// gráficos do Dashboard: situação por status, tipos de conta e formas de pagamento.
type DonutSeg = { key: string; label: string; count: number };

function BreakdownDonut({ segs, colorFor }: { segs: DonutSeg[]; colorFor: (label: string, i: number) => string }) {
  const total = segs.reduce((s, x) => s + x.count, 0) || 1;
  // Soma cumulativa sem mutar variável de closure no render (React Compiler).
  const stops = segs.map((s, i) => {
    const start = segs.slice(0, i).reduce((acc, x) => acc + x.count, 0);
    const a = (start / total) * 360;
    const b = ((start + s.count) / total) * 360;
    return `${colorFor(s.label, i)} ${a}deg ${b}deg`;
  });
  return (
    <div className="flex items-center gap-4">
      <div className="relative w-[120px] h-[120px] shrink-0">
        {/* gradiente cônico → inline style (sem equivalente Tailwind) */}
        <div className="w-full h-full rounded-full" style={{ background: `conic-gradient(${stops.join(', ') || 'var(--color-slate-200) 0deg 360deg'})` }} />
        <div className="absolute inset-4 rounded-full bg-white flex flex-col items-center justify-center shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)]">
          <span className="font-mono text-xl font-semibold text-slate-900 leading-none">{total}</span>
          <span className="text-xs text-slate-500 mt-0.5">contas</span>
        </div>
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        {segs.map((s, i) => (
          <div key={s.key} className="flex items-center gap-2 text-xs">
            <span className="h-2.5 w-2.5 rounded-xs shrink-0" style={{ background: colorFor(s.label, i) }} />
            <span className="text-slate-700 capitalize flex-1 truncate">{s.label}</span>
            <span className="font-mono text-slate-900 font-semibold">{s.count}</span>
            <span className="text-slate-600 w-9 text-right">{Math.round((s.count / total) * 100)}%</span>
          </div>
        ))}
        {!segs.length && <span className="text-xs text-slate-500">Sem contas no período.</span>}
      </div>
    </div>
  );
}

// Situação por status: cor semântica por nome de status (ignora o índice da paleta).
function StatusDonut({ data }: { data: DashboardData | null }) {
  const segs = (data?.statusBreakdown ?? []).map((s) => ({ key: s.status, label: s.status, count: s.count }));
  return <BreakdownDonut segs={segs} colorFor={(label) => statusColor(label)} />;
}

function SupplierRanking({ data }: { data: DashboardData | null }) {
  const rows = data?.supplierRanking ?? [];
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="text-xs text-slate-500 py-4">Sem contas no período.</p>;
  return (
    <div>
      {rows.map((r, i) => (
        <div key={r.name} className="flex items-center gap-2.5 py-2">
          <span className={`shrink-0 h-5.5 w-5.5 rounded-full text-xs font-bold flex items-center justify-center ${i < 3 ? 'bg-brand-dark text-white' : 'bg-slate-200 text-slate-600'}`}>{i + 1}</span>
          <div className="flex-1 min-w-0">
            <div className="flex justify-between gap-2 mb-1">
              <span className="text-sm font-medium text-slate-700 truncate">{r.name}</span>
              <span className="font-mono text-sm font-semibold text-slate-900 whitespace-nowrap">{fmtMoney(r.value)}</span>
            </div>
            <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
              {/* largura dinâmica → inline style */}
              <div className="h-full bg-brand rounded-full transition-all" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
            </div>
          </div>
          <span className="shrink-0 text-xs text-slate-500 w-14 text-right">{r.count} conta(s)</span>
        </div>
      ))}
    </div>
  );
}

function PriorityList({ data }: { data: DashboardData | null }) {
  const rows = data?.priorityAccounts ?? [];
  if (!rows.length) return <p className="text-xs text-slate-500 py-4">Nenhuma conta crítica ou prioritária no período.</p>;
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => {
        const Icon = PRIORITY_ICON[r.kind];
        const err = r.critical || r.status === 'vencido';
        return (
          <div key={r.id} className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border border-l-2 ${err ? 'bg-status-error-bg border-status-error-border border-l-status-error-solid' : 'bg-white border-slate-200/80 border-l-brand'}`}>
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${err ? 'bg-status-error-solid/10 text-status-error-fg' : 'bg-brand/10 text-brand'}`}>
              <Icon size={15} />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-slate-700 truncate">{r.supplier}</div>
              {/* slate-600 (não slate-500): nas linhas críticas o card é bg-status-error-bg
                  (vermelho-claro) e slate-500 dá 4,35:1 (reprova AA); slate-600 dá ~7:1. */}
              <div className="text-xs text-slate-600">vence {fmtDate(r.due)}</div>
            </div>
            <span className={`font-mono text-sm font-semibold whitespace-nowrap ${err ? 'text-status-error-fg' : 'text-slate-900'}`}>{fmtMoney(r.amount)}</span>
            <StatusBadge value={r.status} />
          </div>
        );
      })}
    </div>
  );
}
