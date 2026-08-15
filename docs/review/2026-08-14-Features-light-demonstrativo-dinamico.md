# Code Review — Features (2026-08-14)

## Resumo
Alvo: nenhum (review do diff completo)
Modo: light (sem passo de ataque, sem verificação adversarial)
Delta: 15 arquivos alterados, 2 novos, +705/−65 linhas (tamanho ANTES da correção deste review;
exclui `docs/review/2026-08-14-Features-max-onda10.md`, artefato de review anterior)
Régua: CLAUDE.md do projeto (Regras mandatórias 1–5, "Padrão de execução e robustez técnica",
"Banco de dados") + docs/roadmap-enriquecimento-dados.md + docs/knowledge/dashboards.md
Gates: pytest **1428/1428** · `packages/shared` typecheck/lint/test **53/53** · `api-backend`
typecheck/lint/test **613/613** · `frontend-vite` typecheck/lint OK, test **876/876** (medidos
minutos antes deste review, mesmo estado do diff) · `npm run prune` (3 apps) **0 achados**

O diff acumula três entregas desde o último commit: (1) a correção da Onda 10 do
`roadmap-gatilhos` (já revisada em `2026-08-14-Features-max-onda10.md`, sem mudança desde
então); (2) migration 127, ensinando `demonstrativo_despesas` sobre o tipo 9 do catálogo; (3)
migration 128, tornando a mesma função dinâmica, mais o fix irmão no dashboard
`/dashboard_despesas`. Este review focou nas partes (2) e (3), não revisitadas por nenhum review
anterior — e encontrou dois achados recomendados, ambos já corrigidos na fase de correção (ver
tabela ao final).

## Achados

### 🔴 Bloqueantes
Nenhum.

### 🟡 Recomendados

- [supabase/migrations/128_demonstrativo_despesas_dinamico.sql:52-63] Os dois `LEFT JOIN` que
  tornam `demonstrativo_despesas` dinâmica não validavam `applies_to` do catálogo — um tipo
  GROUP-only podia ser casado pelo lado do SUBGRUPO (e vice-versa), classificando contas de
  forma cruzada quando o cadastro tivesse essa inconsistência.
  Falha:     O tipo 4 ("Passivo", `applies_to='group'`) tem `demonstrativo_line_order=5`. Se
             algum dia um SUBGRUPO for cadastrado com `type_group_id=4` — nada no banco impede
             isso, só o `CHECK` de domínio na própria linha do catálogo, não uma validação
             cruzada de escopo — o `LEFT JOIN sg_tg ON sg_tg.type_group_id =
             v.chart_subgroup_type_id` casaria por esse id, e a conta viraria "Tributos (passivo
             tributário)" via um caminho que a função nunca teve intenção de percorrer, mesmo
             sem o subgrupo ter qualquer classificação Fixa/Variável/Custo. O caminho de
             cadastro que tornaria isso alcançável é exatamente o que criou o bug original desta
             migration: escrita direta por `service_role`/SQL, sem passar pelo
             `validateTypeGroupScope` da app (`apps/api-backend/lib/lookups.ts:253-267`), que só
             protege a escrita via o CRUD do Next.js.
  Evidência: `grep -rn "applies_to" supabase/migrations/*.sql` mostra que a coluna só tem um
             `CHECK` de domínio (`094_type_group_applies_to.sql:25-26`) — nenhuma migration
             amarra `financial_chart_of_account_group.type_group_id`/`_subgroup.type_group_id`
             ao `applies_to` da linha referenciada. A sonda P1 da própria migration (oráculo de
             regressão) já provava que a lacuna era NO-OP nos dados de hoje — nenhum subgrupo
             real referencia um tipo `group`-only —, confirmando que o achado era latente, não
             um bug ativo.
  Correção:  Adicionar `AND sg_tg.applies_to IN ('subgroup', 'both')` ao JOIN do subgrupo e
             `AND g_tg.applies_to IN ('group', 'both')` ao do grupo.
  Regra:     CLAUDE.md — "Padrão de execução e robustez técnica" (validar contratos; o próprio
             pedido do usuário foi "versão dinâmica **com robustez de código**"); o padrão de
             defesa em profundidade já usado dezenas de vezes neste projeto (REVOKE explícito
             mesmo com RLS, `canSeeConta` mesmo com `service_role`, etc.).

- [apps/frontend-vite/src/services/supabase.ts:1412] O comentário de
  `ExpenseDrillTarget.typeGroupId` ainda dizia "(5/6/7)" depois de o 4º donut (tipo 9) ter sido
  acrescentado no mesmo diff.
  Falha:     Sem risco funcional (o campo é `number`, sem validação de domínio), mas um
             mantenedor lendo só o comentário concluiria que `typeGroupId=9` é um valor inválido
             para esse alvo de drill — o oposto do que o código faz duas linhas abaixo na página
             que passa exatamente esse valor.
  Evidência: `apps/frontend-vite/src/pages/DashboardFinanceiro.tsx:210` passa
             `typeGroupId={TYPE_GROUP_ID_CUSTO_IMPORTACAO}` (=9) para o mesmo tipo
             `ExpenseDrillTarget` cujo comentário enumerava só 5/6/7.
  Correção:  Atualizar o comentário para "(5/6/7/9)".
  Regra:     Mesma classe de achado que a correção já aplicada em
             `apps/api-backend/lib/ai-chat/tools.ts` (descrição da tool) neste mesmo diff — a
             lição não foi replicada para este comentário-irmão no mesmo arquivo.

### 🔵 Opcionais
Nenhum.

## Pendências (trabalho incompleto)
Nenhuma — os itens do escopo combinado (backend dinâmico + fix do dashboard + aviso do chat)
foram todos entregues; nada ficou marcado como TODO/stub.

## Drift código × documentação

- `docs/knowledge/dashboards.md:88-133` (seção `/dashboard_despesas` → "Donuts — layout" e
  "Donuts — conteúdo") descreve **"4 donuts"**, **"os três últimos"** e a partição por
  `type_group_id` **7/5/6** — o código agora tem 5 donuts (`Custos de Importação` entre
  Mercadorias e Fixas) recortados por 7/9/5/6. Linhas específicas divergentes: 88, 90, 92, 99,
  108, 110-113, 120-122. Decisão pendente do usuário: atualizar o doc (fora desta correção, por
  regra da fase) ou registrar por que ficou intencionalmente desatualizado.

## Não coberto
- `ruff`/`vulture` (Python) não executados neste review — a suíte Python deste diff é só
  `tests/test_roadmap_gatilhos.py`, já coberta pelo review `max-onda10` anterior; o lint Python
  deste repo é best-effort (SonarCloud cobre no PR, por convenção do projeto).
- `get_advisors` (Supabase, achados de segurança) não executado — o MCP do Supabase está
  desconectado nesta sessão; a migration 128 só adiciona colunas/constraints numa tabela
  existente e reescreve uma função já auditada (grants confirmados por medição nas sondas
  P6/P7), então o risco de achado novo é baixo, mas não foi verificado por essa ferramenta.
- Nenhum arquivo do delta foi lido só parcialmente — os arquivos grandes (`CLAUDE.md`, migrations
  127/128) foram lidos por inteiro via o diff completo.
- A prova do achado do `applies_to` foi feita contra o CATÁLOGO (linhas de
  `financial_type_group`), não inserindo um subgrupo real com escopo cruzado — decisão
  deliberada para não mexer em dado de cadastro de produção; a sonda equivalente prova a
  condição do JOIN de forma suficiente.

---

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| R1 | JOINs de `demonstrativo_despesas` sem guarda de `applies_to` | ✅ corrigido | `supabase/migrations/128_demonstrativo_despesas_dinamico.sql`: `AND sg_tg.applies_to IN ('subgroup','both')` / `AND g_tg.applies_to IN ('group','both')` nos dois `LEFT JOIN`; nova sonda P7 no `DO $$` prova a guarda contra o catálogo (id 4 não casa via subgrupo, id 7 não casa via grupo); migration reaplicada via `psql` (idempotente — `ALTER`/`INDEX` puleram com `NOTICE`, `UPDATE`/`CREATE FUNCTION` reexecutaram); saída conferida byte-a-byte idêntica à anterior no mesmo período (196 contas, R$ 5.097.447,64) |
| R2 | Comentário desatualizado em `ExpenseDrillTarget.typeGroupId` ("5/6/7") | ✅ corrigido | `apps/frontend-vite/src/services/supabase.ts:1412` → "(5/6/7/9)" |

Gates após a correção: pytest 1428/1428 (inalterado — diff não toca Python) · `frontend-vite`
typecheck OK · lint OK · test **876/876** (inalterado)
Baseline (Passo 3):    pytest 1428/1428 · `packages/shared` 53/53 · `api-backend` 613/613 ·
`frontend-vite` **876/876**
Re-review do diff da correção: sem achado novo — a guarda SQL é aditiva (só restringe casos hoje
inexistentes, provado pelo oráculo de regressão P1 continuando em zero divergências) e o
comentário é texto puro, sem superfície de erro.

Não corrigido por decisão da fase: o drift em `docs/knowledge/dashboards.md` (regra 1 de
`correcao.md` — sincronizar doc apagaria a evidência da divergência; decisão de qual lado está
certo é do usuário, embora aqui seja inequívoco que o código está certo e o doc ficou para trás).
Nada foi commitado.
