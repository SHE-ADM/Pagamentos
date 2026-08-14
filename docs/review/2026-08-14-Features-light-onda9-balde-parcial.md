# Code Review — Features / Onda 9 · balde parcial (2026-08-14)

## Resumo

Alvo: `onda 9` (docs/roadmap-enriquecimento-dados.md § ONDA 9 + CLAUDE.md § "O que a Onda 9
entregou"). O delta em revisão **não é a Onda 9 original** (commit `f58f47a`, já mesclado) e sim a
extensão dela: as migrations **124** (balde parcial em `gasto_por_periodo`) e **125** (mês parcial
em `pontualidade_pagamento`), mais a camada TS e as guardas.

Modo: light (sem passo de ataque, sem verificação adversarial)
Delta: 5 arquivos alterados (+272/−10), 3 novos (~1.212 linhas) — working tree não commitado
Régua: CLAUDE.md (raiz), CLAUDE.md do workspace, docs/roadmap-enriquecimento-dados.md,
docs/review/2026-08-13-Features-light-onda9.md
Gates: **pytest 1408 ✅** (baseline HEAD 1382, +26) · **Node 1470 ✅** (frontend-vite 855 ·
api-backend 581 · shared 32 · portal-next 2) · **typecheck OK** (4 workspaces) · **lint 0/0**
(4 workspaces) · **ts-prune 0** · e2e Playwright não executado (exige navegador; crasha no
sandbox) · SonarCloud não executado (não há PR — working tree)

Veredito geral: **trabalho sólido, sem bloqueante.** As duas migrations estão aplicadas no banco e
verifiquei o que elas prometem contra o sistema real, não só contra o texto: os agregados foram
preservados (oráculo diferencial próprio, 12 combinações de `date_field` × `granularity`, **0
divergências**), os grants estão corretos (`authenticated=X`, `anon` sem EXECUTE), o domínio
fechado devolve vazio, o fuso `America/Sao_Paulo` é necessário de fato (a sessão roda em **UTC**,
medido) e a aritmética generaliza para mês (30/31) e trimestre (91/92). Os cinco números novos do
CLAUDE.md foram medidos um a um e **todos batem**. Os dois achados são de robustez e de cobertura
de sonda; ambos vivem em migration já aplicada, portanto vão para a migration 126.

## Achados

### 🔴 Bloqueantes

Nenhum.

### 🟡 Recomendados

- [supabase/migrations/124_gasto_por_periodo_balde_parcial.sql:159] `days_covered` fica **negativo**
  quando o balde está inteiramente no futuro — a coluna que existe para dar a ressalva passa a
  emitir um absurdo.
  Falha:     uma conta com `issue_date` (ou `payment_date`) no futuro cria um balde à frente de
             hoje. Aí `LEAST(bucket_end, p_date_to, hoje) − GREATEST(bucket, p_date_from) + 1`
             inverte-se: reproduzido no banco, o balde `2026-08-24` devolve **`days_covered = −9`**
             com `days_total = 7` e `is_partial = true`. O modelo é instruído a "dizer quantos dias
             o balde cobre" e diria "cobre −9 dos 7 dias". Vale igual para `dias_cobertos` na 125
             (mesma forma, linha 245-251).
  Evidência: consulta executada em 14/08/2026 sobre a base real — baldes 2026-08-17 / 08-24 / 09-07
             devolveram `−2`, `−9` e `−23`. As sondas P2 da migration validam a fórmula
             *recalculando a mesma fórmula*, então não acusariam.
  Atenuante: **o gatilho nunca ocorreu.** Hoje há 0 contas com `issue_date` ou `payment_date`
             futura, e a base inteira está em 2026 (nenhuma data fora de faixa em 784+ contas) —
             ou seja, o pipeline nunca produziu erro de ano. `account_count` e `total_amount`
             permanecem corretos em qualquer cenário; o dano é a ressalva virar ruído.
  Correção:  clampar em zero — `GREATEST(<expressão>, 0)` nas duas funções, na migration 126.
  Regra:     CLAUDE.md § "Chat de IA" — a família `fora_da_cobertura`/`total_encontrado`/`is_partial`
             existe para que a ressalva chegue íntegra ao modelo.

- [supabase/migrations/124_gasto_por_periodo_balde_parcial.sql:220] O oráculo diferencial e as
  sondas exercitam um subconjunto estreito dos parâmetros, repetindo a lição que o próprio projeto
  registrou no achado B1 da 123.
  Falha:     a 124 **reescreveu a função inteira** (CTE `dominio` nova, aliases novos, `FROM` novo),
             mas P1/P2/P2b/P2c só rodam `emissao` × `semana`, sem `p_status` e sem `p_sk_company`;
             `days_total` só é conferido contra o literal `7`. A 125 nunca exercita
             `p_date_from`/`p_date_to` no eixo `mes` fora do ramo do aviso. Um defeito introduzido
             em `mes`, `trimestre`, `dia` ou nos dois filtros passaria pelas sondas **e** pela suíte
             Python, que lê texto e não executa SQL.
  Evidência: CLAUDE.md § Onda 9 registra literalmente — *"Nenhuma das 8 sondas da 121 pegou (…)
             sonda que só roda o caminho padrão não prova o caminho parametrizado"*. Rodei a
             verificação que faltava (12 combinações + `p_date_from`/`p_date_to` no eixo `mes`) e o
             comportamento está **correto hoje**: 0 divergências, `days_total` 30/31/91/92 certos,
             filtro de usuário produzindo 6 de 31 dias. O defeito é de cobertura, não de código.
  Correção:  na migration 126, varrer as granularidades e os campos num laço (ou um `FULL JOIN`
             sobre `VALUES`) em vez de uma combinação fixa, e incluir um caso com `p_date_from`/
             `p_date_to` no eixo `mes`.
  Regra:     CLAUDE.md § Regra mandatória 2 — "teste que promete uma garantia tem de entregá-la".

### 🔵 Opcionais

- [supabase/migrations/125_pontualidade_mes_parcial.sql:308] A descrição da tool afirma um fato
  datado do dado ("hoje o mês do corte tem 3 dos 31 dias"); se `payment_date_confiavel_desde()`
  mudar, a frase envelhece — a coluna calculada continua certa, então o risco é só de texto.
- [apps/api-backend/lib/ai-chat/tools.ts:250] `bucket_end` é a única das quatro colunas novas que
  não é citada na descrição nem no prompt. É auto-explicativa, mas a assimetria é involuntária.
- [tests/test_gasto_por_periodo_parcial.py:87] `MIG_TOOL.name[:3] >= "124"` compara string; funciona
  na numeração de 3 dígitos e quebraria em 4.

## Pendências (trabalho incompleto)

- [apps/api-backend/lib/ai-chat/tools.ts] Deploy da Next API pendente — as migrations já estão
  aplicadas, mas o texto novo das tools e do SYSTEM_PROMPT só chega ao modelo depois do deploy
  (item 5 da seção VERIFICAÇÃO das duas migrations). — **recomendada**
- [apps/api-backend/lib/ai-chat/gateway.ts] Conferir `cache_read_input_tokens` em
  `analytics.ai_chat_log` após o deploy: mudaram **duas descrições de tool e o SYSTEM_PROMPT**, o
  que invalida os três níveis de prompt cache. O CLAUDE.md exige essa conferência após mudança que
  toque o prefixo cacheável. — **recomendada**
- Working tree não commitado (8 arquivos). Nada foi commitado por este review. — **informativa**

## Drift código × documentação

Nenhum. Conferi cada número novo do CLAUDE.md contra medição própria:

| Afirmação do CLAUDE.md | Medido |
|---|---|
| suíte Python **1.408** | 1408 ✅ (baseline HEAD 1382, worktree isolado) |
| `npm test` **1.470** | 1470 ✅ (855 · 581 · 32 · 2) |
| `test_gasto_por_periodo_parcial.py` = **18** | 18 ✅ |
| `test_onda9_pontualidade.py` de **27 para 35** | 27 no HEAD → 35 ✅ |
| `test_roadmap_gatilhos.py` = **39** | 39 ✅ |
| migrations **103–125**, próxima **126** | ✅ 124 e 125 aplicadas no banco |

Verifiquei também a aparente contradição "os **25** da Onda 9" × "foi de 27 para 35": ela é
**consistente** — o commit `f58f47a` traz as migrations 121, 122 e 123 juntas, então 25 (Onda 9) +
2 (sondas da 123) = 27. Não é drift.

## Não coberto

- **e2e Playwright / axe**: não executado — exige navegador; o renderer crasha no sandbox do
  agente. O delta não toca UI, então o risco de não rodar é baixo.
- **SonarCloud**: não executado — não há PR aberto para este delta (working tree).
- **Reexecução das migrations**: não testei aplicar 124/125 uma segunda vez no banco. Elas se
  declaram idempotentes (`DROP … IF EXISTS` + `CREATE`, `DO` só lê), e a leitura do código sustenta
  isso, mas a idempotência não foi provada por execução.
- **Comportamento sob RLS restrita**: as sondas P7 rodam sob `authenticated` com o primeiro usuário
  de `auth.users`; não exercitei um usuário do grupo Comercial (`sees_only_own_accounts`). A
  função é `SECURITY INVOKER` e o recorte já foi provado na Onda 8, então herdei aquela prova em
  vez de refazê-la.
- **CLAUDE.md** foi revisado pelo diff (as ~75 linhas alteradas), não relido por inteiro.
