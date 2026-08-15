# Code Review — Features / Onda 10 (2026-08-14)

> Retrato datado do estado encontrado ANTES da fase de correção. A tabela de desfecho ao final
> registra o que foi corrigido; o corpo do relatório não é reescrito (rito da skill
> `meu-code-review-max`).

## Resumo

Alvo: `@docs/roadmap-enriquecimento-dados.md` (docs/roadmap-enriquecimento-dados.md § ONDA 10)
Modo: max (passo de ataque + verificação adversarial)
Delta: 6 arquivos alterados, 0 novos, +432/−13 linhas
Régua: CLAUDE.md do projeto + docs/roadmap-enriquecimento-dados.md + skills/roadmap-gatilhos/SKILL.md + migration 122
Gates: pytest alvo 57/57 · pytest suíte completa **1427/1427** · ruff não executado (módulo não instalado no `py -3`) · vulture não executado (comando interrompido pela troca de modo) · npm test/lint/typecheck não executados (o diff não toca código Node — só `.py`/`.md`/`.json` do scheduler)
Verificação adversarial: 4 contestações; 2 achados confirmados (B1: 2 CONFIRMADO + 1 ENFRAQUECIDO-severidade → confirmado pela maioria; R1: 1 CONFIRMADO), 0 enfraquecidos, 0 refutados

Revisado o diff completo da Onda 10: `run.py` (+101), `test_roadmap_gatilhos.py` (+259, 39→57
casos — os 18 novos conferidos um a um), `SKILL.md`, `CLAUDE.md`, roadmap e
`deploy-manifest.json` (hash do manifesto **verificado por medição**: `e90ea8a7…` bate com o
sha256 atual do `run.py`). O desenho da Onda 10 é sólido — contrato de exit code preservado,
fail-open diagnóstico correto, orçamento de tempo respeitado, testes que travam de verdade
(validação por mutante plausível). Dois defeitos sobreviveram à contestação: um de
**idempotência da série** (reexecução no mesmo dia apaga o marcador de transição) e uma
**violação da regra do total da suíte** no roadmap.

## Achados

### 🔴 Bloqueantes

- [skills/roadmap-gatilhos/scripts/run.py:287] `_buscar_estado_anterior` não exclui o registro
  do PRÓPRIO DIA — reexecução no mesmo dia compara "hoje contra hoje" e o UPSERT sobrescreve
  `metrics.mudou_desde_ultima_medicao` de `true` para `false`, apagando da série o marcador de
  transição. `[verificado]`
  Falha:     Mês em que um gatilho transiciona (`fired` false→true). Execução 1: compara com o
             mês anterior, grava `mudou=true`, loga ERROR. O operador **reexecuta no mesmo dia
             justamente para conferir o alarme**: a execução 2 lê a linha de hoje
             (`order=measured_on.desc&limit=1` sem filtro de data), calcula `mudou=false`, o
             `merge-duplicates` sobrescreve `metrics` e o resumo imprime "mudou de estado:
             nenhum" — negando ativamente o alarme que motivou a reexecução. A consulta-painel
             do SKILL.md (`WHERE metrics->>'mudou_desde_ultima_medicao' = 'true'`) perde a
             transição.
  Evidência: run.py:287-288 (URL sem `measured_on=lt.`); migration 122:42
             (`measured_on DEFAULT (NOW() AT TIME ZONE 'America/Sao_Paulo')::date`) + UNIQUE
             por dia + a própria migration declara a reexecução no mesmo dia como cenário
             normal ("acontece o tempo todo", 122:20-24) e **já aconteceu em produção**
             (CLAUDE.md, bloco da migration 123: reexecução de 14:16→17:48 em 2026-08-13);
             sonda P4 da 122 prova que o conflito sobrescreve `metrics`. A docstring da própria
             função promete "ANTES desta execucao" — a query não cumpre. Nenhum dos 18 testes
             novos exercita o cenário mesmo-dia (todos mockam `_buscar_estado_anterior`).
  Correção:  Excluir o dia corrente da busca: `&measured_on=lt.<hoje America/Sao_Paulo>`
             (UTC−3 fixo — o Brasil não tem mais horário de verão; `zoneinfo` exigiria o pacote
             `tzdata` no Windows, e a skill é zero-dependência). Teste novo travando o filtro na
             URL + validação por mutante (remover o filtro → vermelho).
  Regra:     Migration 122 ("remedir CORRIGE o ponto… sem ela, qualquer média ou gráfico sobre
             a série passaria a mentir") — a Onda 10 quebrou essa idempotência: remedir passou a
             ALTERAR o dado gravado. CLAUDE.md Regra 2 (docstring que promete garantia).
  Veredito:  CONFIRMADO (2 de 3 lentes; a lente de impacto defendeu rebaixar por: ERROR retido
             400 dias no mesmo arquivo mensal, `fired` íntegro e transição reconstruível por
             `lag(fired)`, rotina sem impacto no negócio — ressalva registrada, mas a maioria
             sustentou o mecanismo e o dano ao painel/resumo)

### 🟡 Recomendados

- [docs/roadmap-enriquecimento-dados.md:932] A seção "Verificação" da Onda 10 grava o TOTAL da
  suíte Python ("Suíte Python inteira: **1427 passados** (era 1409)") fora do CLAUDE.md.
  `[verificado]`
  Falha:     No próximo PR que alterar a suíte, o "1427" do roadmap diverge do total real e
             vira a 2ª cópia mentirosa — exatamente a falha da Onda 8, descrita no MESMO
             documento.
  Evidência: CLAUDE.md: "🔴 O TOTAL da suíte vive AQUI e em nenhum outro doc. Registro de onda
             cita o INCREMENTO". Agravante achado pela contestação: a seção da **Onda 8 no
             mesmo arquivo** (linhas 825-832) traz o aviso "🔴 A contagem TOTAL da suíte não se
             repete aqui, de propósito" — a Onda 10 reintroduziu o que a Onda 8 removeu.
  Correção:  Remover a frase do total; manter só o incremento (39 → 57, +18) com ponteiro para
             o CLAUDE.md, no padrão da Onda 8.
  Regra:     CLAUDE.md § Regras mandatórias 2 ("O TOTAL da suíte vive AQUI e em nenhum outro doc")
  Veredito:  CONFIRMADO (1 lente, com evidência adicional à do achado original)

### 🔵 Opcionais

- [tests/test_roadmap_gatilhos.py:655-672] `G6RequestLeveTest` duplica os helpers `_Resp`/`_erro`
  de `G2bRetryHttpTest` (variação mínima: sem headers) — poderiam ser compartilhados no módulo.

## Pendências (trabalho incompleto)

- [skills/roadmap-gatilhos/scripts/run.py] **Deploy para produção pendente** — `run.py` está
  nos `DEPLOY_GLOBS` e mudou; o manifesto foi regravado no mesmo commit (regra cumprida, hash
  conferido), mas a cópia física para `C:\Sheild\API\Pagamentos` é manual, do operador (copiar
  `run.py` + `deploy-manifest.json` e rodar `py -3 scheduler\check_deploy_parity.py` LÁ). —
  **recomendada** (a correção do B1 muda o hash de novo: fazer o deploy só após o fechamento
  deste review)
- Itens do plano (Onda 10: 10.1/10.2/10.3): **todos entregues** — nenhuma pendência de escopo.
- Marcadores TODO/FIXME/stub no delta: nenhum.

## Drift código × documentação

- skills/roadmap-gatilhos/scripts/run.py:279 diverge da própria docstring ("fired do ULTIMO
  registro ja gravado… **ANTES desta execucao**" — a query devolve o registro DESTA execução no
  cenário mesmo-dia) e do SKILL.md ("compara com a última medição já gravada") — é o mesmo fato
  do achado B1; corrigido o B1, docstring e SKILL.md passam a estar corretos por consequência
  (a atualização mínima dos dois textos faz parte do fix, por serem entregas deste mesmo diff,
  não doc pré-existente).

## Não coberto

- `ruff`/`vulture` não executados (módulos ausentes no `py -3` / comando interrompido pela
  troca de modo) — o lint Python deste repo é best-effort (SonarCloud cobre no PR).
- Gates Node não executados — o diff não contém código Node.
- B1 provado estruturalmente (código + catálogo da migration + sonda P4), **não** por
  reexecução real contra o banco de produção.
- A validação por mutante declarada no roadmap ("mudou=False fixo pego por 4 testes") não foi
  re-executada neste review; a plausibilidade foi conferida lendo as asserções.

---

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| B1 | Reexecução no mesmo dia apaga o marcador de transição (`_buscar_estado_anterior` sem filtro de data) | ✅ corrigido | `run.py`: helper `_hoje_serie()` (UTC−3 fixo, espelha o DEFAULT da 122) + `&measured_on=lt.<hoje>` na URL; docstring e bullet do `SKILL.md` atualizados. Testes: `test_exclui_o_registro_do_proprio_dia_da_comparacao` (novo) + `measured_on=lt.` na guarda de URL. **Mutante validado**: filtro removido → 2 testes vermelhos; revertido e confirmado com `diff -q`. Manifesto regravado (`check_deploy_parity.py --update`, 31/31 em paridade) |
| R1 | Roadmap grava o TOTAL da suíte fora do CLAUDE.md | ✅ corrigido | `docs/roadmap-enriquecimento-dados.md`: frase do total removida; incremento mantido + ponteiro para o CLAUDE.md, no padrão da Onda 8. `grep 1427\|1409` no roadmap → 0 ocorrências |

Gates após a correção: pytest alvo **58** (+1) · suíte completa **1428** (+1) · parity 31/31
Baseline (Passo 3):    pytest alvo 57 · suíte completa 1427
Re-review do diff da correção: sem achado novo (helper puro sem caminho de erro; assinatura de
`_buscar_estado_anterior` preservada — os mocks dos 1428 testes confirmam; a duplicação do fuso
−3 × `America/Sao_Paulo` da migration é trade-off consciente, documentado no comentário do
código, pela ausência de `tzdata` no Windows).

Não corrigido por decisão sua:
- 🔵 opcional (helpers `_Resp`/`_erro` duplicados entre G6 e G2b nos testes).
- ⏸️ **Contagens do CLAUDE.md** (doc de estado, intocado pela fase de correção por regra da
  skill): o total da suíte vive lá como **1.427** e a Onda 10 como **57 casos** — após esta
  correção a realidade é **1.428 / 58**. Atualizar o CLAUDE.md é decisão sua no fechamento
  (os "39 → 57 na Onda 10" seguem historicamente corretos como incremento da onda; o +1 é do
  code review).
- ⏸️ **Deploy para produção** (pendência do operador): copiar `skills/roadmap-gatilhos/scripts/run.py`
  + `scheduler/deploy-manifest.json` para `C:\Sheild\API\Pagamentos` e rodar
  `py -3 scheduler\check_deploy_parity.py` LÁ — só após o merge, com o hash novo (`17219c1f…`).

Nada foi commitado.
