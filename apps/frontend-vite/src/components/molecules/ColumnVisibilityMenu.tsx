import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Columns, ArrowLeftToLine, ArrowRightToLine, Minus } from 'lucide-react';

/**
 * Largura do painel, em px. É a MESMA constante que `measure()` usa para alinhá-lo pela
 * direita do botão — por isso ela vai ao `style`, e não a uma classe `w-*`: com a largura
 * numa classe, trocar o `w-72` por `w-80` desalinharia o painel em 32px **sem erro e sem
 * teste vermelho**, porque o cálculo continuaria subtraindo 288. Um número, um lugar.
 */
const PANEL_WIDTH = 288;
/** Folga mínima da borda da janela, para o painel não encostar no limite do viewport. */
const VIEWPORT_MARGIN = 8;
/**
 * Altura abaixo da qual não vale a pena abrir para baixo — cabe o título e ~2 itens. Serve
 * só de desempate: com menos que isto embaixo E mais espaço em cima, o painel abre acima.
 */
const PANEL_MIN_HEIGHT = 160;

/** Estado de fixação de uma coluna: borda esquerda, direita ou nenhuma. */
export type PinSide = 'left' | 'right' | false;

/** Descritor de uma coluna no menu de gestão (desacoplado do `table` do TanStack). */
export interface ColumnMenuItem {
  id: string;
  label: string;
  visible: boolean;
  /** Coluna que não pode ser ocultada (ex.: seleção) — checkbox desabilitado. */
  canHide: boolean;
  pin: PinSide;
}

interface ColumnVisibilityMenuProps {
  items: ColumnMenuItem[];
  onToggleVisible: (id: string, visible: boolean) => void;
  onSetPin: (id: string, pin: PinSide) => void;
}

interface PinButtonProps {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}

function PinButton({ active, label, onClick, children }: Readonly<PinButtonProps>) {
  const tone = active
    ? 'bg-brand-dark text-white border-brand-dark'
    : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50';
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={`flex h-6 w-6 items-center justify-center rounded-sm border transition-colors ${tone}`}
    >
      {children}
    </button>
  );
}

/**
 * Menu (popover) para gerenciar colunas do DataGrid: mostrar/ocultar e fixar
 * (esquerda/nenhuma/direita). Fecha ao clicar fora ou via Escape. O botão expõe
 * `aria-expanded`/`aria-haspopup`; cada controle tem nome acessível.
 */
export default function ColumnVisibilityMenu({
  items,
  onToggleVisible,
  onSetPin,
}: Readonly<ColumnVisibilityMenuProps>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Painel PORTALIZADO para o body — ver o porquê em `position`, abaixo. O ref existe porque
  // o clique-fora deixou de poder olhar só o wrapper: com o painel fora da subárvore, um
  // clique DENTRO dele cairia no `!contains` e fecharia o menu no primeiro checkbox marcado.
  const panelRef = useRef<HTMLDivElement>(null);
  // Posição em coordenadas de viewport (`position: fixed`). `null` = ainda não medida.
  // `maxHeight` acompanha: sendo `fixed`, o que passar do rodapé da janela fica FORA de
  // alcance — rolar a página não move um elemento fixo, e a rolagem ainda fecha o menu.
  const [position, setPosition] =
    useState<{ top: number; left: number; maxHeight: number } | null>(null);

  // O painel é `fixed` num portal no body, e não `absolute` ao lado do botão, porque a toolbar
  // do grid vive na barra de filtros de /consulta — dentro de um `overflow-x-auto` cujo
  // `overflow-y` computa para `auto` e CORTA na vertical. Inline, o painel nascia clipado: a
  // gestão de colunas ficava inutilizável na tela, sem erro nenhum. É o mesmo mecanismo (e a
  // mesma correção) do menu do ChartAccountSelect.
  //
  // Mede o BOTÃO (`currentTarget` do clique), não o wrapper: `div.relative` é block-level e,
  // fora de um contêiner flex, esticaria à largura disponível — o alinhamento pela direita
  // sairia na borda do contêiner, não na do botão. Hoje o único consumidor é a GridToolbar
  // (flex), onde os dois coincidem; medir o botão remove a dependência desse detalhe.
  const measure = (botao: HTMLElement) => {
    const r = botao.getBoundingClientRect();
    // Alinhado à DIREITA do botão (equivale ao antigo `right-0`), preso ao viewport para que
    // um botão perto da borda não empurre o painel para fora da tela.
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, r.right - PANEL_WIDTH),
      Math.max(VIEWPORT_MARGIN, window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN),
    );
    // Altura: só o eixo X era clampado, e a assimetria era o defeito. Num viewport de 768px
    // (≈678 de `innerHeight`) o painel de ~332px aberto a partir de `bottom ≈ 350` terminava
    // em ~686 e perdia os últimos itens sem nenhuma indicação. Abre ABAIXO quando couber;
    // senão, ACIMA do botão, se lá houver mais espaço. O que sobrar vira `maxHeight`, e a
    // lista interna (`max-h-72 overflow-y-auto`) passa a rolar dentro do que é visível.
    const abaixo = window.innerHeight - r.bottom - 4 - VIEWPORT_MARGIN;
    const acima = r.top - 4 - VIEWPORT_MARGIN;
    const cabeAbaixo = abaixo >= Math.min(PANEL_MIN_HEIGHT, acima);
    setPosition(
      cabeAbaixo
        ? { top: r.bottom + 4, left, maxHeight: abaixo }
        : { top: Math.max(VIEWPORT_MARGIN, r.top - 4 - acima), left, maxHeight: acima },
    );
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const alvo = e.target as Node;
      // DOIS nós: o wrapper (botão) e o painel portalizado. Sem o segundo, clicar num
      // checkbox do painel fecharia o menu.
      const dentro = ref.current?.contains(alvo) || panelRef.current?.contains(alvo);
      if (!dentro) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    // Rolagem/redimensionamento movem o botão sem mover um elemento `fixed`: em vez de
    // perseguir o rect a cada quadro, o menu FECHA — é o comportamento previsível e evita um
    // painel flutuando descolado do controle que o abriu. `capture` para pegar a rolagem de
    // qualquer contêiner interno, que não borbulha.
    //
    // ⚠️ A lista de colunas TEM rolagem própria (`max-h-72 overflow-y-auto`) e, com o grid de
    // /consulta em ~14 colunas, rolar até a coluna procurada é o uso normal. Sem esta guarda o
    // menu se fecharia no meio dessa rolagem — o `capture` alcança justamente os contêineres
    // internos. `resize` não tem alvo dentro do painel, então cai no `setOpen(false)`.
    const onReflow = (e: Event) => {
      const alvo = e.target;
      if (alvo instanceof Node && panelRef.current?.contains(alvo)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    };
  }, [open]);

  const hiddenCount = items.filter((i) => !i.visible).length;

  const painel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Gerenciar colunas"
      // `fixed` + coordenadas medidas do botão. O `w-72` tem de casar `PANEL_WIDTH`, que é o
      // que alinha o painel pela direita do botão.
      // A largura vem de `PANEL_WIDTH` (ver a constante) e `position` traz top/left/maxHeight.
      // Espalhar `position` nulo é no-op — o painel só é montado com a posição já medida, e
      // isto apenas evita um ramo a mais para um estado que não acontece.
      style={{ width: PANEL_WIDTH, ...position }}
      // `flex flex-col` + `overflow-hidden`: com `maxHeight` no painel, é o que faz a lista
      // (`flex-1`) absorver a sobra e rolar DENTRO do que é visível, em vez de o conteúdo
      // vazar por baixo da borda.
      className="fixed z-40 flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white p-2 shadow-lg"
    >
          <p className="px-2 py-1 text-xs font-semibold uppercase tracking-widest text-slate-500">
            Colunas
          </p>
          <ul className="max-h-72 flex-1 overflow-y-auto">
            {items.map((item) => (
              <li key={item.id} className="flex items-center gap-2 rounded-sm px-2 py-1 hover:bg-slate-50">
                <label className="flex flex-1 cursor-pointer items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={item.visible}
                    disabled={!item.canHide}
                    aria-label={`Mostrar coluna ${item.label}`}
                    onChange={(e) => onToggleVisible(item.id, e.target.checked)}
                    className="h-4 w-4 cursor-pointer accent-brand disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <span className="truncate">{item.label}</span>
                </label>
                <div className="flex items-center gap-1">
                  <PinButton
                    active={item.pin === 'left'}
                    label={`Fixar ${item.label} à esquerda`}
                    onClick={() => onSetPin(item.id, item.pin === 'left' ? false : 'left')}
                  >
                    <ArrowLeftToLine size={13} />
                  </PinButton>
                  <PinButton
                    active={item.pin === false}
                    label={`Não fixar ${item.label}`}
                    onClick={() => onSetPin(item.id, false)}
                  >
                    <Minus size={13} />
                  </PinButton>
                  <PinButton
                    active={item.pin === 'right'}
                    label={`Fixar ${item.label} à direita`}
                    onClick={() => onSetPin(item.id, item.pin === 'right' ? false : 'right')}
                  >
                    <ArrowRightToLine size={13} />
                  </PinButton>
                </div>
              </li>
            ))}
      </ul>
    </div>
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          // Mede ANTES de abrir: com a posição já no estado, o painel nasce no lugar certo em
          // vez de aparecer no canto e saltar depois de um efeito.
          if (!open) measure(e.currentTarget);
          setOpen((v) => !v);
        }}
        className="btn"
      >
        <Columns size={14} />
        <span>Colunas</span>
        {hiddenCount > 0 && (
          <span className="badge bg-brand/10 text-brand">{hiddenCount} ocultas</span>
        )}
      </button>

      {open && createPortal(painel, document.body)}
    </div>
  );
}
