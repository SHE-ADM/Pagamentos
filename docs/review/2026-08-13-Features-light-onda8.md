# Code Review — Features / Onda 8 (2026-08-13)

## Resumo

Alvo: onda 8 (`docs/roadmap-enriquecimento-dados.md` § ONDA 8 — Hardening do chat)
Modo: light (sem passo de ataque, sem verificação adversarial)
Delta: `a9f42ab..HEAD` (11 commits sem merge) — 40 arquivos, 3 novos de código/teste, +3.000/−160 linhas. Working tree limpo; `Features` == `main` == `d917dc6`.
Régua: `CLAUDE.md` (raiz) · `docs/roadmap-enriquecimento-dados.md` § Onda 8 · `docs/knowledge/api-crud.md` · `.claude/rules/*` do workspace
Gates: **pytest 1.314 passed** · **vitest 1.463** (frontend-vite 854 · api-backend 575 · shared 32 · portal-next 2) · **lint 0/0** (4 workspaces) · **typecheck OK** (4 workspaces) · **prune 0** · **paridade de deploy 28/28** · e2e Playwright **não executado** (exige navegador — crasha no sandbox do agente) · sondas SQL da migration 120 **não reexecutadas** (migration já aplicada; reexecutar é escrita em base compartilhada dev+prod)

O delta entrega o item 8.3 (gate de acesso ao chat por grupo, migration 120), o 8.2 (few-shot + lacunas de capacidade no prompt), a correção de dois mapeamentos errados da bateria de regressão, o achado colateral do `clientSafe`, a guarda da versão única de React e o fechamento documental da Onda 5. A qualidade é alta e incomum: a autorização é fail-closed no servidor e fail-open na UI de propósito, a separação `gate.ts` × `rate-limit.ts` está justificada no código, a ordem dos porteiros é estrutural (não convencional) e as guardas cross-layer (`test_onda8_gate_ia.py`) cobrem exatamente os mutantes que o vitest não pega. Dois achados recomendados, ambos de robustez em caminho de exceção — nenhum bloqueante, nenhuma pendência de escopo.

## Achados

### 🔴 Bloqueantes

Nenhum.

### 🟡 Recomendados

- [apps/api-backend/lib/response.ts:50] O eco de 5xx marcado `clientSafe` retorna **antes** do `console.error`, então o 5xx ecoado deixa de ser logado no servidor.
  Falha:     Instabilidade da Anthropic → `translateAnthropicError` produz `AiChatError(…, 503)` → `failFromError` ecoa a mensagem curada e **retorna**, sem passar pelo `console.error`. Nenhuma linha aparece no log da function na Vercel; o único registro sobrevive por acidente, porque *este* consumidor grava `analytics.ai_chat_log` por conta própria no `catch` da rota. Uma segunda classe marcada `clientSafe` com 5xx (o próximo uso da marca, que é opt-in justamente para ser reusada) perde o registro por completo — falha de servidor sem nenhum rastro.
  Evidência: `response.ts` — `if (e.status < 500 || e.clientSafe) return fail(e.message, e.status);` precede `console.error`. E `lib/ai-chat/errors.ts:107-109` ainda afirma que os não-traduzidos "viram 500 genérico + console.error via failFromError", contrato que agora vale só para os não-marcados. Nenhum teste observa o log neste ramo (`response.test.ts` não foi tocado pelo delta).
  Correção:  emitir `console.error` também quando `clientSafe && status >= 500`, mantendo o eco da mensagem e o status.
  Regra:     `CLAUDE.md` § Padrão de execução — "tratamento de exceção com log e rastreabilidade — nunca silenciar erro".

- [apps/frontend-vite/src/contexts/AuthContext.tsx:203] O gate de UI lê o embed to-one sem normalizar a forma, enquanto o gate do servidor normaliza — a mesma leitura, com robustez diferente nos dois lados.
  Falha:     Se o PostgREST/supabase-js devolver `user_group` como **array** (a faixa declarada é `^2.45.0`, e a própria régua do projeto registra que a forma é propriedade da versão instalada, não do contrato), `grupo?.ai_chat_enabled` vira `undefined` → `aiChatEnabled` vira `false` para **todos** os usuários → o botão do assistente desaparece da tela inteira, sem erro, com a API funcionando normalmente. O `gate.ts` sobreviveria à mesma mudança (tem o normalizador `primeiro()` e um caso de teste para cada forma), então o sintoma seria "o chat sumiu" com o backend intacto — e a suíte ficaria verde, porque `AuthContext.test.tsx` só exercita a forma objeto.
  Evidência: `gate.ts:57-74` declara `LinhaGrupo | LinhaGrupo[] | null` + `primeiro()` e `gate.test.ts:154-167` cobre as duas formas ("aceita o embed como objeto" / "como array"); `AuthContext.tsx` faz `const grupo = data?.user_group as { ai_chat_enabled?: unknown } | null | undefined;` — cast direto, sem ramo de array. Medido: `@supabase/supabase-js@2.108.2`, cópia única hoisted, servindo os dois apps.
  Correção:  aceitar as duas formas na leitura do `AuthContext` (mesmo normalizador de uma linha) e acrescentar o caso de embed em array ao `AuthContext.test.tsx`.
  Regra:     precedente do próprio projeto — `lib/auth.concurrency.test.ts` e o comentário de `gate.ts` ("a forma é propriedade da versão instalada, não do contrato").

### 🔵 Opcionais

- [apps/frontend-vite/src/components/Layout.test.tsx:87] O `it.each` restaura `auth.aiChatEnabled = true` no fim do corpo do teste; se a asserção falhar, o valor vaza para os casos seguintes (usar `afterEach`).
- [supabase/migrations/120_ai_chat_gate_por_grupo.sql:267] A sonda P4(b) usa `WHERE group_id = 0` sem afirmar que a linha existe: sumindo o sentinela, `v_linhas = 0` seria lido como "escrita negada" e a sonda passaria medindo o vazio — o oposto da anti-vacuidade que o arquivo pratica em P0/P1. (P3 tem o mesmo acoplamento, mas falha para o lado seguro: abortaria.) Artefato já aplicado — não editar.
- [tests/test_react_versao_unica.py:59] `_major()` devolve o primeiro número da faixa: `">=18 <20"` seria lido como major 18. Suficiente para as faixas em uso (`^19.x`), frágil para faixas compostas.

## Pendências (trabalho incompleto)

Nenhuma. Os três itens da Onda 8 estão fechados (8.1 promovido para a Onda 1 e entregue; 8.2 e 8.3 implementados), a dívida de prova do recorte de RLS foi paga, nenhum marcador `TODO/FIXME/HACK/WIP` entrou no delta, nenhum teste `skip`/`todo`, nenhum stub, e o `deploy-manifest.json` está em paridade (28/28) — a onda não tocou `skills/`, então não há deploy pendente por conta dela.

## Drift código × documentação

- `docs/roadmap-enriquecimento-dados.md` § ONDA 8 › Verificação declara **"Gates: Node 1.461 · Python 1.307 (+24 guardas da onda)"**; medido agora: **Node 1.463 · Python 1.314**. Os números foram escritos no commit do item 8.3 (`f6df972`) e os três commits seguintes da mesma onda acrescentaram guardas (`test_react_versao_unica.py`, as 3 de `G9ContratoDoErroTest`). O `CLAUDE.md` já registra os números corretos, então a divergência é entre os dois docs — decisão pendente do usuário sobre qual atualizar (não sincronizado por esta skill, por regra).

## Não coberto

- **Arquivos do delta lidos apenas em parte:** `tests/test_backfill_cte_content.py` (224 linhas novas, Onda 5 — coberto pelos gates, não pela leitura linha a linha), e os docs de longo diff `docs/arquitetura-chat-ia-pagamentos.md` (+111), `docs/roadmap-enriquecimento-dados.md` (+136), `docs/deploy/historico-deploys.md` (+66) e `.claude/napkin.md` (+26), lidos por amostragem dirigida (seções da Onda 8 e do `clientSafe`).
- **Gate não executado:** a camada e2e de acessibilidade (Playwright + axe) — o spec `protected.a11y.e2e.ts` foi alterado pelo delta e a alteração **não foi exercitada**; o renderer do Chromium crasha no sandbox do agente. A pré-condição que ela agora afirma (usuário do CI no grupo 7, liberado) só será exercida no próximo PR, porque o workflow `a11y.yml` não tem `workflow_dispatch`.
- **Não reexecutado:** o `DO $$` de auto-verificação da migration 120 (6 sondas). A migration já está aplicada e a base é compartilhada dev+prod; a evidência aqui é a leitura do SQL e o relato de aplicação registrado no roadmap, não uma execução minha.
- **Dimensão não aplicada:** desempenho/carga do gate (uma consulta por PK a mais por requisição de chat) — irrelevante na escala medida do projeto (13 usuários), não medido.
- **Superfície adjacente verificada, sem achado:** `AiChatWidget` tem um único ponto de montagem (`Layout.tsx`); `/api/ai-chat` tem um único cliente (`services/aiChat.ts`); `failFromError` é compartilhado pelos 8 CRUDs, e a marca `clientSafe` é opt-in com default `false` (os CRUDs seguem intocados — `response.test.ts` verde).

---

## Correções aplicadas

Bloco acrescentado após o relatório (o relatório acima descreve o estado ENCONTRADO e não é reescrito).

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| R1 | 5xx `clientSafe` ecoado saía sem log de servidor | ✅ corrigido | `apps/api-backend/lib/response.ts:55-63` — `console.error` no ramo do eco quando `status >= 500`; 4xx segue sem log. Cobertura nova em `lib/response.test.ts` (2 casos: o log no 5xx marcado e a ausência dele no 4xx curado). **Validado por mutante isolado**: removida a linha do log → 1 vermelho; revertido e confirmado por `diff -q`. |
| R2 | Gate de UI lia o embed to-one sem normalizar (servidor normaliza) | ✅ corrigido | `apps/frontend-vite/src/contexts/AuthContext.tsx:202-208` — aceita objeto ou array, espelhando `primeiro()` de `lib/ai-chat/gate.ts`. Caso novo em `AuthContext.test.tsx` com o embed em array. **Validado por mutante isolado**: cast direto de volta → 1 vermelho; revertido e confirmado por `diff -q`. |

Gates após a correção: **vitest 1.466 (+3)** (api-backend 577 · frontend-vite 855 · shared 32 · portal-next 2) · **pytest 1.314** (inalterado) · **lint 0/0** · **typecheck OK** · **prune 0**
Baseline (Passo 3):     vitest 1.463 · pytest 1.314 · lint 0/0 · typecheck OK · prune 0
Re-review do diff da correção: **sem achado novo** — 4 arquivos, +67/−2. O fix não engole erro (restaura um), não muda status nem corpo de resposta, não altera assinatura pública e nenhum teste existente assertava a ausência do log nesse ramo. A duplicação do normalizador entre `AuthContext` e `gate.ts` é deliberada: são apps sem dependência entre si (mesma razão da duplicação das sugestões do painel na bateria de regressão).

Não corrigido por decisão sua: o drift dos números de gate no `docs/roadmap-enriquecimento-dados.md` (docs de estado não são sincronizados pelo review — qual lado atualizar é decisão do usuário) e os três achados 🔵 opcionais, sendo que o da sonda P4 toca migration já aplicada (artefato imutável).
Nada foi commitado.

---

## Itens decididos pelo usuário (resolvidos em 2026-08-13, após o review)

Os dois pontos que o relatório havia deixado em aberto foram fechados a pedido do usuário, com a
instrução explícita de "usar robustez de código" — isto é, atacar a causa, não o sintoma.

### 1. Drift dos números de gate no roadmap — resolvido eliminando a 2ª fonte de verdade

**O que se mediu primeiro** (escrever número sem medir foi o que produziu o drift): suíte Python
rodada num `git worktree` isolado, contra `fbb2dc0` — o commit imediatamente anterior à onda —, e
contra `a9f42ab`. Resultado: **1.283 → 1.314 = +31**, e os dois arquivos novos
(`test_onda8_gate_ia.py` 28 + `test_react_versao_unica.py` 3) somam **exatamente 31**, ou seja
nenhum caso foi acrescentado a arquivo existente. O worktree foi removido (`git worktree list`
confirma só o principal).

**Achado adicional da medição:** o `+24` do roadmap também estava errado — não era só o total. Os
**três** números da linha estavam incorretos.

**Correção estrutural, não cosmética.** Corrigir "1.461 → 1.463" apenas reiniciaria o relógio: um
total de suíte muda a cada PR, então repeti-lo num registro datado é drift por construção. O que
ficou no roadmap é o **incremento** (+31, propriedade da onda, não envelhece), com a data e o
commit da medição; o **total vivo** passou a existir num lugar só — `CLAUDE.md` § Regras
mandatórias 2 —, e o roadmap aponta para lá. A nota explica o modo de falha para quem for escrever
o fechamento da próxima onda.

### 2. `workflow_dispatch` ausente no `a11y.yml` — resolvido com guarda contra o "pulou = passou"

`.github/workflows/a11y.yml` ganhou `workflow_dispatch`, para verificar uma troca de credencial do
CI sem esperar o próximo PR (a dependência já mordeu duas vezes: remoção do usuário sentinela e o
gate por grupo da 120, ambas descobertas depois).

🔴 **O `workflow_dispatch` sozinho seria uma armadilha, e é aí que está a robustez.** Sem os
secrets, o `test.skip` de `protected.a11y.e2e.ts` pula o bloco inteiro — e "pulado" num log de CI
se lê como "passou". Num disparo manual cujo único propósito é confirmar que a credencial ainda
loga, esse silêncio **inverteria a conclusão**: o verde provaria exatamente nada. Por isso o
dispatch leva o input `require_protected` (default `true`) e um step que **falha cedo** se algum
dos 4 secrets estiver ausente, nomeando quais. Detalhes que não são estilo:

- roda **na posição 1**, logo após o checkout e antes de `npm ci` + Chromium: falha em segundos com
  a causa no topo do log, em vez de após ~3 min de provisionamento;
- os secrets vão por `env` e a comparação é por **conteúdo vazio**, nunca pelo valor — que não pode
  aparecer no log;
- `VITE_SUPABASE_URL`/`ANON_KEY` entram na checagem porque o workflow cai em **placeholder** quando
  faltam: o login não completaria e a falha apareceria como erro de rede no meio do axe, longe da
  causa real;
- o `if` é restrito a `github.event_name == 'workflow_dispatch'` — **nenhum** gatilho automático
  muda de comportamento, então PR de quem não tem os secrets continua sem quebrar.

**Verificado, não presumido:** o YAML foi parseado (gatilhos, input e ordem dos steps conferidos
programaticamente) e o script do guard foi **extraído e executado** nos três caminhos — nenhum
secret (falha, nomeia os 4), um faltando (falha, nomeia só ele) e todos presentes (passa). Código
defensivo que nunca roda é a categoria que mais esconde defeito.

O `CLAUDE.md` foi atualizado no mesmo movimento — a afirmação "o workflow não tem
`workflow_dispatch`" descrevia um comportamento que o código não tem mais, que é o modo de falha
que a guarda `G9ContratoDoErroTest` existe para punir em outro contrato.

Gates após esta rodada: **vitest 1.466** · **pytest 1.314** · **lint 0/0** · **typecheck OK**.
Diff acumulado no working tree: 7 arquivos, +130/−6. Nada foi commitado.
