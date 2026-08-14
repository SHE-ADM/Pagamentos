// src/components/organisms/aiChatProgress.ts
// O estado do turno EM ANDAMENTO do assistente e como rotulá-lo.
//
// Em arquivo próprio pelo mesmo motivo dos `*.variants.ts` do projeto: exportar uma função de um
// módulo que também exporta componente dispara `react-refresh/only-export-components`, e o gate de
// lint aqui é 0 erros e 0 warnings. De quebra, o widget (que precisa só do tipo) deixa de depender
// do módulo do painel, que é carregado por `lazy()`.

/**
 * O turno em andamento: texto parcial e ferramentas do turno.
 *
 * `rows === undefined` numa ferramenta significa **ainda executando** — é o que distingue o chip
 * "consultando…" do chip já concluído. Um campo separado (`done: boolean`) seria redundante e
 * abriria a chance de os dois discordarem.
 */
export interface StreamingState {
  /** Texto acumulado da mensagem CORRENTE do assistente (reiniciado a cada nova mensagem). */
  text: string;
  tools: ReadonlyArray<{ name: string; rows?: number; error?: string }>;
}

/**
 * O que dizer enquanto o turno acontece.
 *
 * DOIS estados, não três: "aguardando o modelo decidir" e "consultando o banco" são indistinguíveis
 * para quem espera — ambos querem dizer "aguarde" —, e um rótulo a mais só mudaria de texto sem
 * informar nada. O que muda de verdade é a resposta COMEÇAR A CHEGAR, e é esse o estado que ganha
 * rótulo próprio.
 *
 * Importa especialmente para quem usa leitor de tela: os chips e o texto parcial ficam
 * `aria-hidden` (mudam dezenas de vezes por turno dentro de um `role="log"` e seriam reanunciados a
 * cada token), então este rótulo é o único progresso que essa pessoa recebe. Por isso ele muda
 * pouco e diz algo verdadeiro.
 */
export function rotuloDoProgresso(streaming: StreamingState | null): string {
  return streaming && streaming.text !== ''
    ? 'Escrevendo a resposta…'
    : 'Consultando os dados…';
}
