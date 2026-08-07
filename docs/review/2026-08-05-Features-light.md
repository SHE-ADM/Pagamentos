# Code Review — Features / busca automática + 2 seletores de data + grade única (2026-08-05)

## Resumo
Alvo: nenhum (review do diff completo) — o plano executado foi inferido do próprio delta e do
bloco correspondente do `CLAUDE.md`, que veio no mesmo diff: grade única de 8 colunas, dois
seletores de data independentes (`rangeDateField`) e portão único de aplicação (busca automática).
Modo: light (sem passo de ataque, sem verificação adversarial)
Delta: 5 arquivos alterados, 0 novos, +537/−101 linhas
Régua: `CLAUDE.md` do projeto (Regras mandatórias 1/2/5/6; seções "FILTROS DEDICADOS…",
"BUSCA AUTOMÁTICA…", "DOIS seletores de data…") + `CLAUDE.md` do workspace
Gates: vitest frontend-vite 798/798 (142 arquivos, `--maxWorkers=1`) · lint 0/0 nos 4 workspaces ·
typecheck OK nos 4 · ts-prune 0 · **pytest não executado — o delta não toca Python** ·
**e2e Playwright não executado — exige navegador (o renderer crasha no sandbox do agente)**

O delta é coeso e bem raciocinado: as três decisões de fundo (colunas de data separadas, portão
com coalescência, grade estrutural) estão certas e vêm com guardas de teste que de fato observam
o que prometem — em particular o par de mão dupla `intervalo × período` em `supabase.test.ts`,
que é o formato correto para travar independência. Não encontrei defeito bloqueante. O que
encontrei foi **um caminho de volta assimétrico** que estreita a consulta em silêncio quando o
escopo global não veio do intervalo, e **a ausência de teste para o cancelamento do apply
pendente** — este último confirmado por mutante: remover `cancelPendingApply()` de `handleClear`
deixa os 36 testes de `Consulta.test.tsx` **verdes**.

## Achados

### 🔴 Bloqueantes
Nenhum.

### 🟡 Recomendados

- [apps/frontend-vite/src/pages/Consulta.tsx:745] O "caminho de volta" restaura o mês corrente
  mesmo quando o escopo global **não** foi causado pelo intervalo — estreitando a consulta em
  silêncio com o card de KPI ainda aceso.
  Falha:     usuário clica o card "Vencidas" (escopo global, `month=null`/`year=null`), digita
             `De = 2026-01-01` para conferir um período e depois **apaga** o campo. O ramo
             `else if (merged.month == null && merged.year == null)` dispara e grava
             `month/year = mês corrente`. Resultado: a tela passa a mostrar só as vencidas **do
             mês atual**, com o card "Vencidas" continuando destacado como se fosse global — a
             mesma classe de incoerência que o próprio código diz evitar ("senão o card
             'Vencidas' ficaria aceso exibindo contas pagas", linha 762). Idêntico após
             "Buscar" (que é justamente o botão cuja função passou a ser *alargar* para toda a
             base): tocar e limpar uma data devolve o usuário ao mês corrente sem nenhuma ação
             que explique. Numa consulta de contas a pagar, "não achei a conta vencida" por
             recorte silencioso é o desfecho caro.
  Evidência: `Consulta.tsx:739-750` — a condição de restauro é o **estado** do período
             (`month == null && year == null`), não o **fato** de o intervalo o ter zerado.
             `handleCardFilter` só limpa `activeCard` quando o card é `avencer7`
             (`Consulta.tsx:764`), então os cards `pago`/`avencer`/`vencidas` permanecem acesos.
             O caso simétrico (sem card, mês corrente → define data → apaga data) está correto e
             é o que o teste novo `apagar as duas datas devolve o período ao mês/ano corrente`
             cobre; o caso do escopo global não tem teste.
  Correção:  condicionar o restauro a ter sido o intervalo quem zerou o período — um flag de
             estado ligado no ramo que zera e desligado no restauro e nos caminhos síncronos
             (Buscar/Limpar/card/período).
  Regra:     `CLAUDE.md` § "BUSCA AUTOMÁTICA…" — "**apagar as duas datas RESTAURA** o mês/ano
             corrente — sem esse caminho de volta o usuário fica preso em escopo global". O
             "preso" pressupõe que foi o intervalo que o levou até lá; quem escolheu global de
             propósito não está preso.

- [apps/frontend-vite/src/pages/Consulta.tsx:720] `cancelPendingApply` não tem nenhuma guarda de
  teste: os quatro caminhos síncronos podem perder a chamada sem que a suíte acuse.
  Falha:     usuário escolhe "Grupo = Despesas Fixas" e, dentro dos 300 ms, clica em "Limpar".
             Sem o cancelamento, o efeito de coalescência dispara depois e reaplica o patch
             antigo sobre o estado já limpo — o filtro "volta sozinho" na tela, sem erro. O
             mesmo vale para "Buscar", clique em card e navegação por mês.
  Evidência: mutante executado nesta revisão — removida a linha `cancelPendingApply();` de
             `handleClear` (`Consulta.tsx:788`), `npx vitest run src/pages/Consulta.test.tsx`
             devolveu **36 passed / 36**. O comentário das linhas 718-719 promete exatamente a
             garantia que nenhuma asserção observa.
  Correção:  um caso que dispara `qf(...)` e, **sem esperar a janela**, aciona um caminho
             síncrono, avançando o tempo depois e asserindo que o filtro descartado não
             reapareceu em `applied`.
  Regra:     `CLAUDE.md` Regra mandatória 2 — "Teste que promete uma garantia tem de entregá-la"
             e "validação por mutante: teste que não falha quando o defeito existe não é teste".

- [apps/frontend-vite/src/pages/Consulta.tsx:724] O comentário de `queueApply` diz que o patch é
  acumulado "num ref", contradizendo a implementação (estado) e a justificativa registrada 380
  linhas acima.
  Falha:     `Consulta.tsx:347-352` explica que `pendingApply` é **estado e não ref** porque com
             ref a leitura dentro dos handlers cai na regra `react-hooks/refs` (cadeia
             `cards → onCardClick` construída no render). O comentário de `queueApply` afirma o
             oposto; quem confiar nele e "restaurar" o ref reintroduz o erro de lint que a
             decisão existe para evitar — e neste projeto comentário é tratado como contrato.
  Evidência: `Consulta.tsx:724-725`: "acumula o patch num ref com UM timer só" × `Consulta.tsx:352`
             `const [pendingApply, setPendingApply] = useState<...>(null)`.
  Correção:  trocar "num ref" por "no estado `pendingApply`" no comentário.
  Regra:     `CLAUDE.md` Regra mandatória 5 (disables/decisões justificados no comentário) e o
             padrão do projeto de registrar o porquê load-bearing junto do código.

### 🔵 Opcionais

- [apps/frontend-vite/src/pages/Consulta.test.tsx:692] O guarda de coalescência
  (`toHaveBeenCalledTimes(1)`) depende de tempo real: medido ~90 ms por `user.selectOptions`
  contra a janela de 300 ms (~3,3× de folga por intervalo). Sob carga vira vermelho espúrio —
  falha ruidosa, não falso verde. Fake timers com `advanceTimers` eliminariam a dependência.
- [apps/frontend-vite/src/pages/Consulta.tsx:801] Trocar `rangeDateField` com De/Até vazios
  dispara 3 requisições (grid + valor total + contagem) cujo resultado é idêntico. O no-op é
  documentado como deliberado; o custo de rede não é.
- [apps/frontend-vite/src/pages/Consulta.tsx:798] A ressalva de dado do `payment_date`
  (`RANGE_DATE_FIELD_HINT`) vive só no `title`, que não aparece no toque, não é focável e, com
  `aria-label` presente, não é anunciado de forma confiável. É a informação que explica por que
  "Pagamento" + Situação "a vencer" devolve 0 linhas.
- [apps/frontend-vite/src/pages/Consulta.tsx:715] "Buscar" mudou de semântica (aplicar filtros →
  alargar para todos os períodos) sem mudar o rótulo; a explicação existe só no `title`. Um
  usuário por hábito clicará nele e verá o escopo saltar do mês para a base inteira.

## Pendências (trabalho incompleto)
- [apps/frontend-vite/src/pages/Consulta.tsx:720] `cancelPendingApply` sem teste nos 4 call
  sites — **recomendada** (mesmo item de R2, listado aqui por ser lacuna de cobertura, não
  defeito de código escrito).
- Nenhum marcador `TODO`/`FIXME`/`HACK`/`WIP`, stub, `it.skip`, `it.only` ou `console.log` no
  delta (varredura executada sobre o diff; não há arquivos untracked).

## Drift código × documentação
Nenhum. O bloco novo do `CLAUDE.md` confere com o código no que verifiquei ponto a ponto: o
template `grid-cols-[22.5rem_11rem_11rem_10rem_10rem_9rem_9rem_6rem]` é literalmente o do JSX; a
medida "~1520 px de viewport" fecha (88,5rem de tracks + 3,5rem de gaps + `px-6` = 1520 px); a
regra de `activeCard` (`statusId`, e o intervalo quando o card é `avencer7`) e a saída do
`refreshStats` do efeito de `applied` estão como descrito — confirmei que os 8 pontos que mudam
dado seguem chamando `refreshStats()`.

Observação (não é drift, é omissão): o `CLAUDE.md` descreve o caminho de volta como
incondicional, o que é exatamente a formulação que o achado R1 mostra estar errada. Se a correção
de R1 for aceita, esse parágrafo passa a precisar da condição — **não sincronizei o documento**,
por ser decisão sua.

## Não coberto
- **`e2e/*.a11y.e2e.ts` (Playwright + axe) não executado** — exige navegador; o `CLAUDE.md`
  proíbe rodá-lo no sandbox do agente. É justamente a camada que enxergaria o efeito visual da
  grade nova: transbordo horizontal, ordem de foco entre as duas linhas e contraste sob render
  efetivo. A grade rola abaixo de ~1520 px, e nenhum teste em jsdom observa isso (jsdom não faz
  layout). **Recomendo rodar `npm run test:e2e` na sua máquina antes de mesclar.**
- **Verificação visual do alinhamento das colunas não feita** — a promessa central da grade
  ("busca↔plano, empresa↔sub grupo, tipo doc↔grupo, tipo pagamento↔centro de custo,
  buscar↔limpar") é geométrica e foi conferida só por leitura do template e da ordem de
  auto-placement do CSS Grid, não por captura de tela.
- **Comportamento real do `payment_date` no banco não consultado** — as ressalvas sobre NULL e
  sobre o backfill da migration 096 vieram do `CLAUDE.md`, não de uma contagem no Supabase.
- **Dimensão de dados/SQL não aplicada** — o delta não toca migration, ETL nem transação; a
  única superfície de banco é a montagem de `URLSearchParams`, coberta pelos testes do serviço.
- **Superfície adjacente verificada e limpa**: `applyFinancialFilters` tem 3 consumidores
  (grid, "Valor total", contagem) e os três recebem `applied` por spread, então `rangeDateField`
  chega aos três — não há segundo caminho de leitura fora de sincronia.

---

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| R1 | Caminho de volta restaura o mês corrente mesmo com escopo global vindo de card/"Buscar" | ✅ corrigido | `Consulta.tsx:353` (novo estado `periodClearedByRange`), `:760-768` (condição por causalidade, não por estado do período), `:729-732` (`resetFilterGate` baixa a marca nos 4 caminhos síncronos). Teste novo: `com um card de KPI ativo, apagar as datas NÃO restaura o mês corrente` — validado por mutante (condição ingênua restaurada → **vermelho**) |
| R2 | `cancelPendingApply` sem guarda de teste nos 4 call sites | ✅ corrigido | Teste novo `"Limpar" dentro da janela descarta o filtro pendente (não volta sozinho)` — validado por mutante (removido `setPendingApply(null)` do gate → **vermelho**). Formato deliberadamente independente de tempo: `fireEvent` nos dois passos (gap de 0 ms) e a passagem da janela provada por um apply posterior, não por sleep fixo |
| R3 | Comentário de `queueApply` dizia "ref" onde a implementação usa estado | ✅ corrigido | `Consulta.tsx:736-737` |

Gates após a correção: vitest frontend-vite **800/800** (142 arquivos) · lint 0/0 · typecheck OK · ts-prune 0
Baseline (Passo 3):      vitest frontend-vite **798/798** (142 arquivos) · lint 0/0 · typecheck OK · ts-prune 0

Re-review do diff da correção: **sem achado novo**. O fix trata a causa (a condição passou a
observar *quem* zerou o período, não *se* ele está vazio), não introduz caminho de erro engolido,
não muda contrato externo (`resetFilterGate` é interno ao componente) e não duplica regra em outra
camada. Uma observação surgiu do re-review e **não foi corrigida**, por ser mudança de
comportamento além do defeito relatado: o restauro devolve sempre o **mês corrente**, não o mês
que estava selecionado — quem estava navegando em Março, define um intervalo e o apaga, volta para
Agosto. É pré-existente ao fix e igual nas duas versões; trocar a marca booleana por
`{month, year}` anteriores resolveria, mas alteraria o que o `CLAUDE.md` documenta hoje
("RESTAURA o mês/ano corrente") — decisão sua.

Não corrigido por decisão sua: os 4 achados 🔵 opcionais (guarda de coalescência dependente de
tempo real, refetch inútil do `rangeDateField` sem datas, ressalva de dado só no `title`, rótulo
"Buscar" com semântica nova) e a atualização do `CLAUDE.md` — docs de estado não são sincronizados
durante o review, por guard-rail.

Nada foi commitado.

---

## Rodada 2 — recomendações em aberto (a pedido do usuário)

| # | Item | Desfecho | Observação |
|---|---|---|---|
| Obs | Caminho de volta pulava para o mês CORRENTE em vez do mês selecionado | ✅ corrigido | `periodBeforeRange` (objeto) substitui o booleano `periodClearedByRange`: uma só peça carrega "foi o intervalo que zerou?" (não-nulo) e "o que restaurar" (o valor). Some o `nowRef` desse caminho. Teste novo com mês escolhido por deslocamento (`(mês+6)%12`) — nunca igual ao corrente, senão passaria por coincidência em Março. Mutante (restaura `nowRef` + condição ingênua) → **os dois testes vermelhos** |
| O3 | Ressalva de dado do `payment_date` só no `title` | ✅ corrigido | `aria-describedby` + `<span class="sr-only">` no wrapper do seletor; `title` mantido para o mouse. ⚠️ **A 1ª versão do guarda era decoração**: `toHaveAccessibleDescription` fica **verde sem `aria-describedby`**, porque o `title` vira a descrição computada. Reescrito para ler o atributo, resolver o id e conferir o texto do elemento apontado — mutante confirma |
| O4 | "Buscar" mudou de semântica sem mudar o rótulo | ✅ corrigido | `aria-label="Buscar em todos os períodos"` (contém o rótulo visível → WCAG 2.5.3). ⚠️ **A 1ª versão do guarda também era decoração**: com o fallback `aria-label ?? textContent`, remover o aria-label fazia o teste comparar o rótulo consigo mesmo. Acrescentada a asserção `/todos os períodos/i` — mutante confirma. **O texto VISÍVEL não foi alterado** (copy de produto, decisão sua) |
| O1 | Guarda de coalescência dependente de tempo real | ✅ corrigido | `fireEvent` no lugar de `user.selectOptions` nos 3 selects: gap de 0 ms, o teste mede coalescência e não velocidade |
| O2 | 3 requisições ao trocar `rangeDateField` com De/Até vazios | ❌ retirado | Toda implementação avaliada exige deixar `applied.rangeDateField` **atrasado** em relação a `f.rangeDateField` (catch-up só quando o intervalo é preenchido). É inobservável hoje, mas cria um invariante de estado defasado que morde o primeiro consumidor futuro de `applied.rangeDateField`. Também quebraria 2 guardas da feature. Três requisições num controle pouco tocado não pagam o risco — **a resposta robusta é não otimizar**. Registrado no `CLAUDE.md` |
| — | Comentário citando `periodClearedByRange` após o rename | ✅ corrigido | `Consulta.test.tsx:552` — mesma classe de R3 (comentário contradizendo a implementação), pega na varredura final |
| — | `CLAUDE.md` divergente do código após a mudança do caminho de volta | ✅ atualizado | Sob instrução do usuário nesta rodada (na rodada 1 estava adiado por guard-rail). 3 blocos: caminho de volta por valor, ressalva em `aria-describedby` (com a armadilha do `toHaveAccessibleDescription`), Label in Name, `fireEvent` no guarda de coalescência e o O2 recusado com o motivo. `tests/test_doc_links.py` 4/4 |

Gates: vitest frontend-vite **803/803** (142 arquivos) · lint 0/0 · typecheck OK · ts-prune 0 · `test_doc_links.py` 4/4
Baseline da rodada 1: 800/800 · rodada 0 (pré-review): 798/798

Re-review do diff desta rodada: **um achado, corrigido dentro da própria rodada** — os dois
guardas de a11y nasceram sem dente (verdes com a ligação removida), o que só apareceu porque cada
correção foi validada por mutante. É o próprio item que este relatório levantou como R2, agora do
lado do revisor: guarda de a11y é especialmente traiçoeiro porque `title` e `textContent`
funcionam como fallback silencioso na computação do nome/descrição acessível.

Não corrigido por decisão sua: o texto VISÍVEL do botão "Buscar" (copy de produto) e a execução
da camada e2e (`npm run test:e2e`), que exige navegador.

Nada foi commitado.
