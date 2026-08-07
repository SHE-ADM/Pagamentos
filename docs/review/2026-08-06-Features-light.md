# Code Review — Features / filtro de planos em uso + portal do menu + busca em memória (2026-08-06)

## Resumo
Alvo: nenhum (review do diff completo). O plano executado foi inferido do próprio delta e do
bloco correspondente do `CLAUDE.md`, que veio no mesmo diff. Este delta é a **continuação** do
estado revisado em `docs/review/2026-08-05-Features-light.md`: os dois achados 🟡 daquele
relatório aparecem **corrigidos** aqui (`periodBeforeRange` substituiu a condição por estado do
período; o cancelamento do apply pendente ganhou o teste `"Limpar" dentro da janela descarta o
filtro pendente`).
Modo: light (sem passo de ataque, sem verificação adversarial)
Delta: 8 arquivos alterados, 0 novos, +1339/−133 linhas (o untracked `docs/review/2026-08-05-…`
é relatório anterior, excluído do conjunto pelo rito)
Régua: `CLAUDE.md` do projeto (Regras mandatórias 1/2/5/6; seções "BARRA DE FILTROS…",
"FILTROS DEDICADOS…", "DOIS seletores de data…", "BUSCA AUTOMÁTICA…", `lib/stableOrder.ts`) +
`CLAUDE.md` do workspace
Gates: vitest frontend-vite **814/814** (142 arquivos, `--maxWorkers=1`) · api-backend 523/523 ·
portal-next 2/2 · pytest **1100/1100** · lint **0/0** nos 4 workspaces · typecheck **OK** nos 4 ·
ts-prune **0** · **e2e Playwright não executado — exige navegador (o renderer crasha no sandbox
do agente)**

O delta continua bem raciocinado, e as três mudanças de fundo desta rodada estão certas: o filtro
passou a oferecer só planos **em uso** (com o `!inner` e a consulta pelo lado do cadastro, com o
token do usuário — a escolha certa em relação à RLS), a digitação deixou de ir à rede por tecla, e
o menu saiu por portal para escapar do contêiner que o cortava. Os testes novos observam o que
prometem — em especial a contagem (`toHaveBeenCalledTimes(1)`/`toHaveBeenCalledWith()` sem
argumento) em vez de um `toHaveBeenCalled()` que continuaria verde com o defeito.

Encontrei **um bloqueante**: um filtro escolhido dentro da janela de 300 ms e seguido de um clique
num botão de mês é **descartado da consulta mas permanece visível no controle** — divergência
persistente entre o que a tela mostra e o que foi consultado. Confirmado por sonda executada
(vermelho medido, arquivo removido em seguida). E **um recomendado**: a nova consulta paginada
não usa desempate único, contrariando uma regra 🔴 explícita do projeto.

## Achados

### 🔴 Bloqueantes

- [apps/frontend-vite/src/pages/Consulta.tsx:842] `applyPeriod` descarta o patch pendente do
  portão de filtros **sem incorporá-lo a `applied`**, enquanto `f` o preserva — o filtro fica
  visível no controle e ausente da consulta, de forma persistente.
  Falha:     usuário escolhe "Tipo Documento = boleto" e, dentro dos 300 ms da janela de
             coalescência, clica no botão do mês "Mar". `resetFilterGate()` joga fora
             `pendingApply = {docType:'boleto'}`; `setF` mantém `docType:'boleto'` (o `<select>`
             continua exibindo "boleto"); `setApplied((a) => ({...a, ...patch}))` grava **só**
             `month/year`. Resultado: o grid, o "Valor total" e o "Total de registros" consultam
             **todos os tipos** de março, com a tela afirmando que só boletos estão filtrados.
             A divergência **não se resolve sozinha**: `pendingApply` carrega apenas o *patch*,
             nunca `f` inteiro, então qualquer filtro seguinte aplica sobre um `applied` que
             continua sem `docType`. Só some ao clicar "Buscar"/"Limpar"/num card, ou ao trocar o
             valor do próprio select (re-selecionar o MESMO valor não emite `change`). Vale
             igualmente para os botões de ano e "Todas" (mesmos call sites) e para qualquer um dos
             7 controles do portão.
  Evidência: sonda executada sobre `Consulta.test.tsx` (cópia temporária, removida depois) —
             `fireEvent.change(docType='boleto')` seguido de `fireEvent.click(mês)`: o select ficou
             com `value === 'boleto'` (asserção verde) e a última chamada a
             `getFinancialAccountControl` veio com `"docType": ""`, `"month": 2`. Código:
             `Consulta.tsx:842-847` usa patch parcial nos dois setters, ao contrário de
             `handleSearch` (`:819-826`), que monta `next = {...f, …}` e por isso preserva o
             pendente.
  Correção:  em `applyPeriod`, derivar o próximo estado de `f` como o `handleSearch` já faz —
             `const next = { ...f, ...patch }; setF(next); setApplied(next);` —, mais um teste de
             regressão no formato da sonda.
  Regra:     `CLAUDE.md` § "BUSCA AUTOMÁTICA: portão único de aplicação em `/consulta`" — o portão
             existe para que "todo filtro aplica sozinho"; e § "DOIS seletores de data…", que
             estabelece o invariante de não deixar a barra "mentindo" sobre o que está filtrado
             ("sem isso o mês seguiria aceso mentindo").

### 🟡 Recomendados

- [apps/frontend-vite/src/services/supabase.ts:482] `listUsedChartAccountDescriptions` pagina por
  `offset` ordenando por uma coluna **não única** (`account_description`), sem desempate pela PK.
  Falha:     `financial_chart_of_account` tem descrições repetidas por construção (a mesma
             descrição existe em vários centros de custo — é o que o próprio teste
             "deduplica a descrição repetida entre centros de custo" exercita). `ORDER BY
             account_description` não define ordem total; com paginação por offset, cada página é
             uma consulta nova e o PostgreSQL pode devolver linhas empatadas em ordem diferente
             conforme o plano. Se o cadastro com uso passar de 1.000 linhas, uma linha pode ser
             **pulada** entre a página N e a N+1; sendo ela a única portadora de uma descrição, a
             opção **some do filtro sem erro nenhum** — exatamente o desfecho que o comentário da
             própria função diz querer evitar ("o corte do PostgREST em Max rows volta HTTP 200 —
             sumiria opção sem erro nenhum"). Não alcançável hoje (85 linhas), mas a paginação só
             existe para o caso de crescer, e é justamente aí que ela erra.
  Evidência: `supabase.ts:482` — `order: 'account_description.asc'` com
             `offset: page * USED_CHART_ACCOUNTS_PAGE`. É a **única** listagem paginada do arquivo
             fora de `stableOrder`: as outras três (`:132` `received_at.desc`, `:662`
             `created_at.desc`, `:797` `logged_at.desc`) passam pelo helper.
  Correção:  `order: stableOrder({ fallback: 'account_description.asc', tiebreak: 'chart_account_id' })`
             (a PK, migration 050), e uma asserção no teste de paginação já existente.
  Regra:     `CLAUDE.md` § 🔴 "PAGINAÇÃO POR OFFSET EXIGE DESEMPATE ÚNICO — `lib/stableOrder.ts`
             (2026-08-03, não regredir)": "Todo `order` de listagem paginada passa por
             `stableOrder(...)`".

### 🔵 Opcionais

- [apps/frontend-vite/src/components/molecules/ChartAccountSelect.tsx:204] O objeto `styles`
  (`menuPortal`) é recriado a cada render; poderia ser constante de módulo, como o projeto já faz
  com mapas de variante.
- [apps/frontend-vite/src/services/supabase.ts:466] `USED_CHART_ACCOUNTS_MAX_PAGES = 5` corta em
  5.000 opções **em silêncio** — com o teto estrutural em 611 é folga confortável, mas um
  `console.warn` (ou um comentário registrando o corte como impossível hoje) evitaria o mesmo
  "cap silencioso" que a regra do projeto proíbe em outros contextos.
- [apps/frontend-vite/src/components/molecules/ChartAccountSelect.tsx:123] `loadCatalog` tem
  `isFilter` como dependência, mas `catalogRef` não é invalidado se a variante mudar. Inalcançável
  hoje (nenhum call site alterna `variant` numa mesma instância).

## Pendências (trabalho incompleto)
Nenhuma. A varredura de marcadores (`TODO|FIXME|HACK|XXX|WIP`, `@todo`, `todo:`) sobre o diff e os
untracked não retornou ocorrências; também não há stub, `it.skip`, `console.log` nem bloco de
debug no delta.

## Drift código × documentação
- `CLAUDE.md` § "BARRA DE FILTROS de `/consulta` — GRADE ÚNICA de 8 colunas" tem dois bullets que
  se contradizem sobre a mesma classe: um diz "🔴 A sobra da direita é absorvida pela BUSCA —
  `w-full min-w-max`" (que é o código real, `Consulta.tsx:1078`, e o que o teste de alinhamento
  observa), e o seguinte diz "🔴 O `overflow-x-auto` + **`w-max`** do wrapper não é cosmético".
  A classe `w-max` sozinha não existe no componente — decisão pendente do usuário sobre atualizar
  o segundo bullet (não sincronizo doc durante o review, por guard-rail do rito).

## Não coberto
- **e2e Playwright / axe em navegador**: não executado (regra do `CLAUDE.md` — o renderer do
  Chromium crasha no sandbox do agente). Duas mudanças deste delta **só** se verificam ali:
  (a) o `menuPortalTarget` de fato resolve o clipe do menu sob render real, e (b) o `zIndex: 50`
  do portal é suficiente perante os elementos fixos da página (sidebar, barra de progresso).
  jsdom não faz layout; os guardas do delta são estruturais, o que é o formato correto, mas não
  substitui a verificação visual. **Sugestão: rodar `npm run test:e2e` na sua máquina antes de
  mergear.**
- **Confronto com a lista de itens do pedido**: um comentário de teste cita "Item 9 do pedido"
  (`Consulta.test.tsx`), indicando um checklist que não está versionado no repositório. Sem esse
  documento não foi possível confrontar item a item o que foi pedido com o que o diff entrega —
  as pendências acima cobrem apenas marcadores e sinais no código.
- **Leitura parcial de `Consulta.tsx`**: o arquivo tem ~1.400 linhas; li o diff por inteiro e os
  blocos adjacentes relevantes (estado, `load`, efeitos, todos os handlers de filtro, render da
  barra). As regiões fora do delta (grid, painel de detalhe, modais de edição/exclusão, exportação)
  não foram relidas.
- **Comportamento sob >1.000 planos em uso** (o cenário do achado R1) não foi medido contra o
  banco — o dado real está em 85 linhas, então o caminho de múltiplas páginas nunca é exercido em
  produção hoje; a análise é do código e da regra, não de medição.

---

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| B1 | `applyPeriod` descartava o filtro pendente e não o incorporava a `applied` | ✅ corrigido | `Consulta.tsx:842` — passa a derivar de `f` (`const next = { ...f, ...patch }`), mesmo formato de `handleSearch`. Guarda novo em `Consulta.test.tsx`: `navegar por mês PRESERVA o filtro escolhido dentro da janela` — validado por mutante (restaurar o patch parcial deixa o teste VERMELHO; mutante revertido com confirmação por `diff -q`) |
| R1 | Paginação por offset sem desempate único em `listUsedChartAccountDescriptions` | ✅ corrigido | `supabase.ts:482` — `stableOrder({ fallback: 'account_description.asc', tiebreak: 'chart_account_id' })`. Asserção sobre o valor INTEIRO do `order` no teste `consulta pelo CADASTRO com embed !inner` — validada por mutante (voltar à string literal deixa o teste VERMELHO; revertido com confirmação) |

Gates após a correção: vitest frontend-vite **815 (+1)** · api-backend 523 · portal-next 2 ·
pytest 1100 · lint 0/0 · typecheck OK · ts-prune 0
Baseline (Passo 3):   vitest frontend-vite 814 · api-backend 523 · portal-next 2 ·
pytest 1100 · lint 0/0 · typecheck OK · ts-prune 0

Re-review do diff da correção: **sem achado novo**. O diff da correção são 4 hunks em 3 arquivos.
Verificações feitas sobre ele: (a) `applyPeriod` passa a ler `f` do closure — os 4 call sites
(seletor de tipo de data, botão de mês, botão de ano, "Todas") são handlers de evento distintos,
nunca encadeados no mesmo tick, e um deles já lia `f.year` do mesmo closure; é o precedente que
`handleSearch` estabelece no próprio arquivo; (b) nenhum caminho de erro novo, nenhuma mudança de
assinatura ou de contrato consumido em outro lugar; (c) `stableOrder` já era importado
(`supabase.ts:26`), sem dependência nova, e `chart_account_id` é a PK do cadastro consultado
(migration 050), coberta pela policy de SELECT da migration 049; (d) os dois testes novos têm
asserção de sanidade além da asserção-alvo, e ambos foram validados por mutante em série (nunca em
paralelo — regra do `CLAUDE.md`).

Não corrigido por decisão sua:
- **Drift no `CLAUDE.md`** (bullet que cita `w-max` onde o código usa `w-full min-w-max`) — o rito
  não sincroniza documentação durante o review; qual lado ajustar é decisão sua.
- **Os 3 achados 🔵 opcionais** — são preferência, e mexer neles infla o diff da correção.
- **Verificação em navegador (`npm run test:e2e`)** — exige ambiente que o sandbox não tem.

Nada foi commitado.
