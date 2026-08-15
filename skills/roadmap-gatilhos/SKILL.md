---
name: roadmap-gatilhos
description: Mede mensalmente os 7 gatilhos condicionais da Onda 9 do roadmap de enriquecimento de dados e grava a série histórica em analytics.roadmap_trigger_snapshot. Somente leitura sobre o negócio. Acione quando o usuário perguntar "algum gatilho da Onda 9 disparou?", "vale implementar NFS-e/CF-e/text-to-SQL agora?", "como está a série dos gatilhos" ou quando for reavaliar o roadmap.
---

# Medidor dos gatilhos da Onda 9

```powershell
py -3 skills\roadmap-gatilhos\scripts\run.py --dry-run   # mede e imprime, NÃO grava
py -3 skills\roadmap-gatilhos\scripts\run.py             # mede e grava a série
```

## Por que existe

A **Onda 9 é condicional**: cada item só entra quando o gatilho dele ocorre
(`docs/roadmap-enriquecimento-dados.md` §4). Implementar antes é construir para um cenário que não
existe — foi o que aconteceu com os itens 5.1/5.2, suspensos depois de medida a população real.

🔴 **O valor de remedir não é o alerta, é a SÉRIE.** Nenhum gatilho vira de um mês para o outro.
Ver NFS-e ir de 1 → 3 → 8 antecipa a decisão; três vereditos `false` isolados não dizem nada. Por
isso cada execução grava em `analytics.roadmap_trigger_snapshot` (migration 122) em vez de só
imprimir.

## Os 7 gatilhos e seus critérios

| Chave | Dispara quando | Observação |
|---|---|---|
| `dpo_pontualidade` | ✅ **já disparou** (Onda 9, migration 121) | segue medido para acompanhar a **cobertura** da métrica |
| `cfe_nfce` | ≥ 1 documento modelo 59/65 | o parser da Onda 3 já os aceita; o gatilho decide se vale tratamento próprio |
| `nfse` | ≥ 20 contas `document_type = nfse` | sem chave nacional, **cada município é um layout** — o volume precisa estar concentrado, e isso só a leitura manual do acervo confirma |
| `text_to_sql` | ≥ 100 interações **e** ≥ 10% com erro/truncagem | ⚠️ ver o ponto cego abaixo |
| `tabelas_agregadas` | ≥ 50.000 contas (**proxy**) | o gatilho real é latência (>~500 ms warm), não mensurável por REST — ver abaixo |
| `receitas_dre` | nunca automaticamente | decisão do dono do produto (opção B, 2026-07-31) |
| `conciliacao_bancaria` | nunca automaticamente | depende de integração bancária, que não existe |

Os limiares vivem no topo do `run.py` e vão para o banco em `criterion` **a cada medição** — sem
isso, um `fired = false` de hoje fica inauditável quando o limiar mudar.

## Duas honestidades embutidas (não "corrigir")

🔴 **O ponto cego do `text_to_sql`.** O log **não registra** "o modelo respondeu que não consegue":
quando falta capacidade, ele declara a limitação com educação e a interação fica com `error IS
NULL` — **conta como sucesso**. As duas lacunas já conhecidas (fornecedor × classificação contábil,
e empresa em `gasto_por_periodo`) foram descobertas **lendo o log à mão**. Um `fired = false` aqui
significa "nada detectável por consulta", nunca "as tools cobrem tudo". O critério gravado diz isso.

🔴 **`tabelas_agregadas` mede um PROXY, e o declara.** O gatilho real exige `EXPLAIN ANALYZE`, e o
`service_role` não executa as tools por REST — de propósito, já que o `EXECUTE` é exclusivo de
`authenticated`, que é o que faz a RLS decidir o recorte do chat. Abrir isso para medir latência
trocaria uma garantia de segurança por conveniência de diagnóstico.

## Garantias do script

- **Somente leitura** sobre o negócio; a única escrita é a própria série.
- **UPSERT por `(trigger_key, measured_on)`** — remedir no mesmo dia **corrige** o ponto em vez de
  duplicar. Sem isso, qualquer média sobre a série passaria a mentir.
- **Contagem pelo header `Content-Range`**, nunca contando linhas: o PostgREST corta em "Max rows"
  e responde 200 (a armadilha registrada na Onda 3).
- **Isolamento por gatilho** na medição **e na gravação**: um gatilho indisponível não custa a
  série inteira, e uma linha recusada pelo banco (chave fora do domínio, métrica que o `jsonb`
  rejeita) não leva as outras seis junto — o lote é a via normal, e só em caso de falha as linhas
  são tentadas uma a uma. Nada disso é engolido: tudo aparece no exit code.
- **Timeout explícito + retry** em falha de rede **e em 429/5xx** (que são do servidor, não do
  pedido). 4xx fora do 429 é definitivo — repetir só atrasaria a tarefa e adiaria o diagnóstico.
- **Teto de tempo de 10 min** (`BUDGET_SECONDS`) para a medição inteira. O pior caso de rede passa
  dos 15 min do `ExecutionTimeLimit` da tarefa, e ser morto pelo Agendador é o desfecho ruim: sem
  exit code próprio, sem resumo e **sem gravar o que já tinha sido medido**. Com o teto, o script
  para sozinho, grava o que apurou e sai 1.
- A data de corte da pontualidade vem da **fonte única** (`analytics.payment_date_confiavel_desde()`),
  nunca fixada aqui.
- **Compara `fired` com a última medição de um dia ANTERIOR** daquele `trigger_key` e loga em
  `ERROR` quando o veredito muda (Onda 10) — até aqui a única forma de notar era abrir a tabela
  à mão. 🔴 **O registro do próprio dia fica FORA da busca** (`measured_on=lt.hoje`, fuso da
  série): sem isso, a reexecução no mesmo dia — cenário normal, é a razão do UPSERT — compararia
  consigo mesma e **sobrescreveria o `mudou=true` da 1ª execução com `false`**, apagando a
  transição do painel e negando o alarme que motivou a reexecução (achado do code review de
  2026-08-14). É uma checagem **diagnóstica**: falha nela (rede, JSON, campo ausente) nunca
  conta para o exit code, só entra em `WARNING`; e é guardada pelo mesmo orçamento de tempo da
  medição (busca leve, 1 tentativa, timeout curto — nunca o retry pesado de `_request`). A
  mudança fica registrada em `metrics.mudou_desde_ultima_medicao` (`true`/`false`/`null` na 1ª
  medição) — **sem migration nova**, porque `metrics` já é `jsonb` livre.

## Agendamento — 5ª tarefa, em PRODUÇÃO

```powershell
.\scheduler\setup-gatilhos-task.ps1     # como Administrador; dia 1 de cada mês, 07:00
& .\scheduler\run_gatilhos.ps1 -DryRun  # medir sem gravar
```

Roda em produção (`C:\Sheild\API\Pagamentos`) junto das outras quatro — decisão do dono do produto
em 2026-08-13; antes rodava só no dev. Está nos `DEPLOY_GLOBS` do `check_deploy_parity.py`, então
**o deploy dela é verificado como o das demais** (31 arquivos no manifesto).

⚠️ **Diferença de natureza que continua valendo:** é a única rotina agendada que **não faz parte do
pipeline financeiro** — não lê e-mail, não cobra ninguém, não move dinheiro. Uma falha dela reprova
a tarefa no Agendador e gera Event Log (`Pagamentos-Gatilhos`, EventId 1005) exatamente como as
outras, mas **não há impacto no negócio**: o efeito é a série ficar sem o ponto daquele mês. Ao
triar um alerta, comece por aí.

**Zero dependência nova:** usa `urllib` (stdlib) + `python-dotenv`, e lê `SUPABASE_URL` /
`SUPABASE_SERVICE_KEY` do `.env` — as mesmas que `baixa-automatica` já usa. Não precisa de
`SUPABASE_DB_URL` nem de `pg_dump`.

Logs em `logs\gatilhos\gatilhos_AAAAMM.log`, retidos **400 dias** (13 medições): com os 30 dias das
outras tarefas, o log da medição anterior seria apagado antes da próxima — e nunca haveria dois
para comparar.

## Ler a série

```sql
SELECT measured_on, fired, metrics
  FROM analytics.roadmap_trigger_snapshot
 WHERE trigger_key = 'nfse'
 ORDER BY measured_on DESC;
```

Todas as transições já gravadas na história (o "painel" — nenhuma UI nova é criada; a série
enriquecida já responde a esta consulta):

```sql
SELECT trigger_key, measured_on, fired,
       metrics->>'mudou_desde_ultima_medicao' AS mudou
  FROM analytics.roadmap_trigger_snapshot
 WHERE metrics->>'mudou_desde_ultima_medicao' = 'true'
 ORDER BY measured_on DESC;
```

Guardas: `tests/test_roadmap_gatilhos.py` (**58 casos**, incluindo a guarda cross-layer que impede o
script de gravar chave que o CHECK da migration recusa, o retry de 429/5xx, o teto de tempo, o
desmembramento do lote de gravação e — desde a Onda 10 — a comparação de estado entre medições
consecutivas, com a exclusão do registro do próprio dia).
