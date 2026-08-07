# Code Review — Features / `/consulta` card + datagrid (2026-08-07)

## Resumo

**Alvo:** `/consulta card datagrid` — **nenhum documento de plano corresponde ao termo**
(`git ls-files '*.md' | grep -iE 'consulta|datagrid|card'` não retornou nada; os únicos `.md`
que casam são o `CLAUDE.md` e relatórios de review anteriores). Não inventei um plano: a
referência de pendências foi o próprio `CLAUDE.md` (§ "BARRA DE FILTROS de `/consulta`",
§ "Frontend — componentes e design system", § "Regras mandatórias").

**Modo:** light (sem passo de ataque, sem verificação adversarial)

**Delta:** 13 arquivos alterados, 0 novos revisáveis, **+2.041 / −214** linhas.
(3 arquivos untracked são relatórios de review anteriores em `docs/review/` — excluídos do
conjunto pelo próprio rito, não por escolha.)

**Régua:** `CLAUDE.md` (projeto) · `CLAUDE.md` do workspace · `docs/padrao-execucao.md` ·
`.claude/rules/` do workspace.

**Gates:**
`vitest frontend-vite 830/830` (série, `--maxWorkers=1`) ·
`vitest api-backend 523/523` · `vitest portal-next 2/2` · `pytest 1100/1100` ·
`eslint frontend-vite 0 erros / 0 warnings` · `tsc --noEmit OK` · `ts-prune 0` ·
`e2e Playwright a11y: **não executado** — o renderer do Chromium crasha no sandbox do agente`
(limitação de ambiente já registrada no `CLAUDE.md`; roda no workflow `a11y.yml` a cada PR).

**Baseline:** o `eslint` estava **VERMELHO antes desta sessão** (2 erros
`no-unnecessary-type-assertion` em `Consulta.test.tsx`, ambos em linhas adicionadas por
trabalho não commitado de sessão anterior — confirmado por `git diff -U0`, aparecem como `+`).
Foram corrigidos durante a implementação, não durante este review.

O delta é uma sequência de três trabalhos sobre a mesma tela: (1) filtros dedicados de
classificação contábil + grade única de 8 colunas + busca automática; (2) portais para tirar o
menu de colunas e o menu do plano de contas de dentro do `overflow-x-auto`; (3) a barra de
seleção do grid para o cabeçalho da página, eliminando a faixa reservada de 48px. A lógica de
filtros (`queueApply`, `periodBeforeRange`, precedência intervalo × período) foi exercitada
caso a caso e está correta, com cobertura de teste densa e várias guardas validadas por
mutante. **Nenhum bloqueante.** Os três achados recomendados são todos de **layout sob pressão
horizontal/vertical** e de **cobertura a11y** — nenhum deles é observável nas resoluções em que
o trabalho foi feito, e nenhum é pego por teste em jsdom, que não faz layout.

---

## Achados

### 🔴 Bloqueantes

Nenhum.

### 🟡 Recomendados

- **[apps/frontend-vite/src/pages/Consulta.tsx:955-985]** O cabeçalho da página pode **crescer
  em altura** quando a barra de seleção aparece em viewport estreita — reintroduzindo, em
  miniatura, o salto que mover a barra para lá existe para eliminar.

  **Falha:** notebook 1366×768 com a sidebar aberta (208px) → largura útil ≈ 1.110px. O
  cabeçalho passa a ter três itens flex: título (~190px) + barra de seleção (~580px:
  "3 selecionadas" + select de situação + "Aplicar" + "Exportar selecionadas" + ✕) + bloco de
  botões (~330px), mais 2 gaps de 12px e `px-6` dos dois lados ≈ **1.170px**. Sob essa pressão
  o bloco do título — que recebeu `min-w-0` nesta mudança — encolhe **abaixo do `min-content`**
  e o texto quebra em duas linhas; o cabeçalho vai de 38px para ~58px e o grid inteiro desce
  ~20px ao marcar a primeira conta. O mesmo vale para o conteúdo da barra, que também quebra
  (nenhum dos rótulos tem `whitespace-nowrap`).

  **Evidência:** `<div className="min-w-0">` envolvendo `<h1 className="text-sm …">` e
  `<p className="text-xs …">`, sem `truncate` nem `whitespace-nowrap`. `min-w-0` remove o piso
  `min-width: auto` (= `min-content`), que é exatamente o que impedia o encolhimento antes.
  ⚠️ Números obtidos por **aritmética das classes Tailwind, não medidos em navegador** — o
  `CLAUDE.md` já exige essa distinção para a coluna 1 da grade de filtros.

  **Correção:** `truncate` no `<h1>` e no `<p>` (o título encolhe com reticências, sem crescer
  em altura) e `whitespace-nowrap` no rótulo "N selecionadas" do `GridToolbar`.

  **Regra:** a própria justificativa do slot no JSX ("nada salta ao aparecer") e o precedente
  do `CLAUDE.md` § "Destaque dos cards de KPI" (`-translate-y` foi escolhido justamente por não
  deslocar vizinhos).

- **[apps/frontend-vite/src/pages/Consulta.a11y.test.tsx:45-108]** A barra de seleção **nunca é
  varrida pelo axe** — o arquivo tem 3 casos e nenhum marca uma linha.

  **Falha:** o cabeçalho, que antes tinha só título + 2 botões, passa a hospedar 5 controles
  novos num estado que nenhum gate observa. Concreto e já presente: com uma linha marcada o
  cabeçalho exibe **dois botões cujo nome começa com "Exportar"** — "Exportar carregados (50)"
  e "Exportar selecionadas" — lado a lado na mesma linha; qualquer violação introduzida ali
  (contraste do `bg-brand/5`, nome acessível ambíguo, ordem de foco) passa em `830/830`.

  **Evidência:** `grep -n "it("` no arquivo devolve apenas os 3 casos (página em repouso,
  `aria-describedby` do seletor de intervalo, Label in Name do "Buscar").

  **Correção:** acrescentar um caso que clica em "Selecionar todas as linhas" e roda
  `axe(container)` sobre o estado com seleção.

  **Regra:** `CLAUDE.md` § "Acessibilidade (WCAG 2.1 AA)" — "todo componente/página relevante
  ganha um `*.a11y.test.tsx`"; precedente explícito de `DashboardHeader.a11y.test.tsx`, que
  cobre "os dois estados que mudam a árvore acessível".

- **[apps/frontend-vite/src/components/molecules/ColumnVisibilityMenu.tsx:80-89]** O painel
  portalizado clampa **só o eixo X**; não há limite vertical nem `maxHeight`.

  **Falha:** viewport de 768px de altura (≈ 678px de `innerHeight` com a barra do navegador) —
  o botão "Colunas" fica em `bottom ≈ 350`, e o painel mede ~332px (`p-2` + título +
  `max-h-72` = 288px), terminando em ~686px. A parte de baixo fica fora da tela e, por ser
  `position: fixed`, **rolar a página não a traz** — pior, a rolagem fecha o menu por decisão de
  desenho. Restam só a rolagem interna do `<ul>` e uma janela visível cada vez menor.

  **Evidência:** `measure()` calcula `top: r.bottom + 4` sem nenhum clamp, enquanto `left` é
  clampado em duas camadas contra `window.innerWidth`. A assimetria é o defeito.

  **Correção:** limitar a altura ao espaço disponível
  (`maxHeight: window.innerHeight - top - VIEWPORT_MARGIN`) ou abrir acima do botão quando não
  couber abaixo. **Não é regressão** — antes o painel era clipado por completo pelo
  `overflow-x-auto`; é um fix incompleto para viewports curtas.

### 🔵 Opcionais

- [apps/frontend-vite/src/components/molecules/ColumnVisibilityMenu.tsx:5] `PANEL_WIDTH = 288`
  duplica o `w-72` da classe; divergem em silêncio se a classe mudar (hoje protegido só por
  comentário). Poderia sair do próprio `style`.
- [apps/frontend-vite/src/pages/Consulta.tsx:1073] `applyPeriod({ dateField })` não tem efeito
  enquanto houver intervalo De/Até preenchido (o intervalo vence o período): o select muda e a
  consulta não. Sem indicação na tela.
- [apps/frontend-vite/src/pages/Consulta.tsx:1340] "Buscar em todos os períodos" não limpa
  `dateFrom`/`dateTo`, então com intervalo ativo ele **não** alarga de fato — o nome acessível
  promete mais do que o clique entrega. (Preservar o intervalo do usuário é defensável; o
  rótulo é que fica ambíguo.)

---

## Pendências (trabalho incompleto)

Nenhuma. Varredura de marcadores (`TODO|FIXME|HACK|XXX|WIP`, `@todo`, `@pendente`, `todo:`)
sobre o diff versionado **e** os untracked: 0 ocorrências. Nenhum `it.skip`/`xit`, nenhum
`console.log`/`debugger`, nenhum stub.

---

## Drift código × documentação

Nenhum identificado. O `CLAUDE.md` foi atualizado **durante a implementação** (turno anterior a
este review), não durante o review — a passagem que afirmava o invariante oposto ("a faixa da
barra de seleção tem a altura RESERVADA `min-h-12` mesmo vazia" / "a barra de SELEÇÃO não vai
junto") foi reescrita junto com o código que a tornou falsa. Registro aqui por transparência,
porque o rito proíbe sincronizar doc **dentro** do review.

---

## Não coberto

- **Nenhuma medição em navegador real.** Os achados R1 e R3 vêm de aritmética das classes
  Tailwind; jsdom não faz layout, então nenhum teste da suíte pode confirmá-los ou refutá-los.
  Confirmar em tela antes de tratar os números como fato.
- **`e2e/*.a11y.e2e.ts` (Playwright + axe) não executado** — o renderer do Chromium crasha no
  sandbox do agente. É a camada que pegaria contraste e ordem de foco sob render efetivo,
  inclusive no cabeçalho alterado. Roda no workflow `a11y.yml` a cada PR.
- **`CLAUDE.md` (+287 linhas no delta) lido por seção, não por inteiro** — foram lidas as
  seções que o código do delta toca; o arquivo tem ~4.100 linhas.
- **Superfície adjacente verificada:** `GridToolbar` também serve `/emails` e
  `/cobranca/erros`; o caminho inline foi preservado por construção (as duas props novas são
  `undefined` lá) e continua coberto por `DataGrid.test.tsx` e pelos casos sem portal de
  `GridToolbar.test.tsx`. `grep` confirmou que nada mais no repositório referencia `.min-h-12`.
- **Modo light:** sem passo de ataque e sem contestação adversarial — **nenhum achado deste
  relatório leva marca `[verificado]`**. Os três recomendados são inferências de layout
  sustentadas por leitura de CSS, não por execução.

---

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| R1 | Cabeçalho cresce/quebra linha com a barra de seleção em viewport estreita | ✅ corrigido | `Consulta.tsx:962-964` (`truncate` no `<h1>` e no `<p>`) + `GridToolbar.tsx:118` (`whitespace-nowrap` no "N selecionadas"). Guarda: `Consulta.test.tsx` — "o título do cabeçalho encolhe sem quebrar linha". **Mutante A** (remover `truncate`) → VERMELHO |
| R2 | Barra de seleção nunca varrida pelo axe | ✅ corrigido | `Consulta.a11y.test.tsx` — novo caso "com linhas selecionadas (barra de seleção no cabeçalho)". **Mutante D** (remover o `aria-label` do ✕) → VERMELHO com `button-name`, provando que o caso alcança a barra |
| R3 | Painel de colunas `fixed` sem limite vertical | ✅ corrigido | `ColumnVisibilityMenu.tsx:80-99,139-150` — `maxHeight` pelo espaço disponível + abre ACIMA quando embaixo não cabe; painel `flex-col overflow-hidden` e lista `flex-1` para rolar dentro do limite. Guardas: 3 casos em "contenção vertical". **Mutante B** (remover `maxHeight` do style) → 2 VERMELHOS |

**Gates após a correção:** `vitest frontend-vite 835/835 (+5)` · `vitest api-backend 523/523` ·
`pytest 1100/1100` · `eslint 0/0` · `tsc OK` · `ts-prune 0`
**Baseline (Passo 3):** `vitest frontend-vite 830/830` · `vitest api-backend 523/523` ·
`pytest 1100/1100` · `eslint 0/0` (após a correção pré-review) · `tsc OK` · `ts-prune 0`

**Re-review do diff da correção: 2 achados novos, ambos corrigidos na mesma fase.**

1. `ColumnVisibilityMenu.test.tsx` — o `as DOMRect` do mock virou erro
   `no-unnecessary-type-assertion`; o `eslint` ficou **vermelho pela minha própria correção** e
   foi pego pelo re-gate, não pela leitura. Removido.
2. `ColumnVisibilityMenu.test.tsx` — o helper escrevia `window.innerHeight` (global do jsdom)
   **sem restaurar**: qualquer caso acrescentado depois herdaria 678px sem saber. É a mesma
   classe de defeito que o `CLAUDE.md` registra na lição do `MainDryRunTest`. Resolvido com
   `afterEach` restaurando o valor original.

Segunda rodada de re-review (só o `afterEach` + o import): sem achado novo.

**Não corrigido por decisão sua:**

- Os **3 opcionais** (🔵) — são preferência e inflariam o diff da correção.
- **Documentação:** o `CLAUDE.md` enumera "três detalhes que o portal obriga" no
  `ColumnVisibilityMenu`; a contenção vertical é um **quarto**, e o bloco da barra de seleção
  não menciona o `truncate` do título como parte da garantia de "nada salta". Não sincronizei —
  o rito proíbe mexer em doc de estado durante a correção. Diga se quer que eu atualize.
- **Verificação em navegador:** R1 e R3 foram corrigidos a partir de leitura de CSS; os guardas
  travam a DECISÃO (classes, `maxHeight`, lado de abertura), não o pixel. Confirmar em tela —
  e, no CI, pelo workflow `a11y.yml`.

Nada foi commitado.

---

## Opcionais resolvidos (rodada 2 — a pedido do usuário)

| # | Opcional | Desfecho | Observação |
|---|---|---|---|
| O1 | `PANEL_WIDTH` duplicava o `w-72` | ✅ corrigido | A largura saiu para o `style` a partir da própria constante e a classe `w-72` foi removida — o número que dimensiona e o que alinha passaram a ser um só. Guarda: `ColumnVisibilityMenu.test.tsx` — "a largura do painel é a MESMA que alinha a borda direita com a do botão" (`left + width === r.right`, e a classe `w-\d` proibida). **Mutante** (largura de volta à classe) → VERMELHO |
| O2 | "Tipo de data" sem efeito com intervalo ativo | ✅ corrigido — **por outro caminho** | **A classificação original estava errada.** Os botões de mês limpam `dateFrom`/`dateTo` ao serem clicados, então o controle não é inútil: é **diferido** — é a coluna que passa a valer no mesmo clique que limpa o intervalo. Desabilitá-lo (a correção que eu havia proposto) obrigaria a apagar as datas antes de escolher a coluna, piorando o fluxo. Em vez disso: nome acessível mais preciso ("Tipo de data **do período**") + `aria-describedby` com a ressalva, mesmo padrão já usado no seletor do intervalo. Guarda: `Consulta.a11y.test.tsx` — "a ressalva do seletor de período chega à descrição acessível". **Mutante** (remover o `aria-describedby`) → VERMELHO |
| O3 | "Buscar em todos os períodos" mentia com intervalo ativo | ✅ corrigido | Nome acessível **dinâmico** (`searchButtonName`): sem intervalo, "Buscar em todos os meses e anos"; com intervalo, "Buscar mantendo o intervalo de datas". Preserva o que o usuário digitou (limpar o intervalo no clique seria perda silenciosa de entrada) e para de prometer o que não faz. Ambos contêm "Buscar" — WCAG 2.5.3. Guarda: caso a11y ampliado para **os dois estados**. **Mutante** (nome estático de novo) → VERMELHO |

**Achado NOVO encontrado no re-review desta rodada — e é da pior categoria:**

`Consulta.test.tsx` — "o grid vazio nomeia o mês em vigor **e aponta o caminho de alargar**"
**não asseverava a segunda metade do próprio nome.** Só o trecho `Nenhum registro em <mês>/<ano>`
era observado; a frase que manda usar o "Buscar" não era olhada por ninguém. A prova apareceu
sozinha: ao alinhar o texto da mensagem com o novo nome do botão, **nada ficou vermelho**. É
exatamente o defeito que o `CLAUDE.md` § Regra 2 descreve — teste verde que faz parar de olhar.
Corrigido comparando a mensagem com o **nome acessível do próprio botão** (em vez de repetir a
frase), para que instrução e anúncio não possam divergir. **Mutante** (mensagem volta a "todos
os períodos") → VERMELHO.

**Gates após a rodada 2:** `vitest frontend-vite 837/837 (+2)` · `vitest api-backend 523/523` ·
`vitest portal-next 2/2` · `pytest 1100/1100` · `eslint 0/0` · `tsc OK` · `ts-prune 0`

**Continua não corrigido / pendente de decisão sua:**

- **Documentação (`CLAUDE.md`).** Acumulou 4 pontos a atualizar: a contenção vertical do painel
  de colunas (é um 4º item na lista "detalhes que o portal obriga"), o `truncate` do título como
  parte da garantia de "nada salta", a largura do painel vindo do `style`, e o nome dinâmico do
  botão de busca. Não sincronizei — o rito proíbe mexer em doc de estado durante a correção.
- **Verificação em navegador.** Tudo foi corrigido a partir de leitura de CSS; os guardas travam
  a decisão (classes, `maxHeight`, `left + width`, nomes acessíveis), não o pixel.

Nada foi commitado.
