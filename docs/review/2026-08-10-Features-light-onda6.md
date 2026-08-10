# Code Review — Features / Onda 6 (campos derivados) (2026-08-10)

## Resumo

Alvo: `onda 6` (docs/roadmap-enriquecimento-dados.md § "ONDA 6 — Campos derivados na tabela fato", itens 6.1–6.7)
Modo: light (sem passo de ataque, sem verificação adversarial)
Delta: 4 arquivos alterados (+262/−15), 6 novos (1.750 linhas) — migrations 111–115, `tests/test_onda6_campos_derivados.py`
Régua: `CLAUDE.md` (raiz) · `docs/roadmap-enriquecimento-dados.md` · `supabase/migrations/README.md` · workspace `.claude/rules/`
Gates: pytest **1186** · Node **1376** (frontend-vite 847 · api-backend 527 · portal-next 2) · lint **0/0** · typecheck **OK** · e2e/Playwright **não executado** (exige navegador; crasha no sandbox do agente)
Verificação contra o banco real: 5 colunas geradas aplicadas (`attgenerated='s'`), view em 40 colunas, `dim_date` 11.323 linhas, `security_invoker=true`, advisors **sem achado novo**

A onda entrega 5 colunas geradas, `dim_date` e 2 funções de `analytics`, com qualidade de execução
alta: as migrations se auto-verificam (`DO $$` que aborta), as guardas foram validadas por mutante,
e **todos os oráculos declarados nas migrations conferem contra o banco — exceto um**. Os dois
defeitos de fundo são de mesma natureza: artefatos que **afirmam mais do que entregam**. Um é
executável (uma função que trunca a resposta em silêncio, contrariando invariante explícito do
projeto); os outros dois são instruções de verificação que, se seguidas, acusam defeito onde não há.

## Achados

### 🔴 Bloqueantes

- [supabase/migrations/115_vw_payables_onda6_recorrencia.sql:227] `analytics.fornecedores_recorrentes` trunca a resposta em 50 linhas sem nenhum campo que declare o corte.
  Falha:     Usuário autenticado chama `POST /rest/v1/rpc/fornecedores_recorrentes` — o schema `analytics` está exposto no PostgREST e a função tem `GRANT EXECUTE TO authenticated`, logo o caminho é alcançável hoje. Recebe **50** fornecedores dos **63** que atendem o critério. A pergunta "quantos fornecedores têm despesa recorrente?" é respondida com 50: número errado, plausível, sem erro nenhum. Quando a função for ligada como tool, o modelo contará as linhas truncadas — exatamente o modo de falha que o projeto já corrigiu duas vezes.
  Evidência: medido no banco em 2026-08-10 — `SELECT count(*) FROM analytics.fornecedores_recorrentes()` = **50**; `analytics.fornecedores_recorrentes(3,5,NULL,NULL,100000)` = **63**; o critério equivalente em SQL puro (`HAVING count(DISTINCT due_date) >= 3`) = **63**. O `RETURNS TABLE` (linhas 115–130) não tem nenhuma coluna de total.
  Correção:  Acrescentar `total_encontrado` via `count(*) OVER ()` avaliado antes do `LIMIT`, como a migration 108 fez em `documentos_fiscais`. Muda o `RETURNS TABLE`, então exige `DROP FUNCTION` + recriar. `analytics.parcelamentos` tem o mesmo `LIMIT COALESCE(p_limit, 50)` sem total — hoje devolve 10 de 10 grupos e não trunca, mas o defeito é estrutural e cresce com a base.
  Regra:     `CLAUDE.md`, "O que a Onda 1 entregou": *"🔴 `gasto_por_fornecedor` é um RANKING TRUNCADO (máx. 100 de 165 fornecedores): somar suas linhas NÃO dá o total do período — subestima em silêncio"* e, na Onda 3, *"`documentos_fiscais` devolve `total_encontrado` em toda linha (`count(*) OVER ()`, avaliado antes do LIMIT) — mesma armadilha do `gasto_por_fornecedor`: deixar o modelo contar as linhas truncadas produziria número errado com cara de certo."*

### 🟡 Recomendados

- [supabase/migrations/115_vw_payables_onda6_recorrencia.sql:323-326] O oráculo diferencial da VERIFICAÇÃO #3 não é equivalente ao que a função calcula — segui-lo acusa defeito onde não há.
  Falha:     O passo 3 manda conferir que `fornecedores_recorrentes(3)` devolve "o mesmo conjunto" que `... HAVING count(DISTINCT date_trunc('month', due_date)) >= 3`, e cita 27 fornecedores. Mas a função agrupa por **datas distintas** (`datas AS (... GROUP BY 1, 2)`, linha 149), não por meses. Quem executar a verificação vê 63 × 27, conclui que a função está quebrada e, no pior caso, "conserta" a função para casar com o oráculo — desfazendo justamente a correção "cadência se mede entre DATAS DISTINTAS" que a própria migration documenta em vermelho na linha 143.
  Evidência: medido — por datas distintas = **63**; por meses distintos = **27**. O texto é resíduo do enquadramento anterior à correção da cadência (a mesma medição de 27 aparece no comentário da linha 98 como baseline de meses).
  Correção:  Trocar o oráculo por `HAVING count(DISTINCT due_date) >= 3` e o número de referência de 27 para 63 (medição de 2026-08-10).
  Regra:     `CLAUDE.md`, Regra mandatória 2: *"Teste que promete uma garantia tem de entregá-la"* — vale para o oráculo de verificação, que é a guarda manual da migration.

- [supabase/migrations/112_fac_colunas_derivadas.sql:157] A VERIFICAÇÃO #1 manda conferir que a expressão cita `to_date`, mas a migration usa `make_date` — e proíbe `to_date` explicitamente.
  Falha:     Quem executar o passo 1 procura `to_date` no `pg_get_expr` de `competence_month`, não encontra, e conclui que a coluna foi criada errada. A ausência de `to_date` é exatamente o que a migration exige: o cabeçalho (linhas 31–43) explica em detalhe que `to_date` é STABLE e foi rejeitado pelo PostgreSQL, e a guarda G2 asserta `assertNotIn("to_date", expr)`. A instrução contradiz o próprio arquivo em três lugares.
  Evidência: linha 157 — *"conferir que competence_month cita `to_date` e NÃO cita `::date` nem `due_date`"*; a expressão real (linha 61, confirmada em `pg_attrdef`) é `make_date(...)`; `tests/test_onda6_campos_derivados.py::G2CompetenceMonthTest::test_usa_make_date_e_nao_uma_funcao_STABLE`. Resíduo do texto do roadmap, que prescrevia `to_date`.
  Correção:  Trocar `to_date` por `make_date` no texto do passo 1 da VERIFICAÇÃO.
  Regra:     mesma da anterior.

### 🔵 Opcionais

- [supabase/migrations/115_vw_payables_onda6_recorrencia.sql:275-285] O `ARRAY(...)` de `parcelas_faltando` re-consulta `analytics.vw_payables` uma vez por grupo (N+1). Irrelevante em 10 grupos; vira custo se o número de carnês crescer uma ordem de grandeza.
- [supabase/migrations/111_dim_date_feriados.sql:201] `'Páscoa'` é classificada como `holiday_kind='bancario'`. Cai sempre em domingo, então não afeta `is_business_day` — mas rotular como "fechamento bancário" um dia que nunca foi útil mistura duas semânticas na mesma coluna.

## Pendências (trabalho incompleto)

- [apps/api-backend/lib/ai-chat/tools.ts] `analytics.fornecedores_recorrentes` e `analytics.parcelamentos` **não têm consumidor**: as 9 tools registradas são `resumo_situacao`, `gasto_por_periodo`, `gasto_por_fornecedor`, `gasto_por_classificacao`, `demonstrativo_despesas`, `aging_vencidos`, `listar_contas`, `buscar_emails`, `documentos_fiscais` — nenhuma das duas novas. O roadmap escopou o item 6.6 como *"função em `analytics`"* (não como tool), então **não é item do plano descumprido**; mas capacidade sem consumidor não responde pergunta nenhuma ao usuário, e é a decisão que fecha a onda de fato — **recomendada**.
- [tests/test_onda6_campos_derivados.py] Nenhum marcador `TODO`/`FIXME`/`HACK` e nenhum teste pulado no delta. A única ocorrência que a varredura acusou (`"""O CASE precisa cobrir TODO o dominio..."""`) é falso positivo do padrão em pt-BR — **não é pendência**.

## Drift código × documentação

Nenhum. Conferi contra o banco real as afirmações que o `CLAUDE.md`, o roadmap e o `README.md` das
migrations passaram a fixar como régua, e todas se sustentam:

| Afirmação | Onde | Medido |
|---|---|---|
| 5 colunas geradas, `attgenerated='s'` | CLAUDE.md | ✅ as 5, expressões idênticas ao arquivo |
| view de 35 → **40** colunas, 35 originais preservadas em ordem | roadmap 6.7 | ✅ 40; diff estrutural 103×115 sem perda |
| `dim_date` **11.323** dias | CLAUDE.md | ✅ 11.323 |
| `dias_uteis('2026-01-01','2026-02-01')` = **21** | 111 § VERIFICAÇÃO 5 | ✅ 21 (também com `SET LOCAL ROLE authenticated`) |
| **19** contas com parcela; coluna × função batem | 114 § VERIFICAÇÃO 2 | ✅ 19 = 19 |
| `extraction_confidence` sem NULL e sem `desconhecida` | 112 § VERIFICAÇÃO 2 | ✅ 0 e 0 |
| **5 carnês** com parcelas 1 e 2 faltando | CLAUDE.md | ✅ exatamente 5, todos `{1,2}` |
| carnê `962148`: 3 observadas, maior 3, faltando vazio | 115 § VERIFICAÇÃO 4 | ✅ |
| **40 casos** de guarda | CLAUDE.md | ✅ 40 coletados |
| `anon` sem EXECUTE nas 2 funções; sem SELECT em `dim_date` | 111/115 § Grants | ✅ `false` nos três |
| `security_invoker=true` na view | 115 § VERIFICAÇÃO 2 | ✅ |
| advisors sem achado novo | 111–115 § VERIFICAÇÃO | ✅ nenhum objeto da onda na lista |

## Não coberto

1. **`docs/roadmap-enriquecimento-dados.md` (+101 linhas) lido em parte.** Li a seção ONDA 6 (linhas 562–700) e localizei §7.5, mas não o arquivo inteiro (>1.300 linhas). Achados fora dessa seção não seriam vistos.
2. **Prova do caminho REAL de escrita não executada.** As VERIFICAÇÕES da 112 (item 3) e da 114 (item 4) exigem `py -3 scripts\reprocess_message.py <message_id>` — um INSERT de verdade por `register_financial` — para provar ausência de 428C9. Não rodei: exige IMAP + Claude API e grava no banco de produção. O risco está mitigado pelo `.omit()` do Zod e pela guarda G1, mas **mitigação não é prova de execução**.
3. **Curadoria NF/Boleto com usuário real não exercitada.** As VERIFICAÇÕES da 112 (item 4) e da 114 (item 5) pedem alternar "Tem NF" em `/consulta` logado, para provar que o `GRANT EXECUTE` das funções de parcela sustenta o UPDATE por coluna de `authenticated`. Conferi o grant por catálogo, não por UPDATE real — e o próprio projeto registra que privilégio concedido e operação bem-sucedida são perguntas diferentes.
4. **RLS com grupo restrito não exercitada nas funções novas.** `SET LOCAL ROLE authenticated` não carrega claims de JWT, então `auth_group_sees_only_own()` não passou pelo caminho verdadeiro. O recorte de `fornecedores_recorrentes`/`parcelamentos` para um usuário do grupo Comercial permanece não medido — é a mesma prova que o projeto já registra como adiada por decisão para o chat.
5. **Camada e2e/Playwright não executada** — exige navegador; o renderer crasha no sandbox do agente.
6. **Dimensão de concorrência não aplicada:** o delta não introduz caminho concorrente (DDL + funções puras/STABLE), então a linha da grade não foi exercida.

---

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| B1 | `fornecedores_recorrentes` trunca em 50 de 63 sem declarar o corte | ⏸️ **adiado** | Exige `DROP FUNCTION` + recriar (o `RETURNS TABLE` muda) numa migration **já aplicada em produção** — cai em duas exceções do Passo 8: artefato imutável aplicado e correção que exige DDL no banco. SQL exato abaixo. |
| R1 | Oráculo da VERIFICAÇÃO #3 da 115 mede meses onde a função mede datas | ✅ **corrigido** | `115_vw_payables_onda6_recorrencia.sql:323-332` — oráculo reescrito para `count(DISTINCT due_date) >= 3` + teto explícito. Validado contra o banco: **63 = 63, EXCEPT vazio nos dois sentidos**. |
| R2 | VERIFICAÇÃO #1 da 112 manda conferir `to_date`, que a migration proíbe | ✅ **corrigido** | `112_fac_colunas_derivadas.sql:155-160` — passa a exigir `make_date` e declara que a ausência de `to_date` é o resultado correto. |

Gates após a correção: **pytest 1186 · Node 1376 · lint 0/0 · typecheck OK**
Baseline (Passo 3):    **pytest 1186 · Node 1376 · lint 0/0 · typecheck OK**
Re-review do diff da correção: **sem achado novo** — as duas edições são integralmente comentário
(verificado linha a linha: nenhuma linha editada fora de `--`), nenhum arquivo versionado foi
tocado, e o SQL executável das duas migrations é idêntico ao aplicado no banco. Nenhuma alteração
de estado no Supabase.

### B1 — remediação, para você aplicar quando decidir

Muda o `RETURNS TABLE`, então **não** basta `CREATE OR REPLACE`. Espelha o padrão já usado em
`documentos_fiscais` (migration 108). Sugestão: migration nova `116`, deslocando a Onda 7 para
117–118.

```sql
DROP FUNCTION IF EXISTS analytics.fornecedores_recorrentes(integer, integer, date, date, integer);

-- recriar idêntica à 115, com DUAS mudanças:
--   1. acrescentar ao RETURNS TABLE:  total_encontrado integer
--   2. no SELECT final, antes do LIMIT:  count(*) OVER ()::integer AS total_encontrado
-- (count(*) OVER () é avaliado ANTES do LIMIT — é isso que faz o total ser o real, não o truncado)

GRANT  EXECUTE ON FUNCTION analytics.fornecedores_recorrentes(integer, integer, date, date, integer) TO authenticated;
REVOKE EXECUTE ON FUNCTION analytics.fornecedores_recorrentes(integer, integer, date, date, integer) FROM PUBLIC, anon;
```

Aplicar o mesmo a `analytics.parcelamentos(bigint, integer)`: hoje devolve 10 de 10 grupos e não
trunca, mas tem o mesmo `LIMIT COALESCE(p_limit, 50)` sem total — o defeito é estrutural e aparece
sozinho quando a base crescer.

Não corrigido por decisão sua: B1 (acima), os 2 achados 🔵 opcionais e a pendência de wiring das
duas funções como tool do chat.
**Nada foi commitado.**

---

## Desfecho final — B1 resolvido (2026-08-10, a pedido do usuário)

O adiamento de B1 foi **revertido por decisão do usuário** ("resolver bloqueante e 2 recomendados
com robustez de código"). Correção entregue pela **migration 116**, escrita e **aplicada**.

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| B1 | `fornecedores_recorrentes` trunca 63→50 sem declarar | ✅ **corrigido e aplicado** | `116_analytics_total_encontrado.sql`. Medido depois: 50 linhas devolvidas, `total_encontrado = 63`. |
| R1 | Oráculo da VERIFICAÇÃO #3 da 115 mede meses, função mede datas | ✅ corrigido | `115:323-332`; validado no banco (63 = 63, `EXCEPT` vazio nos dois sentidos) |
| R2 | VERIFICAÇÃO #1 da 112 exige `to_date`, que a migration proíbe | ✅ corrigido | `112:155-160` |

### O que entrou além do mínimo, e por quê

O fix mínimo seria só `total_encontrado`. Três reforços foram incluídos porque o mesmo `DROP` +
`CREATE` já era necessário e adiá-los custaria uma segunda migration sobre as mesmas funções:

| Reforço | Defeito que fecha | Grounding |
|---|---|---|
| `total_encontrado` via `(count(*) OVER ())::integer` | truncagem indistinguível de "acabou" | padrão de `documentos_fiscais` (108) |
| `ORDER BY ... , sk_supplier` (e `, installment_base`) | `ORDER BY` que empata + `LIMIT` = recorte que **varia com o plano de execução**, sem erro — o ranking mudaria sozinho | mesma lição de `lib/stableOrder.ts` / `applyOrder` |
| `LIMIT GREATEST(COALESCE(p_limit, 50), 0)` | `p_limit` negativo levanta **2201W** em runtime; o parâmetro vem de tool/LLM, não é confiável | validação de entrada na fronteira |
| `DO $$` que aborta comparando declarado × real | o oráculo compara **os dois caminhos entre si**, nunca contra número fixo (63 e 10 derivam a cada conta lançada) | padrão das migrations 111/113 |

**Grants reemitidos explicitamente:** `DROP FUNCTION` apaga os grants. Sem reemitir, as funções
nasceriam executáveis por `PUBLIC` (default do PostgreSQL) e **inexecutáveis** por `authenticated` —
abertas para quem não deve e quebradas para quem deve. Conferido pós-aplicação: `anon` = false/false,
`authenticated` = true/true.

### Guardas (G9) — 7 casos novos, todos validados por mutante

`tests/test_onda6_campos_derivados.py::G9TruncagemDeclaradaTest`. Seis mutantes injetados **em série
e sobre backup**, cada um revertido no mesmo comando encadeado e com integridade confirmada:

| Mutante | Guarda que ficou vermelha |
|---|---|
| M1 `RETURNS TABLE` sem `total_encontrado` | `test_toda_funcao_com_LIMIT_declara_o_total` |
| M2 janela → subconsulta (herdaria o `LIMIT`) | `test_o_total_e_JANELA_e_nao_subconsulta` |
| M3 `ORDER BY` sem desempate pela PK | `test_a_ordem_e_TOTAL_para_o_recorte_ser_deterministico` |
| M4 `LIMIT` sem clamp de negativo | `test_o_LIMIT_e_protegido_contra_valor_negativo` |
| M5 `DROP` sem reemitir `GRANT` | `test_o_DROP_reemite_os_grants` |
| M6 oráculo fixando `63` em vez de comparar caminhos | `test_a_migration_se_auto_verifica_comparando_declarado_x_real` |

**Mudança estrutural na infra de guarda:** `_migration_que_contem` passou a devolver a migration
**MAIS RECENTE** que casa, não "a única". A versão anterior (`assert len == 1`) quebrava assim que a
116 redefiniu `analytics.fornecedores_recorrentes` — dois arquivos passavam a casar. Seguir a última
é o comportamento correto: numa cadeia de migrations a definição que vale é a vigente, e é sobre ela
que as invariantes de G7 (SECURITY INVOKER, `search_path`, bandas disjuntas, `anon` sem EXECUTE)
precisam valer. Travá-las na 115 deixaria a 116 livre para regredir qualquer uma com a suíte verde.
Consequência tratada: o marcador da 115 em G8 passou a ser a **view** (único a ela), e G8 ganhou uma
asserção de que os marcadores apontam para arquivos **distintos** — sem ela, dois marcadores
colapsando na mesma migration deixariam outra sem verificação, em silêncio.

### Verificação pós-aplicação (banco real)

| Prova | Resultado |
|---|---|
| `fornecedores_recorrentes()` — linhas / total declarado / total real | 50 / **63** / 63 |
| `parcelamentos()` — linhas / total declarado | 10 / 10 |
| `LIMIT` negativo | 0 linhas, **sem erro** |
| Regra de negócio inalterada (`EXCEPT` contra o SQL de controle) | vazio nos dois sentidos |
| Determinismo (duas chamadas, mesmo recorte) | idêntico |
| `anon` / `authenticated` EXECUTE | false·false / true·true |
| `get_advisors` | idêntico ao baseline, nenhum objeto da onda |

Gates finais: **pytest 1193** (baseline 1186, +7) · **Node 1376** (inalterado) · **lint exit 0** ·
**typecheck exit 0**.

### Documentação ajustada (consequência factual da 116, não drift pré-existente)

`CLAUDE.md` (3 pontos: sequência `001 → 116`, próxima = `117`, Onda 7 → **117–118**) e o roadmap
(mesma renumeração). Foi a criação da 116 que tornou esses números errados — corrigir é fechar a
própria mudança, não sincronizar drift alheio.

**Nada foi commitado.** Tudo no working tree.
