// src/components/dashboard/DonutCard.tsx
// Card de donut = ChartCard + BreakdownDonut. Absorve o adaptador
// `.map((s) => ({ key: s.label, label: s.label, value: s.value }))` que estava repetido
// em TODOS os 6 call sites dos dois dashboards — cada cópia era uma chance de divergir
// (ex.: esquecer o `key` e cair no índice do array).
//
// Aceita a fatia ESTRUTURALMENTE (`{ label, value }`), não o tipo `LabelSlice` do serviço:
// o componente não precisa saber de onde o dado vem, e o `count` (que ele não usa desde
// que a legenda passou a mostrar só R$) fica fora do contrato.
import { BreakdownDonut, type DonutSize } from './BreakdownDonut';
import { ChartCard } from './ChartCard';
import { paletteColor } from './chartColors';

interface DonutSlice {
  label: string;
  value: number;
}

interface DonutCardProps {
  title: string;
  subtitle: string;
  /** `undefined` enquanto carrega/em erro → donut vazio ("Sem contas no período."). */
  slices: readonly DonutSlice[] | undefined;
  size?: DonutSize;
  dense?: boolean;
  /** Diâmetro CONTÍNUO (px) que sobrepõe `size` — repassado ao BreakdownDonut. Ver o
   *  comentário de `diameterPx` em BreakdownDonut.tsx (escala proporcional entre donuts). */
  diameterPx?: number;
  /** Cor por fatia; o padrão é a paleta cíclica (situação usa a semântica). */
  colorFor?: (label: string, i: number) => string;
  /** Classe extra da MOLDURA, repassada ao `ChartCard` (que a mescla com `cn`/tailwind-merge,
   *  então a classe do chamador vence a da variante). Hoje só `/dashboard_despesas`, com
   *  `self-start` no donut que divide a linha do grid com o card de ranking — ver o
   *  comentário da grade lá. */
  className?: string;
  /** Ao clicar numa fatia da legenda, recebe o RÓTULO da fatia (drill-down). Sem ele, o
   *  donut fica não-interativo (comportamento atual dos demais call sites). */
  onSliceSelect?: (label: string) => void;
}

export function DonutCard({
  title,
  subtitle,
  slices,
  size,
  dense = false,
  diameterPx,
  colorFor = paletteColor,
  className,
  onSliceSelect,
}: Readonly<DonutCardProps>) {
  // `key` = o próprio label: as fatias vêm de uma agregação por label (breakdownBy usa um
  // Map cujas chaves são os labels), então são únicas por construção.
  const segs = (slices ?? []).map((s) => ({ key: s.label, label: s.label, value: s.value }));
  // Sem `icon`: o donut nunca leva ícone (a casca com ícone serve aos rankings/listas).
  return (
    <ChartCard title={title} subtitle={subtitle} dense={dense} className={className}>
      <BreakdownDonut
        segs={segs}
        colorFor={colorFor}
        size={size}
        diameterPx={diameterPx}
        onSelect={onSliceSelect ? (seg) => onSliceSelect(seg.label) : undefined}
      />
    </ChartCard>
  );
}
