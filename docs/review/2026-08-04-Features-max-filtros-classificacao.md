# Code Review — Features (2026-08-04) · filtros dedicados de classificação contábil

> Arquivo com discriminador no nome: já existia `2026-08-04-Features-max.md` (review anterior
> do mesmo dia, sobre outro delta). Sobrescrevê-lo apagaria a evidência daquele.

## Resumo

Alvo: nenhum (review do diff completo)
Modo: **max** (passo de ataque + verificação adversarial)
Delta: 8 arquivos alterados, 2 novos, **+634/−36** linhas versionadas + **216** linhas novas
Régua: `CLAUDE.md` (raiz) + `.claude/rules/` do workspace Sheild
Gates: vitest frontend-vite **783/783** (142 arq., `--maxWorkers=1`) · lint **0 erros/0 warnings**
(4 workspaces) · typecheck **OK** (4 workspaces) · ts-prune **0** · e2e Playwright **não executado**
(exige navegador — proibido no sandbox pelo `CLAUDE.md`) · pytest **não executado** (o delta não
toca Python) · baseline pré-mudança **não estabelecido** (exigiria worktree separado; o delta é
aditivo e a suíte está verde)
Verificação adversarial: **3 contestações; 1 confirmado, 2 enfraquecidos, 0 refutados**

O delta entrega a **2ª linha de filtros de `/consulta`** (plano de contas por descrição, sub grupo,
grupo, centro de custo) e é de qualidade acima da média do repositório: o risco central — filtro em
recurso embutido do PostgREST que, sem `!inner`, **não descarta nada respondendo HTTP 200** — foi
identificado, medido contra o banco real e travado por uma bateria de testes, incluindo guarda
cross-layer contra o `SELECT_WITH_EMBEDS` real e sanidade de parser. **Nenhum bloqueante.** O passo
de ataque não encontrou defeito vivo: reproduzi as medições do autor no banco (join loss-free
709→709, 0 órfãos, policy do plano `USING (true)`, 0 pares centro×plano inconsistentes) e todas
sustentam as afirmações do código. O único achado que sobreviveu à contestação é uma lacuna de
**cobertura de teste** no call site do filtro de plano — exatamente a classe de defeito que o
próprio `CLAUDE.md` §2 item 5 documenta.

## Achados

### 🔴 Bloqueantes

Nenhum.

### 🟡 Recomendados

- [apps/frontend-vite/src/pages/Consulta.tsx:1042-1048] O wiring do filtro **"Plano de contas"** é
  o único dos 4 controles novos sem teste de call site — testa-se a função pura, não a ligação.
  **Falha:** um refactor que quebre `onChange={(d) => sf('chartAccountDescription', d ?? '')}` (ou
  renomeie a chave só em `Consulta.tsx`) faz o usuário escolher um plano e o grid **não filtrar**,
  exibindo a base inteira como se estivesse filtrada — sem teste vermelho e sem erro de tipo.
  **Evidência:** mutante aplicado por mim (`onChange={() => undefined}`), isolado e em série:
  `Consulta.test.tsx` + `Consulta.a11y.test.tsx` + `supabase.test.ts` + `ChartAccountSelect.test.tsx`
  → **87/87 passed** (mutante revertido e conferido com `diff -q`). A contestação adversarial não
  conseguiu refutar em nenhum dos 3 ângulos e ainda mediu um 2º mutante, pior: renomear
  `chartAccountDescription`→`chartAccountDesc` apenas em `Consulta.tsx` sai com **`tsc --noEmit`
  exit 0**, porque `getFinancialAccountControl({...applied})` é *spread* (sem excess-property check)
  e o campo é `?opcional` do outro lado. Os outros 3 filtros têm esse teste
  (`Consulta.test.tsx:553-641`); o plano não aparece em nenhum `*.test.tsx` de página.
  **Correção:** um caso em `Consulta.test.tsx` espelhando o de grupo — mockar
  `../components/molecules/ChartAccountSelect` (padrão já usado em `ContaForm.test.tsx`), disparar
  `onChange('Serviços Gerais')` e assertar `expect.objectContaining({ chartAccountDescription:
  'Serviços Gerais' })` em `getFinancialAccountControl`.
  **Regra:** `CLAUDE.md` §Regras mandatórias 2, item 5 — "Testar a função PURA não cobre o CALL SITE".
  **Veredito:** CONFIRMADO `[verificado]`

### 🔵 Opcionais

- [apps/frontend-vite/src/components/molecules/ChartAccountSelect.tsx:88-95]
  `[verificado, rebaixado]` — falha transitória do lookup na **1ª abertura** do menu (`variant="filter"`)
  é memoizada como "lista carregada e vazia"; reabrir o menu não retenta. Medido por sonda: 2ª
  abertura = **1 chamada, 0 opções**. **Rebaixado de 🟡 porque a contestação mediu duas recuperações
  reais:** digitar refaz a busca (1→4 chamadas, opção renderizada, `loadError` limpo) — e digitar é a
  interação primária de um campo de busca com ~530 descrições; e `filterDefaults` é `useState`
  (estado de componente), não cache de módulo, então trocar de rota já refaz a carga. O paralelo que
  eu havia traçado com `useClassificationFilterOptions` ("filtro morto até o reload da aba") **não se
  sustenta** — lá o cache é de módulo, aqui não. Correção, se quiser: gravar `filterDefaults` só no
  ramo de sucesso.
- [apps/frontend-vite/src/pages/Consulta.a11y.test.tsx:26-28,51-55] `[verificado, rebaixado]` — o
  comentário afirma que o axe avalia os `<select>` **populados**, mas a espera observa a chamada do
  serviço de dados, não a resolução dos lookups. **Rebaixado de 🟡 porque a contestação provou por
  medição que a diferença é imaterial no markup atual:** a assinatura completa do `axe.run`
  (violations/passes/incomplete por regra) sobre o container real é **byte-a-byte idêntica** com
  selects populados e vazios — os `<option>` sem `id`/`aria-*` não entram em check nenhum; e a
  invariante "as opções existem" já é observada com asserção retentante em
  `Consulta.test.tsx:557` (`findByRole('option', …)`). Vira **drift de comentário**, não buraco de
  cobertura. ⚠️ Volta a valer se algum dia esses `<option>` receberem `id`/`aria-*`.
- [apps/frontend-vite/src/services/supabase.ts:472-477] `withChartAccountJoin('')` devolve **só o
  embed**, produzindo um `select` que descarta todas as colunas de topo (linhas viriam vazias, sem
  erro). Hoje é inalcançável — os 3 chamadores setam `select` antes —, e o contrato está escrito em
  comentário. Endurecimento barato: `select ? … : '*,' + CHART_EMBED_MINIMAL`.
- [apps/frontend-vite/src/pages/Consulta.tsx:1042] O `ChartAccountSelect` do filtro é o **único
  controle da barra sem `name`** (tem `id` + `aria-label`); os 10 vizinhos nativos têm os três. É a
  regra de autofill do `CLAUDE.md` §Regra 6. O componente não expõe prop `name` — daí ser opcional.

## Pendências (trabalho incompleto)

Nenhuma. Varredura de marcadores (`TODO|FIXME|HACK|XXX|WIP|@todo|@pendente`) sobre o diff versionado
**e** os 2 arquivos untracked: 1 ocorrência, **falso positivo** em pt-BR (`"quebraria TODO filtro de
plano"` = "todo o filtro"). Nenhum `it.skip`/`xit`/`.only`/`console.log`/stub no delta.

## Drift código × documentação

Nenhum. O `CLAUDE.md` foi atualizado no **mesmo diff** e confere com o código em todos os pontos que
verifiquei: hook com `allSettled` + cache de módulo + plano fora dele; `!inner` obrigatório; `eq.`
cru; join loss-free; sentinela não filtrável; contagem de testes (`frontend-vite 783` — medi 783).
Duas notas factuais, **não drift**: (a) os números "706 contas → 706" envelheceram para **709 → 709**
(a base cresce; a propriedade se mantém — remedi hoje); (b) a doc diz que o `eq.` cru está "travado
por teste + mutante" — o teste existe e eu confirmei; o mutante daquela afirmação não foi
reexecutado por mim.

## Não coberto

- **`Consulta.tsx` não foi lido por inteiro** (~1.100 linhas): li o diff completo mais os blocos
  `ConsultaFilters`/`BASE_FILTERS`/`initialFilters`/`load`/`handleSearch`/`handleClear`/
  `handleCardFilter` e a barra de filtros. Trechos fora do caminho dos filtros não foram revisados.
- **Camada a11y em navegador (Playwright + axe) não executada** — o `CLAUDE.md` proíbe rodá-la no
  sandbox do agente (o renderer do Chromium crasha). É justamente a camada que enxerga contraste sob
  render efetivo e ordem de foco, e a 2ª linha de filtros é UI nova. **Rodar no CI/na sua máquina**
  (`npm run test:e2e`) antes de mesclar.
- **`pytest` e as suítes de `api-backend`/`portal-next` não executadas** — o delta não toca esses
  workspaces; lint e typecheck rodaram nos quatro.
- **Semântica do PostgREST verificada indiretamente**: confirmei no banco a policy, o join loss-free,
  a ausência de órfãos e a consistência do par centro×plano, além da inexistência de divergência
  entre a FK direta de grupo e o caminho via subgrupo (0/611). **Não** reemiti as requisições HTTP
  reais com um JWT de usuário — as medições de `706 × 198` e de `eq."…"` são do autor.
- **Achados 🔵 opcionais não passam por contestação adversarial** (regra da extensão ⟨B⟩: são
  preferência, não afirmação de defeito). Os dois rebaixados (`[verificado, rebaixado]`) **foram**
  contestados enquanto 🟡. Nenhum achado ficou fora do teto de 12 contestações.

---

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| R1 | Wiring do filtro de PLANO sem teste de call site | ✅ corrigido | `Consulta.test.tsx:551-572` — caso novo que dirige o **componente real** (abre o menu, escolhe "Serviços Gerais", clica em Buscar) e assere `chartAccountDescription` chegando a `getFinancialAccountControl`. Validado por **2 mutantes**, ambos revertidos e conferidos com `diff -q`: (A) `onChange={() => undefined}` → **1 failed \| 29 passed**, só o caso novo; (B) rename `chartAccountDescription`→`chartAccountDesc` só em `Consulta.tsx` → **`tsc --noEmit` exit 0** (confirma que o tipo não pega) e **1 failed \| 29 passed** |
| O1 | Falha transitória memoizada no `ChartAccountSelect` filtro | ⏸️ adiado | Veredito **ENFRAQUECIDO** na contestação → por contrato da skill não entra na correção automática. Correção existe e é de uma linha (gravar `filterDefaults` só no ramo de sucesso), mas a premissa foi abalada: digitar recupera, e o estado é local ao mount |
| O2 | Comentário do teste a11y promete o que a espera não observa | ⏸️ adiado | Veredito **ENFRAQUECIDO** → medido byte-a-byte que o axe avalia o mesmo com selects vazios e populados. Vira escolha sua: corrigir o comentário (1 linha) ou travar a garantia com `findByRole('option', …)` |

Gates após a correção: **vitest 784 (+1)** · lint **0/0** · typecheck **OK** · ts-prune **0**
Baseline (Passo 3):    vitest **783** · lint **0/0** · typecheck **OK** · ts-prune **0**
Re-review do diff da correção: **sem achado novo** (+22 linhas, um único arquivo de teste; nenhuma
mudança de assinatura, de contrato ou de comportamento de produção)

Não corrigido por decisão sua: os 2 achados enfraquecidos acima, mais os 2 opcionais restantes
(`withChartAccountJoin('')` devolvendo select sem colunas de topo; `name` ausente no
`ChartAccountSelect` do filtro) e a camada e2e do Playwright, que precisa rodar fora do sandbox.
**Nada foi commitado.**

---

## Adendo — varredura de pendências/achados/drift não resolvidos (2026-08-04, a pedido)

Varredura das três fontes (relatórios anteriores · marcadores no código · itens que o
`CLAUDE.md` declara em aberto), **verificando cada item** em vez de copiar dos relatórios.

### 🔴 Resolvidos nesta rodada

| # | Item | Como |
|---|---|---|
| H1 | **`UnboundLocalError: pdf_links`** — regressão viva em `main` e em produção: todo e-mail **com anexo** terminava em `falha`. Veio do 4º deploy de hoje (`dd03f2c`) | `pdf_links: list[str] = []` antes do `if not saved_pdfs:` (`read_emails.py:5533`) + `ProcessMessageCaminhoComAnexoTest` (3 casos que **executam** `process_message`) + manifesto regravado. **Mutante:** removida a inicialização → 2 casos VERMELHOS |
| H2 | **Receita destrutiva no `CLAUDE.md`** — o UPDATE de re-varredura de `created_by` reatribuiria **122 contas criadas à mão** (121 barbara, 1 ricardo) ao sentinela | Guard `AND sender_email IS NOT NULL` + explicação da direção da divergência + query de conferência prévia |
| D1 | Contagem de testes defasada | `CLAUDE.md` → **786** / **1.311** Node e **1.096** pytest, medidos |
| D2 | `RELATORIO-SEGURANCA.md` marcava **S5-1 (sandbox no iframe)** como aplicado; foi revertido | Adendo com o estado real, o motivo (PDFium não renderiza em iframe sandboxed) e o risco residual aceito |
| A1 | `ChartAccountSelect` filtro fossilizava falha transitória | `if (opts.length > 0) setFilterDefaults(opts)` + teste; **mutante** valida |
| A2 | Teste a11y prometia selects populados sem observar | `findByRole('option', …)` antes do `axe` |
| A3 | `withChartAccountJoin('')` devolvia select sem colunas de topo | cai em `*,<embed>` + teste |
| P1 | Único `TODO` real do repo: `WHATSAPP_NUMBER = ''` gerava `href="https://wa.me/"` (link quebrado) | círculo do WhatsApp só entra na fileira quando há número |

### ❌ Tentado e revertido (medido)

- **`name` no `ChartAccountSelect`** (regra 6 do `CLAUDE.md`, autofill). Medido: o `name` do
  react-select renderiza um **input oculto** (`hidden|name=cca`); o input **visível** continua
  `text|id=cca|name=-`. Ou seja, **não resolve** o aviso do Chrome, que é sobre o campo visível.
  Enviar a prop com um comentário afirmando que resolve seria criar drift novo. O achado
  **continua aberto** e sem solução limpa sem alterar o react-select.

### ⏸️ Continuam abertos (com o motivo)

| Item | Medição | Por que não agora |
|---|---|---|
| **Corrigir o `status` dos 13 e-mails** de hoje (`falha` → `extraído`) | 11 dos 13 já têm conta (ids 853-864) | **escrita em produção — decisão sua.** ⚠️ Fazer **antes** de rodar `reprocess_body_emails.py`/`reprocess_link_emails.py`, que varrem `status='falha'` |
| **Deploy do hotfix** | — | só o usuário acessa a máquina de produção |
| `audit_log` com **0 linhas** | confirmado no banco | é a Onda 7 (feature: decidir o que auditar + triggers/migration), não um fix |
| `extract_and_store_accounts` **F (61)** · `main()` de `backfill_fiscal_documents` e `purge_orphan_attachments` **D (23)** cada | `radon` | o `CLAUDE.md` prescreve tratar S3776 **função a função, com A/B sobre dado real** — nunca em sweep de review |
| Cabeçalho do painel de `/consulta` mostra só o fantasia | — | informação não se perde (o campo abaixo traz os dois); concatenar alongaria o cabeçalho — decisão de UI |
| Ondas 5-9 · RBAC · handlers SIEG e Lmed · `payment_type_id` cru · TanStack Query em `/consulta`/`/emails` | — | trabalho novo, não correção |
| e2e Playwright | não executado | exige navegador; roda no CI/na sua máquina |

### ✅ Já estavam resolvidos (verifiquei, não assumi)

68 linhas sem proveniência → **0** · Onda 4 executada · `fmtSupplierName` nas superfícies
adjacentes e `fmtSupplier` sem o literal `'—'` → aplicados · manifesto **27/27** no lado dev ·
`KNOWN_VIOLATIONS` de contraste **vazio** · contas vencidas não marcadas → **0** · todos os itens
do relatório de segurança aplicados (salvo o S5-1 acima).

**Gates finais:** vitest frontend **786** · api-backend **523** · portal-next **2** · pytest
**1.096** · lint **0/0** · typecheck **OK** · ts-prune **0** · manifesto **27/27**.
Diff sem churn de EOL (idêntico com `--ignore-cr-at-eol`). **Nada foi commitado.**

### Correção de DADOS aplicada (2026-08-04, a pedido) — status dos 13 e-mails

Escrita na Supabase (compartilhada dev+prod). **Não foi um `UPDATE ... = 'extraído'` em bloco:**
o status correto foi determinado por evidência, um a um.

- **11 com conta gravada → `extraído`.** `accounts_saved > 0` é o ramo de maior prioridade de
  `status_for_result`; inequívoco.
- **2 sem conta (1275 trevos, 1283 RTE) → `duplicidade`, não `extraído`.** Baixei os dois PDFs do
  bucket e extraí a linha digitável com a função canônica do projeto
  (`febraban.extract_linha_digitavel`): os barcodes batem **exatamente** com contas já existentes
  — `3419815300000067800…` = conta **829** (trevos, fechamento de 03/08 reenviado como `Fwd:`) e
  `3419415410000220678…` = conta **860** (a mesma fatura RTE do e-mail 1282). São dedup pela
  impressão 1, e marcá-los `extraído` violaria o invariante reafirmado hoje ("`extraído` significa
  gerou conta").

**Guardas do UPDATE** (idempotente e incapaz de tocar linha fora do estado quebrado): lista
explícita de 13 ids **E** `status = 'falha'` **E** `notes LIKE 'Erro: cannot access local
variable ''pdf_links''%'`. O `notes` foi substituído por uma nota de rastreabilidade em vez de
`NULL` — apagar não deixaria registro do que aconteceu.

**Linhas de erro:** 13 removidas de `email_processing_errors` (ids 278-290, filtradas também por
`error_type` e por conter `pdf_links`). É o padrão já usado pelo `reprocess_message.py`, que
remove o erro antigo ao resolver.

| Verificação | Antes | Depois |
|---|---|---|
| `email_control.status = 'falha'` | 21 | **8** (só os legítimos já documentados) |
| …destes, de 2026-08-04 | 13 | **0** |
| `email_processing_errors` | 35 | **22** |
| …com `pdf_links` | 13 | **0** |
| `'extraído'` **sem** conta (invariante) | — | **0** |
| Contas (`financial_account_control`) | — | **inalteradas** — nenhuma criada ou removida |

⚠️ **A correção de dados NÃO substitui o deploy.** A máquina de produção ainda roda o
`read_emails.py` com o defeito: **todo e-mail com anexo que chegar até a cópia do hotfix volta a
cair em `falha`**. Os reprocessadores (`reprocess_body_emails.py`/`reprocess_link_emails.py`)
agora estão seguros para os 13 — eles varrem `status='falha'` e nenhum deles está mais nesse
estado.
