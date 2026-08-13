# Code Review — Features / Onda 9 (2026-08-13)

## Resumo

```
Alvo:  onda 9 (docs/roadmap-enriquecimento-dados.md § ONDA 9 — Condicional)
Modo:  light (sem passo de ataque, sem verificação adversarial)
Delta: 11 arquivos alterados, 7 novos (+448/−55 nos versionados; ~1.800 linhas nos novos)
Régua: CLAUDE.md do projeto · CLAUDE.md do workspace · docs/roadmap-enriquecimento-dados.md
Gates: pytest 1367 · vitest 1468 (frontend-vite 855 --maxWorkers=1 · api-backend 579 ·
       packages/shared 32 · portal-next 2) · lint 0/0 · typecheck OK · ts-prune 0 ·
       vulture 0 · check_deploy_parity 31/31 ·
       e2e Playwright NÃO executado (exige navegador) · build NÃO executado ·
       SonarCloud NÃO consultado (sem PR aberto para este delta)
Baseline: working tree suja desde o merge 34e60ad; todos os gates verdes — nenhuma falha
       preexistente atribuível ao delta.
```

O delta é a Onda 9 do roadmap: a 12ª tool `pontualidade_pagamento` (migration **121**), a série
histórica dos 7 gatilhos condicionais (migration **122**) e a 5ª tarefa agendada
(`skills/roadmap-gatilhos` + os dois `.ps1`).

A onda entrega bem o que promete: a tool é `SECURITY INVOKER`, declara a própria cobertura no
retorno, tem oráculo diferencial dentro da migration, e o medidor mensal foi validado **ponta a
ponta em produção** (7 linhas gravadas em 2026-08-13, com a data de corte lida da fonte única via
RPC pelo PostgREST). Um defeito **bloqueante** escapou de todas as 8 sondas da 121 porque todas
elas exercitam `min_contas` no valor default.

---

## Achados

### 🔴 Bloqueantes

- **[supabase/migrations/121_pontualidade_pagamento.sql:239]** A linha de aviso é emitida quando
  **`min_contas`** esvazia o agrupamento — e não só quando falta cobertura —, afirmando que não há
  dado confiável no período quando há.

  **Falha:** `pontualidade_pagamento(p_date_from => hoje-7, p_group_by => 'fornecedor',
  p_min_contas => 10)` → existem **118 contas pagas com carimbo real** no período, e a função
  devolve **uma** linha `(nenhuma conta com data de pagamento confiavel no periodo)` com
  `contas = 0`. O modelo conclui *"não houve pagamento mensurável no período"* — falso, e é
  exatamente a inversão que a CTE do aviso foi escrita para impedir. A descrição da própria tool
  **instrui** o modelo a usar `min_contas` em `group_by="fornecedor"`, então o caminho não é
  exótico: é o recomendado.

  **Evidência** (medido contra o banco, somente leitura, 2026-08-13):

  | cenário | contas confiáveis reais no período | 1ª linha devolvida |
  |---|---|---|
  | 7 dias · `min_contas=10` | **118** | `(nenhuma conta com data de pagamento confiavel no periodo)` |
  | 2 dias · `min_contas=5` | 54 | idem |
  | 30 dias · `min_contas=25` | 221 | idem |
  | sem filtro de data · `min_contas=999` | 221 (50 grupos sem o piso) | idem |

  **Causa:** o ramo do `UNION ALL` testa `NOT EXISTS (SELECT 1 FROM agrupado)`, e `agrupado` já
  passou pelo `HAVING count(*) >= GREATEST(COALESCE(p_min_contas, 1), 1)`. "Vazio" ali significa
  duas coisas diferentes — *não há população confiável* **ou** *nenhum grupo atingiu o piso* — e o
  aviso é escrito para apenas uma delas.

  **Correção:** testar `confiaveis` (a população **antes** do agrupamento) em vez de `agrupado`.
  `confiaveis` vazio ⇒ `agrupado` vazio, então o caso de cobertura que a sonda P5b prova continua
  valendo; com população presente e piso não atingido, o retorno passa a ser vazio — que ali é a
  resposta honesta ("nenhum grupo qualificou"), não uma afirmação falsa.

  **Regra:** CLAUDE.md § "O que a Onda 9 entregou" — *"Período 100% fora da cobertura devolve UMA
  LINHA DE AVISO, nunca vazio"* e *"'Não existe' e 'existe mas não dá para medir' são respostas
  diferentes, e preservar essa diferença é a razão de ser desta tool"*.

### 🟡 Recomendados

- **[supabase/migrations/122_roadmap_trigger_snapshot.sql:280]** A sonda P4b não distingue *"a
  trigger de touch disparou"* de *"a trigger não existe"*.

  **Falha:** `v_marco` é capturado **antes** do 1º INSERT. O `measured_at` do 1º INSERT já vem de
  `DEFAULT clock_timestamp()` e portanto já é `> v_marco`. Removendo
  `trg_roadmap_snapshot_touch`, `v_touch` continua `true` e a migration passa verde — a sonda não
  observa o que o comentário dela afirma observar.

  **Evidência:** `SELECT (measured_at > v_marco)` lê a linha após o 2º INSERT, mas o valor
  comparado sobreviveria intacto do 1º. O catálogo confirma que a trigger existe hoje
  (`trg_roadmap_snapshot_touch`, BEFORE UPDATE) — logo é defeito de **verificação**, não de
  comportamento.

  **Correção:** guardar o `measured_at` gravado pelo 1º INSERT e exigir que o do 2º seja
  estritamente maior que ele.

  **Regra:** CLAUDE.md Regra 2 — *"teste que promete uma garantia tem de entregá-la"*.

- **[apps/api-backend/lib/ai-chat/tools.ts:2]** O cabeçalho diz "As **11** tools" e enumera até a
  migration 118; o arquivo agora expõe **12** (a lista travada em `tools.test.ts` foi atualizada, o
  comentário não).

  **Falha:** quem for acrescentar a 13ª tool lê "11", confere a lista e encontra 12 — e a primeira
  hipótese é que alguém acrescentou tool sem deliberação, que é justamente o que a trava do
  `tools.test.ts` existe para impedir (acrescentar tool invalida os 3 níveis de prompt cache).

  **Correção:** atualizar o cabeçalho para 12 e citar a 121.

- **[skills/roadmap-gatilhos/scripts/run.py:139]** Todo `HTTPError` é tratado como definitivo —
  inclusive **429 e 5xx**, que são transitórios.

  **Falha:** um 503 momentâneo do Supabase em qualquer das ~15 requisições derruba aquele gatilho,
  reprova a tarefa mensal e deixa a série **sem o ponto do mês** — a mesma perda que o
  `StartWhenAvailable` do setup existe para evitar, e sem nova chance por 30 dias. Numa rotina cujo
  produto é a SÉRIE, buraco silencioso é o pior desfecho.

  **Evidência:** `except urllib.error.HTTPError: return e.code, ...` retorna antes do laço de
  retry; o comentário justifica o corte apenas para 4xx (*"repetir um 400 é inútil"*), mas a
  cláusula pega todos os códigos.

  **Correção:** repetir em 429/5xx com o backoff que já existe; manter 4xx definitivo.

### 🔵 Opcionais

- [skills/roadmap-gatilhos/scripts/run.py:411] loga `"serie atualizada: 0 linha(s)"` quando os 7
  gatilhos falharam e nada foi gravado — o exit 1 salva o sinal, mas a frase engana quem lê o log.
- [scheduler/run_gatilhos.ps1:103] `_stdout.tmp`/`_stderr.tmp` com nome fixo colidem em execução
  concorrente (manual + agendada). É o padrão dos 4 runners existentes; anotado, não divergido.
- [scheduler/setup-gatilhos-task.ps1:27] pior caso de rede (15 requisições × 3 tentativas × 30 s)
  excede o `ExecutionTimeLimit` de `PT15M` — a tarefa seria morta pelo Agendador em vez de sair com
  exit 1. O sinal continua vermelho, então é observação, não defeito.

---

## Pendências (trabalho incompleto)

- **Deploy da Next API (Vercel) com a 12ª tool** — a migration 121 já está aplicada no banco
  compartilhado dev+prod, mas o `api-backend` em produção ainda expõe 11 tools. A ordem está
  **correta** (migration antes da API, como a própria 121 prescreve); falta o merge. — recomendada
- **Deploy do pipeline Python em `C:\Sheild\API\Pagamentos`** — 3 arquivos novos entraram no
  manifesto (28 → 31). O CLAUDE.md afirma que a tarefa foi instalada e validada lá em 2026-08-13;
  **confirmar rodando `py -3 scheduler\check_deploy_parity.py` NA máquina de produção** (daqui o
  caminho não existe). — recomendada
- **`pontualidade_pagamento` via PostgREST** (`Content-Profile: analytics`) não exercitada — só por
  SQL direto. É o passo 2 da própria seção de verificação da 121. — opcional

---

## Drift código × documentação

1. 🔴 **`CLAUDE.md:1746`** — *"Esta onda não tocou `skills/` ⇒ sem deploy em produção; o
   `deploy-manifest.json` não mudou"*. **Falso**: a onda criou
   `skills/roadmap-gatilhos/scripts/run.py`, acrescentou o glob em `check_deploy_parity.py` e o
   manifesto foi de 28 para **31** entradas. Contradiz dois outros trechos do MESMO arquivo (o
   bloco da 5ª tarefa agendada e o da skill). Risco concreto: induzir a pular um deploy de que a
   produção precisa. — decisão pendente do usuário
2. **`CLAUDE.md:1126`** — *"Migrations usadas até aqui: **103–119**"*; a Onda 9 ocupou **121/122**.
   — decisão pendente do usuário
3. **`supabase/migrations/121:13` × `CLAUDE.md`** — a migration diz **217** contas com carimbo
   real; o CLAUDE.md diz **218**, para a mesma medição do mesmo dia (o banco hoje diz **221** — o
   número deriva a cada leitura do reader). Divergência entre dois artefatos escritos juntos.
   — decisão pendente do usuário
4. **`CLAUDE.md:212-222`** — a narrativa dos totais não fecha: 1.314 + 25 (Onda 9) + 26 (gatilhos)
   = 1.365, mas o total declarado é **1.367**, que está **correto**. Faltam na enumeração os 2
   casos novos de `test_react_versao_unica.py` (`ExtracaoDoMajorTest`). — decisão pendente do usuário

---

## Não coberto

- `CLAUDE.md` (~5.100 linhas) e `docs/roadmap-enriquecimento-dados.md` lidos **apenas nos hunks do
  diff**, não integralmente.
- Camada a11y em navegador (Playwright + axe): **não executada** — o renderer do Chromium crasha no
  sandbox do agente (limitação já registrada no CLAUDE.md); validar no CI.
- `npm run build:vite|build:api|build:portal`: não executados.
- SonarCloud: não consultado — não há PR aberto para este delta, e o gate julga só código novo de PR.
- `scheduler/setup-gatilhos-task.ps1` **não executado** — exige Windows elevado e o Agendador.
  Avaliado por leitura, por comparação com os 4 setups existentes e pelo registro de instalação em
  produção descrito no CLAUDE.md.
- A prova do achado B1 foi feita **no banco compartilhado dev+prod**, somente leitura (4 chamadas
  `SELECT`). Nenhuma escrita.
- Migrations 121/122 **já aplicadas** ⇒ a correção é por migration nova, não por edição do artefato.
- **Modo light**: sem passo de ataque e sem verificação adversarial — nenhum achado leva a marca
  `[verificado]`. B1, porém, foi reproduzido no banco real em 4 cenários.

---

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| B1 | Aviso falso quando `min_contas` esvazia o agrupamento | ✅ corrigido | `supabase/migrations/123_pontualidade_aviso_min_contas.sql` (novo) — `CREATE OR REPLACE`, uma linha de código: `NOT EXISTS (… FROM agrupado)` → `… FROM confiaveis`. O diff dos dois corpos de função tem **exatamente 2 linhas de código** (a outra é o `OR REPLACE`). Guardas novas em `tests/test_onda9_pontualidade.py` (`test_o_aviso_olha_a_POPULACAO_e_nao_o_AGRUPAMENTO`, `test_a_sonda_do_piso_alto_existe_na_migration`), validadas por 2 mutantes. ⏳ **A migration NÃO foi aplicada** — passo seu. |
| R1 | Sonda P4b da 122 não distingue "trigger disparou" de "trigger não existe" | ✅ corrigido | A sonda corrigida vive na **123** (P5), não na 122 — migration aplicada é imutável. Compara o `measured_at` do 2º UPSERT **contra o do 1º**, em subtransação desfeita. |
| R2 | Cabeçalho de `tools.ts` diz "11 tools" | ✅ corrigido | `apps/api-backend/lib/ai-chat/tools.ts:2-5` — 12 tools, citando a 121/Onda 9. Só comentário. |
| R3 | 429/5xx tratados como definitivos no medidor | ✅ corrigido | `skills/roadmap-gatilhos/scripts/run.py` — novo `_http_transitorio()` + retry com o backoff existente. 5 casos novos em `tests/test_roadmap_gatilhos.py` (`G2bRetryHttpTest`), validados por mutante. `deploy-manifest.json` regravado (`--update`), paridade 31/31. 🔴 **Exige cópia para `C:\Sheild\API\Pagamentos`** — passo seu. |

**Gates após a correção:** pytest **1374** (+7) · vitest **1468** (frontend-vite 855 · api-backend 579 · shared 32 · portal-next 2 — inalterados) · lint 0/0 · typecheck OK · ts-prune 0 · vulture 0 · `check_deploy_parity` 31/31
**Baseline (Passo 3):** pytest 1367 · vitest 1468 · lint 0/0 · typecheck OK · ts-prune 0 · vulture 0 · parity 31/31

**Re-review do diff da correção: 1 defeito encontrado no próprio fix, corrigido na 1ª rodada.**
A sonda P1 derivava o maior grupo do **retorno da tool**, que tem `LIMIT` (teto 200) e ordena por
**valor**, não por contagem — com mais de 200 fornecedores o grupo mais numeroso poderia ficar fora
da janela, o piso sairia baixo demais e a sonda abortaria sem defeito algum (ou passaria vazia). É a
6ª aparição da armadilha da truncagem silenciosa neste projeto, e ela quase entrou dentro da própria
guarda que existe para pegá-la. Hoje o maior grupo sai de **query de controle** sobre
`vw_payables`, com anti-vacuidade explícita (`v_maior_grupo = 0` aborta). 2ª rodada: sem achado novo.

**Pré-voo da sonda P1, contra o banco (somente leitura, migration ainda não aplicada):** a query de
controle devolve `maior_grupo = 24` sobre **103 grupos reais**, e chamando a função **atual** com
`p_min_contas = 25` a linha de aviso APARECE — ou seja, a sonda reprovaria hoje, que é exatamente o
que ela precisa fazer para não ser decoração.

**Não corrigido por decisão sua / do rito:**
- Drift **3** (217 × 218 × 221 contas com carimbo real) e **4** (a enumeração dos totais de teste no
  CLAUDE.md não fecha, embora o total esteja certo) — números de medição que derivam; qual deles
  vale é decisão sua.
- Os 3 achados 🔵 opcionais — são preferência, e mexer neles infla o diff da correção.
- As 3 pendências de deploy/verificação — exigem ambiente que esta sessão não tem.

**Drift 1 e 2 corrigidos por autorização explícita sua**, como exceção ao guard-rail do rito
(`correcao.md` item 1): `CLAUDE.md:1746` (a onda TOCOU `skills/` e exigiu deploy — a frase anterior
induzia a pular um deploy que produção precisa) e `CLAUDE.md:1126` (`103–119` → `103–123`). Como
efeito da própria correção, também foi atualizado o contador `001 → 123 / próxima = 124` e
acrescentado o bloco descritivo da migration 123 — sem isso a correção criaria um drift novo.
Saldo do `CLAUDE.md` nesta fase: **+33 linhas** (5.125 → 5.158).

**Nada foi commitado.** Tudo está no working tree.

---

## Fechamento — migration aplicada, pendências resolvidas, código endurecido (2026-08-13)

### Migration 123 aplicada

`psql -f 123_pontualidade_aviso_min_contas.sql` → **exit 0**, com as sondas passando:

```
NOTICE: pontualidade: sob authenticated a tool respondeu 5 balde(s)
NOTICE: pontualidade 123 OK: 221 conta(s) confiavel(is); maior grupo 24, piso da sonda 25;
        aviso sai so por cobertura; touch da 122 provado (…239275+00 -> …247698+00)
```

Comportamento conferido no banco, nos **mesmos cenários** que reprovavam antes:

| cenário | contas confiáveis reais | antes | depois |
|---|---|---|---|
| 7 dias · `min_contas=10` | 118 | `(nenhuma conta …)` | **(vazio)** ✅ |
| 2 dias · `min_contas=5` | 54 | `(nenhuma conta …)` | **(vazio)** ✅ |
| 30 dias · `min_contas=25` | 221 | `(nenhuma conta …)` | **(vazio)** ✅ |
| 30 dias · `min_contas=3` | 221 | — | **OTIMOTEX** (não virou "sempre vazio") ✅ |
| período 100% fora da cobertura | 441 | `(nenhuma conta …)` | `(nenhuma conta …)` ✅ preservado |

### Pendências

| Pendência | Situação |
|---|---|
| Deploy do pipeline Python | ✅ feito por você (`run.py` + `deploy-manifest.json`) |
| `pontualidade_pagamento` via PostgREST | ✅ **resolvida** — `POST /rest/v1/rpc/pontualidade_pagamento` com `Content-Profile: analytics` e a anon key devolve **`42501`**, não `PGRST202`: o cache de schema enxerga a função **e** `anon` está barrado. Dois invariantes provados numa chamada. |
| Deploy da Next API (Vercel) com a 12ª tool | ⏸️ **em aberto** — exige merge, e nenhuma operação de escrita em git roda sem pedido explícito seu |

### Achados 🔵 opcionais — resolvidos, com robustez

| # | Achado | O que foi feito |
|---|---|---|
| O1 | `"serie atualizada: 0 linha(s)"` quando nada foi medido | ramo próprio: `"nenhum gatilho foi medido com sucesso: NADA gravado, a serie fica sem o ponto de hoje"`. O log de sucesso agora diz **`N de M`**, então gravação parcial é visível. |
| O2 | `_stdout.tmp`/`_stderr.tmp` com nome fixo | temporários **por processo** (`_stdout_$PID.tmp`), limpeza incondicional ao fim (antes o stderr vazio ficava para trás) e varredura de órfãos > 1 dia. |
| O3 | pior caso de rede excede o `ExecutionTimeLimit` de `PT15M` | **`BUDGET_SECONDS = 600`** com relógio **monotônico**. O script para sozinho, grava o que apurou e sai 1 — em vez de ser morto pelo Agendador sem exit code, sem resumo e **sem gravar o que já mediu**. |

### Robustez além dos achados

**Gravação isolada até o último passo.** O laço de medição já isolava um gatilho quebrado dos
demais, mas a gravação era um **lote único**: uma linha recusada pelo banco levaria as outras seis
junto e a série perderia o mês por causa de um gatilho. O lote continua sendo a via normal (uma
requisição); em caso de recusa, cada linha é tentada sozinha. Falha de **transporte** não desmembra
— ali o `_request` já repetiu com backoff, e insistir 7 vezes só gastaria o orçamento de tempo.

### Verificação

- **Suíte Python: 1382** (baseline 1367 · +15) · `test_roadmap_gatilhos.py` de 26 → **39** casos.
- **3 mutantes** validados e revertidos: sem o teto de tempo, sem o desmembramento e com o log
  antigo — cada um deixa vermelho exatamente a guarda correspondente.
- `check_deploy_parity` **31/31** após regravar o manifesto.
- **Smoke test real do script** (`--dry-run`): 7 gatilhos medidos, exit 0, ~2,5 s — os testes
  mockam a rede, e o caminho real precisava ser exercitado depois do refactor.
- 🔴 **Caminho de ESCRITA exercitado de verdade** (era o mais reestruturado e o único sem cobertura
  real): execução completa → **7 linhas, 7 gatilhos distintos** (o UPSERT corrigiu o ponto do dia
  em vez de duplicar) e `measured_at` de **14:16 → 17:48**. É a prova em produção do invariante que
  a sonda P4b da 122 não conseguia dar.
- PowerShell: `run_gatilhos.ps1` reparseado (862 tokens, sem erro de sintaxe).

### 🔴 Consequência: é preciso um SEGUNDO deploy

`skills/roadmap-gatilhos/scripts/run.py` e `scheduler/run_gatilhos.ps1` mudaram **depois** da cópia
que você fez. Copie os três para `C:\Sheild\API\Pagamentos` e confirme lá:

```powershell
py -3 scheduler\check_deploy_parity.py     # exit 0 = paridade
```

`setup-gatilhos-task.ps1` **não** mudou — a tarefa agendada não precisa ser re-registrada.

**Nada foi commitado.**
