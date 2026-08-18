---
name: frontend-ui
description: >-
  Trabalhar na interface do app interno do projeto `pagamentos` (React 19 + Vite 8 + Tailwind v4,
  Atomic Design, SEM shadcn/ui). Cobre o catálogo de componentes, o `DataGrid` sobre TanStack
  Table, a barra de filtros de `/consulta`, os dois dashboards, os tokens de cor e tamanho, as
  variantes `cva` e as armadilhas de layout que já deixaram controles inalcançáveis na tela.
  Acione SEMPRE que o usuário disser "grid", "coluna", "filtro da consulta", "dashboard", "KPI",
  "donut", "componente novo", "token de cor", "Tailwind", "modal", "anexo na tela", ou quando a
  alteração tocar `apps/frontend-vite/src/` — mesmo sem dizer "skill".
---

# Frontend — `apps/frontend-vite`

**Detalhe dos dois dashboards:** [docs/knowledge/dashboards.md](../../../docs/knowledge/dashboards.md).
**CRUDs e contratos de API:** [docs/knowledge/api-crud.md](../../../docs/knowledge/api-crud.md).

## Stack e o que NÃO fazer

React **19** · Vite **8** (Rolldown) · TypeScript **6** · Tailwind **v4 CSS-first** (`@theme`/
`@utility` em `src/index.css` — **não há `tailwind.config.ts`**) · Zod **4** · ESLint **10**.

🔴 **Sem shadcn/ui e sem os templates Sheild Canvas** — não rode `npx shadcn@latest init` aqui.
🔴 **Sem `useMemo`/`useCallback`/`React.memo` manuais** — o React Compiler (transform ativo no
build) cuida da memoização.

## Camadas (toda UI pertence a uma)

| Camada | Definição |
|---|---|
| `atoms/` | elemento sem filhos de domínio (input, botão, badge) |
| `molecules/` | composição de atoms |
| `organisms/` | componente com estado e lógica de negócio |
| `dashboard/` | primitivos de gráfico compartilhados pelas duas telas de dashboard |

**Variantes vivem em `cva`** (`class-variance-authority`) + helper `cn()` (`src/lib/cn.ts`).
Definição `cva` que não é componente vai em arquivo separado (`*.variants.ts`) para não disparar
`react-refresh/only-export-components`. Exceção aceita: `cva` **local e não exportado**.

🔴 **Tailwind JIT: string literal completa em ternário.** `${on ? 'bg-a' : 'bg-b'}` é correto;
`bg-${var}` **não gera CSS** — e o componente fica sem estilo, em silêncio. Vale também para mapa
de classes por tamanho (`SIZE_CLS` no `BreakdownDonut`).

## Tokens

| Paleta | Uso | Não misturar com |
|---|---|---|
| `loginGreen-*` | telas de auth v2 (`LoginPage`) | — |
| `bg-gradient-auth` / `auth-*` | Forgot/Reset | `loginGreen` |
| `status-*` | feedback, badges, banners no app | cores default do Tailwind |
| `brand` / `sidebar` | dashboard, navegação | — |

🔴 **Nunca hex hardcoded nem cor default do Tailwind (`red-*`, `amber-*`…) para estado
semântico** — o token é a fonte única. A exceção explícita é o **chrome neutro do `DataGrid`**
(`slate-*`/`zinc-*` para fundo, borda e ícone), que não é estado semântico.

🔴 **Todo TEXTO do grid cumpre AA**, mesmo no chrome neutro: cabeçalho `*-600`, sub-linha `*-500`
(label) / `*-600` (valor), vazio `*-500`. Texto branco usa `bg-brand-dark`, nunca `bg-brand`
sólido (3,4:1).

**Tamanhos:** usar o token mais próximo (`text-sm`, não `text-[15px]`). **Nunca reintroduzir
`text-[Npx]`.** Exceções aceitas são só de layout (`max-w-[21rem]`, `border-[6px]`,
`object-[center_25%]`).

## `DataGrid` (organisms/DataGrid.tsx)

Headless sobre TanStack Table v8. Interface retrocompatível; features novas são **opt-in**.

🔴 **Sort e filtro são SERVER-SIDE.** `manualSorting` ligado. **Nunca** ligar
`getSortedRowModel`/`getFilteredRowModel`/`getPaginationRowModel` — o grid recebe linhas já
filtradas pelo servidor, então modelo client-side agiria sobre um subconjunto.

🔴 **`ColumnDef.size`/`minSize` são IGNORADOS sem `enableColumnManagement`.** Sem essa prop a
tabela é `w-full` (não `table-fixed`) e o navegador quebra o texto. Em grid não-gerenciado, o fix
é `className: 'whitespace-nowrap'` no `ColumnDef` — aumentar o `size` não tem efeito nenhum.

🔴 **Render das células sem `flexRender`** — o renderer é chamado direto (`cellValue`) para
preservar o valor cru que o `title` da truncagem exige.

🔴 **Viewport com `maxBodyHeight` leva `tabIndex={0}` + `aria-label`** (violação `serious`
`scrollable-region-focusable`). É **sem opt-in**: uma prop opcional reintroduziria o modo de
falha no próximo grid sem conteúdo focável. ⚠️ O jsdom **não pega** — a guarda em jsdom é
estrutural (`getByRole('region')` + `tabindex`); a prova é a camada e2e.

**Virtualização** (`enableRowVirtualization`, usado em `/consulta`): técnica **spacer-rows**
(preserva `table-fixed`, larguras e sticky). Fallback sem layout (jsdom) renderiza tudo.
⚠️ **Auto-recuperação do `scrollRect`**: trocas de aba fazem o cache defasar e o grid renderiza
~4 linhas com o corpo em branco — o efeito que re-mede no `visibilitychange`/`focus` não se remove.

## Barra de filtros de `/consulta` — grade única de 8 colunas

O template é declarado **uma vez**
(`grid-cols-[minmax(25rem,1fr)_16.5rem_11rem_10rem_10rem_8.5rem_8.5rem_8.5rem]`) e as duas linhas
se alinham por construção.

🔴 **Quatro `col-start-*` explícitas, e nenhuma é estilo:** o cursor do auto-placement nunca anda
para trás, então cada posição depende da anterior — mexer numa desloca as seguintes **em
silêncio**. Já aconteceu duas vezes. As quatro estão travadas em teste junto do template.

🔴 **Tracks em comprimento explícito, NUNCA `1fr` cru** — `fr` tem mínimo `min-content`, e o
`min-content` de um `<select>` é a opção mais longa. Se precisar, `minmax(0, 1fr)`.

🔴 **Todo popover dentro do `overflow-x-auto` precisa de PORTAL.** `overflow-x: auto` faz o Y
computar para `auto` também, então o menu nasce **clipado** e a funcionalidade fica inutilizável
sem erro nenhum. Vale para `ColumnVisibilityMenu` e `ChartAccountSelect variant="filter"`.
⚠️ **Portal só na variante `filter`** — no `form` o select vive num `<dialog>` com `showModal()`,
que pinta na top layer; portal para o body ficaria **atrás** do modal.

O portal obriga cinco cuidados, todos travados em teste: clique-fora olha **dois nós**; fecha ao
rolar **exceto** na rolagem da própria lista; posição medida do **botão**; clamp nos **dois
eixos** (com abertura para cima quando não cabe embaixo); e a **largura sai do `style`**, da mesma
constante que alinha o painel.

🔴 **Os controles do grid e a barra de seleção saem por PORTAL** (`toolbarControlsTarget`,
`toolbarSelectionTarget`) — cada um com **três** valores: ausente = inline, elemento = portal,
`null` = portal pedido com nó ainda não montado (**não renderiza nada naquele quadro**). Sem o
terceiro caso, os botões pulam de lugar entre o 1º e o 2º render.

⚠️ A barra de seleção no cabeçalho usa **`py-0.5`** (34px do `.btn` + 4 = exatos 38px do bloco de
título). Com o `py-1.5` inline ela mediria 46px e o cabeçalho **cresceria 8px** ao marcar a
primeira conta. E o título leva `truncate` + `min-w-0`, o rótulo leva `whitespace-nowrap`: sob
pressão horizontal o texto quebraria e o cabeçalho cresceria assim mesmo.

## Busca e aplicação de filtro

- **Debounce de 350 ms** entre o estado de **formulário** e o **aplicado**, com `cleanup` e guarda
  `if (form === aplicado) return`.
- **Portão único de aplicação** (`queueApply`) com janela de **300 ms** — aplicar no `onChange` de
  cada controle daria ~14 requisições ao compor um filtro de 7 campos, e `<select>` nativo no
  Firefox emite `change` a cada opção percorrida com as setas.
- 🔴 **O pendente é ESTADO, não ref** — ref lido dentro da cadeia montada no render cai em
  `react-hooks/refs`.
- ⚠️ **Teste de "não consulta" com `flush()` (0 ms) é falso guarda** — não alcança a janela de
  300 ms. Guarda de ausência com debounce exige avançar o tempo.

🔴 **`applyFinancialFilters` recebe o objeto de filtros INTEIRO e o repassa** — destrinchar campo
a campo faz um filtro novo ser descartado **em silêncio** enquanto o grid o respeita.

🔴 **Filtro em recurso embutido exige `!inner`.** Sem ele, `chart_account.x=eq.N` devolve a tabela
**inteira** com HTTP 200 — a tela mostra a base completa como se estivesse filtrada. Medido: 706
contra 198.

🔴 **O valor de `eq.` vai CRU, nunca entre aspas** — o oposto do `ilikeContains`. O PostgREST só
interpreta aspas **dentro de lista** (`or=`, `in.()`).

### Intervalo De/Até × período por mês — as duas regras que o enxugamento quase perdeu

🔴 **Com intervalo preenchido o seletor do PERÍODO fica SUSPENSO — e NÃO se desabilita por isso.**
O intervalo tem precedência no serviço, então trocar a coluna do período não muda a consulta na
hora; a tentação óbvia é desabilitar o controle. Não faça: **clicar num mês LIMPA o intervalo**, e
é justamente essa coluna que passa a valer no mesmo clique. Desabilitado, o usuário teria de apagar
as duas datas **antes** de poder escolher a coluna — o controle ficaria inerte exatamente no
instante em que vai ser usado. A ressalva viaja por `PERIOD_DATE_FIELD_HINT` (`Consulta.tsx`), em
`aria-describedby` + `sr-only`, não só no `title`. Travado por
`Consulta.test.tsx` › "o seletor do período NÃO é desabilitado pelo intervalo".

🔴 **O caminho de volta guarda o VALOR anterior (`periodBeforeRange`), não um booleano nem um
default fixo.** Apagar as duas datas deixaria o usuário preso em escopo global — toda a base,
nenhum mês em destaque — sem nenhuma ação que explicasse isso. Ele devolve o período **exato** que
o intervalo substituiu. E é `null` para quem escolheu o escopo global de propósito (card de KPI,
"Buscar"): essa gente **não** pode ser estreitada em silêncio, e é a diferença entre valor e
booleano que sustenta a distinção. A memorização é auto-limitante (só grava quando havia mês/ano),
senão o 2º campo do intervalo sobrescreveria a memória com nulo.

🔴 **`ChartAccountSelect`: só o SUCESSO é memoizado** (`if (opts.length > 0)` em `handleMenuOpen`).
`loadOptions` engole a exceção e devolve `[]`; gravar esse `[]` marcaria "já carregado" e a guarda
de reentrada bloquearia **toda abertura seguinte** — uma indisponibilidade momentânea da Next API
no instante da 1ª abertura deixava o menu vazio pelo resto do mount. Lista legitimamente vazia
custa uma requisição por abertura: preço barato para não **fossilizar uma falha**. Travado pelo par
`ChartAccountSelect.test.tsx` › "não repete a carga a cada abertura" + "retenta na abertura seguinte
quando a 1ª carga falhou" — os dois juntos, porque cada um sozinho é satisfeito pelo defeito oposto.

## Paginação

🔴 **Paginação por offset exige desempate único** (`lib/stableOrder.ts` → anexa a PK). `ORDER BY
coluna` não define ordem total com empates, e cada página é uma consulta nova: uma linha empatada
aparece **duplicada** e outra **some** — o sintoma pior, porque não gera erro. Empates são a
norma: ordenar por Situação empata **682 de 682**.

🔴 **2ª barreira: `appendUniqueById`** no scroll infinito — o reader grava a cada 5 min e uma
inserção desloca a janela do offset. **Preserva a versão já em tela**, senão a curadoria em voo
piscaria de volta.

> ⚠️ **"O grid mostra o valor antigo depois de eu corrigir no banco" NÃO é regressão.** Uma linha
> carregada antes de uma correção feita por fora continua exibindo o valor velho enquanto a aba
> viver. Confira o dado no banco e recarregue antes de investigar o extrator.

## Dashboards

🔴 **`/dashboard_despesas` é exclusivo do escopo Despesas+Custo** — `isExpenseRow` aplicado
**antes de qualquer agregação**.
🔴 **Top-N de donut é por VALOR (R$), nunca por contagem de linhas.**
🔴 **Ranking agrega pela IDENTIDADE (id da FK), nunca pelo texto** — os cadastros não têm UNIQUE
em descrição e homônimos seriam fundidos numa linha somada.
🔴 **Fatia/linha só vira `<button>` quando recebe `onSelect`** (evita S1082).
🔴 **`kpiFilterSuffix` declara a ressalva de recorte no subtítulo** — card que afirma escopo mais
largo do que mostra faz o leitor concluir o oposto do dado.

**Casca compartilhada:** `useDashboardFilters` (estado) + `DashboardHeader` + `KpiRow`. O header
recebe **um objeto `filters`**, não 12 props soltas — props soltas reprovaram o quality gate do
SonarCloud por duplicação. `setMonth`/`setYear` **limpam** o filtro de KPI; `setScope` **não**.

## Build

- **Rotas lazy** (`React.lazy` + `Suspense`) — só `LoginPage` no bundle inicial.
- **Recuperação de chunk obsoleto** (`lib/chunkReload.ts` + `ErrorBoundary`): deploy novo invalida
  hashes e a rota lazy 404 → sem a rede, tela branca.
- `manualChunks` é **função** no Vite 8 (Rolldown), não objeto.
- `resolve.tsconfigPaths: true` é nativo — **não reintroduzir** `vite-tsconfig-paths`.
- `skipLibCheck: true` é obrigatório nos 4 `tsconfig.json`.

## Gates

```powershell
npm test --workspace=apps/frontend-vite -- --maxWorkers=1
npm run lint ; npm run typecheck ; npm run prune
```

⚠️ Medir com `--maxWorkers=1`: em paralelo o sandbox derruba ~9 casos de a11y por esgotamento de
recursos — falso alarme, não regressão.
