# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Onde está cada coisa

Este arquivo é carregado **automaticamente** em toda sessão; os `docs/` **não**. Por isso a divisão
(enxugamento de 2026-08-04, de 6.976 para ~3.990 linhas): aqui ficam as **regras e os invariantes**
— o que não pode quebrar —, e em `docs/` fica o **porquê**: catálogos, casos reais, medições e
histórico.

| Precisa de… | Vá para |
|---|---|
| Regras mandatórias, invariantes 🔴, arquitetura, banco, comandos | **este arquivo** |
| Detalhe das regras de extração (tipos de documento, fornecedor, corpo, dedup, filtros) | [docs/knowledge/pipeline-extracao.md](docs/knowledge/pipeline-extracao.md) |
| Catálogo dos CRUDs da Next API, auth, papéis, anexos | [docs/knowledge/api-crud.md](docs/knowledge/api-crud.md) |
| Detalhe dos dois dashboards (escopo, donuts, ranking, layout, drill-down) | [docs/knowledge/dashboards.md](docs/knowledge/dashboards.md) |
| O que cada deploy fez e a lição de cada um | [docs/deploy/historico-deploys.md](docs/deploy/historico-deploys.md) |
| Deploy para produção · scripts de manutenção (reprocessar, backfill, purga) | skills **`deploy-producao`** e **`scripts-manutencao`** (`.claude/skills/`) |
| Gate de qualidade por stack | [docs/padrao-execucao.md](docs/padrao-execucao.md) |
| Chat de IA · roadmap de dados · RBAC desenhado | [docs/arquitetura-chat-ia-pagamentos.md](docs/arquitetura-chat-ia-pagamentos.md) · [docs/roadmap-enriquecimento-dados.md](docs/roadmap-enriquecimento-dados.md) · [docs/design/permissoes-por-grupo.md](docs/design/permissoes-por-grupo.md) |

**Ao mexer no pipeline ou na Next API, leia os dois** — este diz *o que* não pode quebrar, o
`docs/knowledge/` diz *por que* e *como se descobriu*. `tests/test_doc_links.py` garante que nenhum
ponteiro daqui aponte para arquivo inexistente e que nenhum extraído fique órfão.

## O que é este projeto

`pagamentos` é um **pipeline financeiro de contas a pagar**, não um app CRUD comum.
O fluxo central (entrada) é: e-mail (IMAP) → download de PDF → extração via Claude API →
gravação no Supabase → consulta/exportação pela interface web.

Há também um **segundo pipeline (saída): cobrança de títulos vencidos** — lê o Firebird e
**envia e-mails de cobrança por SMTP (Locaweb)**, com logs próprios. Ver "Pipeline de cobrança
de vencidos (skill `cobranca-vencidos`)".

E um **terceiro pipeline (infra): backup diário do Supabase** (skill `backup-supabase`) —
`pg_dump` do banco + download do bucket `attachments`, agendado às 02:00. Ver "Pipeline de
backup do Supabase (skill `backup-supabase`)".

E um **quarto pipeline (reconciliação): baixa automática de contas pagas + marcação de
vencidos** (skill `baixa-automatica`) — marca como `pago` as contas com NF + Boleto
confirmados e vencimento vencido, **e** marca como `vencido` as contas pendente/a vencer
com vencimento anterior a hoje; duas regras independentes, agendadas às 08:00. Ver
"Pipeline de baixa automática (skill `baixa-automatica`)".

> **Arquitetura: monorepo Sheild com backend híbrido.** Desde a reestruturação de
> 2026-06-09, o projeto adota o monorepo `apps/* + packages/shared` (npm workspaces),
> mas o backend é **híbrido** — pontos onde ainda diverge do padrão genérico:
> - **Pipeline Python permanece** (`server/` Flask + `skills/`): IMAP, extração de PDF
>   (Claude Vision via base64 + pdfplumber). Não há equivalente TS viável; é o coração
>   do sistema e não foi reescrito.
> - **`apps/api-backend`** (Next.js 16 + TypeScript, porta 3000) é a camada nova de
>   dados/CRUD. Aciona o pipeline Python via **ponte HTTP** (`lib/python-bridge.ts` →
>   Flask), não por subprocess.
> - **`apps/frontend-vite`** (React 19 + Vite 8, porta 5173) é o app interno, agora
>   **100% TypeScript** (`.tsx/.ts`), **sem shadcn/ui**. Continua lendo o Supabase via
>   **REST direto com `fetch`** (`src/services/supabase.ts`); só a sessão de auth usa o
>   SDK oficial (`src/lib/supabaseClient.ts`).
> - **`apps/portal-next`** (Next.js 16 + Tailwind v4, porta 3002) é o portal público
>   (scaffold).
> - **`packages/shared`** (`@sheild/shared`) — schemas Zod, fonte de verdade de tipos
>   entre frontends e API.
>
> **Stack atualizado (upgrade do stack — 5 fases + React Compiler transform, 2026-06-18):** Vite **8** (Rolldown) · Vitest **4** ·
> React **19** (unificado em todo o monorepo) · TypeScript **6** · ESLint **10** no
> frontend-vite (apps Next em ESLint **9** — carve-out, ver `eslint10-next-carveout` na
> memória) · **React Compiler** ativo — regras (`eslint-plugin-react-hooks@7`) **e transform
> de build** (`@rolldown/plugin-babel` + `reactCompilerPreset`) · Tailwind
> **v4 CSS-first** (`@theme`/`@utility` em `src/index.css`; **não há mais `tailwind.config.ts`**) ·
> Zod **4** (+ `@hookform/resolvers@5`, `react-hook-form@7.79`) · `tailwind-merge@3` ·
> `lucide-react@1`.
>
> Não aplique os templates Sheild Canvas nem shadcn aqui. O **fluxo de autenticação em
> 3 etapas** e a **regra de não-autorregistro** (`auth-specs.md`) foram seguidos,
> adaptados para `.tsx` com Tailwind. Mantenha o estilo existente do restante do projeto.
>
> **Desvio justificado:** migrations ficam em `supabase/migrations/` (não
> `server/db/migrations/`) — preserva a convenção numérica 001+ e o fluxo manual de
> aplicação no SQL Editor.

---

## Regras mandatórias

Estas regras se aplicam a **todo** código novo ou alterado neste projeto, sem exceção.

### 1 — Atomic Design + Tailwind (frontend)

- Todo componente de UI pertence a uma camada: `atoms/`, `molecules/` ou `organisms/`.
  - **Atom**: elemento sem filhos de domínio (input, botão, badge, texto expansível).
  - **Molecule**: composição de atoms (fileira de logos, mensagem inline, header de auth).
  - **Organism**: componente com estado e lógica de negócio (formulário completo, tabela paginada).
- Estilo **exclusivamente via classes Tailwind** — `style={{}}` inline é proibido quando
  existir token ou classe equivalente no Tailwind.
- **Tokens de cor**: usar `loginGreen-*` nas telas de auth e `status-*`
  (feedback, badges e banners — ver guia abaixo) no restante do app. Nunca use hex
  hardcoded **nem cores default do Tailwind** (`red-*`, `amber-*`, `emerald-*`, `blue-*`,
  `teal-*`…) para estados semânticos — o token semântico é a fonte de verdade única
  (paleta no bloco `@theme` de `src/index.css` — Tailwind v4 CSS-first).
- **Tokens de tamanho**: usar os tokens Tailwind mais próximos em vez de valores
  arbitrários (ex.: `text-sm` em vez de `text-[15px]`). Valores sem token equivalente
  (ex.: `object-[center_25%]`) são aceitos como exceção justificada.
- **Tailwind JIT**: usar strings estáticas completas em ternários —
  `${focused ? 'bg-loginGreen-fieldFocus' : 'bg-loginGreen-field'}` é correto.
  Nunca concatenar partes de nome de classe (`bg-loginGreen-${variavel}`) — o JIT
  não gera CSS para nomes computados.
- Preferir modificadores `hover:`, `disabled:`, `placeholder:`, `focus:` a handlers JS.
- **CVA para variantes**: componente com variação visual (variante, estado booleano)
  centraliza as classes em `cva()` (`class-variance-authority`) e aplica com o helper
  `cn()` (`src/lib/cn.ts` — `clsx` + `tailwind-merge`): `cn(badgeVariants({ variant }), className)`.
  Cada valor de variante continua sendo uma **string literal completa** (compatível com o
  JIT). Componentes-referência: `StatusBadge` (mapa em `statusBadge.variants.ts`),
  `Alert` (banner de página — error/success/warning/info), `InlineMessage`, `AuthInput`,
  `FilledTextField`, `AccentPillButton`, `GradientPillButton`, `DataGrid` (tema
  `default`/`silver` + estados de linha/cabeçalho em `dataGrid.variants.ts`) e `KpiCard`
  (`tone` × `active` em `kpiCard.variants.ts` — ver "Destaque dos cards de KPI").
  Mantenha as definições `cva` que não são componentes em arquivo separado (`*.variants.ts`)
  para não disparar `react-refresh/only-export-components`. A exceção aceita é um `cva`
  **local e não exportado** dentro do próprio componente (ex.: `navLink` em `Layout.tsx`),
  que não dispara a regra de Fast Refresh.

### 2 — Todo componente tem teste

- **Todo componente novo ou alterado de forma relevante deve ter ao menos um teste**
  cobrindo renderização e a interação principal (ex.: submit, expand/collapse, validação).
- 🔴 **Teste que promete uma garantia tem de entregá-la** *(lição O9–O11 da Onda 2 — três testes
  verdes que não travavam o que o nome dizia)*. Se o nome ou o comentário afirma "**ANTES** de",
  "**alinhado com** X" ou "**cabe no limite** de Y", a asserção precisa **observar aquilo** — não
  um número mágico, não uma chamada isolada, não uma contagem do próprio array. Casos reais:
  `test_grava_o_corpo_ANTES_…` só via que a função fora chamada; a bateria de regressão dizia estar
  "alinhada com o painel" contando o array local; e o teto do corpo era checado contra `200_000` em
  vez de contra o teto do SQL. **As três ferramentas:**
  1. **Guarda cross-layer** — ler o outro arquivo e comparar, em vez de afirmar coerência. Exemplos
     no projeto: `log.test.ts` × migrations · `regression.test.ts` × `AiChatPanel.tsx` ·
     `test_body_full.py` × migration do `body_search` · `test_doc_type_domain_consistency.py`.
  2. **Sanidade do parser** em toda guarda que faz parsing — um regex que para de casar transforma
     o teste em `0 === 0`, verde para sempre.
  3. **Validação por mutante** — introduzir o defeito de propósito e conferir que o teste fica
     VERMELHO. Teste que não falha quando o defeito existe não é teste, é decoração.
  4. **Guarda que procura a AUSÊNCIA de algo precisa ler CÓDIGO, não prosa** *(lição de
     2026-08-03)*. Os scripts explicam em comentário justamente o que não devem fazer ("nunca
     escreve em PDF_INBOX"), então a guarda casaria a própria advertência. O helper é
     `_sem_prosa` (`tests/test_fiscal_document_consistency.py`), e ele usa **`ast` + `tokenize`**,
     não regex: `re.sub(r"#[^\n]*", "")` corta a partir de um `#` **dentro de string**
     (`"select # from financial_account_control"` perde o identificador → **falso negativo**, o
     pior desfecho possível numa guarda), e `re.sub(r'"""…"""')` engole o código entre duas
     strings triplas não relacionadas. `tokenize` sabe o que é comentário; `ast` sabe o que é
     docstring.
  5. **Testar a função PURA não cobre o CALL SITE** *(lição de 2026-08-04, code review max)*. Ao
     trocar o render da coluna "Fornecedor" por `fmtSupplierName`, o helper ganhou 8 testes
     unitários — e o **wiring** ficou sem nenhum: as fixtures da coluna usavam `legal_name` nulo ou
     igual ao fantasia, casos em que o código novo e o antigo produzem o MESMO texto. Medido: o
     mutante `fmtSupplierName(r.supplier).split(' · ')[0]`, que restaura o comportamento antigo
     **mantendo o import usado**, passava **748/748 testes e typecheck limpo**. ⚠️ O mutante
     INGÊNUO (voltar ao `trade_name ?? '—'`) é pego — mas pelo `tsc`, com `TS6133: import órfão`;
     isso detecta "o símbolo ficou sem uso", **não** "a célula perdeu a razão social". Ao escolher
     o mutante, prefira o que **preserva as referências** e muda só o comportamento; senão o gate
     que acusa é outro e a conclusão sai errada. Travado em `useGridColumns.test.ts` (fixture
     `PEGAMIL` × `ITW PPF BRASIL ADESIVOS LTDA`).
  6. 🔴 **Guarda de wiring por TEXTO não cobre o call site EXECUTADO** *(lição de 2026-08-04 —
     o item 5 mordendo o próprio remédio)*. A resposta natural ao item 5 é escrever uma guarda que
     lê o código com `inspect.getsource`/`ast` e confere que a função aparece no call site. Foi o
     que `WiringDasGuardasTest` (`tests/test_email_sem_pagavel.py`) faz — e ela ficou **VERDE com
     o pipeline quebrado**: `email_sem_conteudo_extraivel(has_att, pdf_links, body_text)` estava
     lá, no argumento certo, mas `pdf_links` só era atribuído dentro de `if not saved_pdfs:`, então
     **todo e-mail com anexo** (o caminho principal!) levantava `UnboundLocalError`. Medido: **13
     e-mails num dia**, todos com a conta já gravada, virando `falha` com linha em `/erros`.
     **A guarda textual prova que a chamada EXISTE; só a execução prova que ela FUNCIONA** — ela
     não vê escopo, ordem de atribuição, exceção nem tipo. Use-a para o que ela serve (impedir que
     alguém REMOVA a ligação) e **acrescente um caso que execute a função de topo** ao menos uma
     vez por caminho estrutural — aqui, `ProcessMessageCaminhoComAnexoTest`, que roda
     `process_message` com e sem anexo, sem rede (`save_attachments`/`extract_and_store_accounts`
     mockados). Sintoma a reconhecer: **guarda de wiring passando enquanto a produção quebra**.
  Vale mais para defeito de **verificação** que para defeito de código: teste verde é justamente o
  que faz parar de olhar. A pergunta que encontra os três: *"o que aconteceria se eu quebrasse isto
  de propósito?"* — se a resposta for "nada falharia", o teste está incompleto.
  > ⚠️ **Mutante e concorrência não se misturam** *(erro cometido no review de 2026-08-04)*. Dois
  > processos paralelos sobre o MESMO arquivo — um aplicando mutante, outro lendo — fazem o leitor
  > observar um estado transitório e concluir o oposto do que o repositório contém (aconteceu: um
  > verificador reportou que a coluna não usava o helper, com o arquivo íntegro e o lint em exit 0).
  > Validação por mutante roda **isolada**: em série, ou sobre cópia do arquivo.
- **Suíte configurada (Vitest):** `apps/frontend-vite` (jsdom + Testing Library),
  `apps/api-backend` (env node) e **`packages/shared`** (env node, desde o PR #224). Rode
  `npm test` na raiz (roda todos os workspaces) ou `npm run test --workspace=<ws>`. No
  `api-backend`, o `vitest.config.ts` resolve o alias `@` (espelhando `@/*`→`./*` do tsconfig) e
  coleta testes em `lib/**` **e** `app/**` (`*.test.ts`) — rotas têm teste co-locado (ex.:
  `app/api/emails/read/route.test.ts` cobre 422/200/502 mockando `triggerReader`).
- 🔴 **`packages/shared` NÃO tem `vitest.config.ts`, e isso é deliberado:** os defaults já servem
  (env node, `**/*.test.ts`), e um `.ts` na raiz do pacote ficaria FORA do `include: ["src"]` do
  tsconfig, quebrando o lint type-aware — cujo glob é `**/*.ts`. Os testes importam
  `{ describe, it, expect }` de `vitest` explicitamente, porque o tsconfig tem `types: []` e não
  há globals. O `coverage/` entrou nos `ignores` do ESLint pelo motivo de sempre (o lcov-report do
  istanbul traz `/* eslint-disable */` e derruba o "0 warnings").
- 🔴 **`src/index.test.ts` existe por DOIS motivos, e o segundo não é óbvio.** Ele valida o barrel
  (um `export *` esquecido não quebra a compilação DESTE pacote, só a do consumidor) **e** é o que
  faz a COBERTURA enxergar o pacote inteiro: o v8 só reporta arquivo efetivamente carregado, então
  sem ele os schemas sem teste próprio ficariam fora do lcov e o Sonar os leria como 0% — que foi
  a armadilha do PR #223. Medido: 5 de 14 arquivos no lcov sem o teste do barrel, **14 de 14** com
  ele. Ao criar schema novo, basta que o barrel o reexporte; não há include a manter.
- **Suíte Python (pytest):** `py -3 -m pytest tests/` — **1.486 testes** (ex.:
  `test_link_extraction.py`, `test_email_body_extraction.py`, `test_body_amount.py`,
  `test_body_invoice_table.py`, `test_body_platform_invoice.py`,
  `test_body_supplier_override.py`, `test_arrecadacao_gnre.py`,
  `test_dup_nosso_numero_titulo.py`, `test_email_sem_pagavel.py`,
  `test_body_resolvers.py`, `test_extract_pdf.py`, `test_body_full.py`,
  `test_fiscal_key.py`, `test_fiscal_document_hook.py`,
  `test_fiscal_document_consistency.py`, `test_cte_content.py`,
  `test_backfill_cte_content.py`,
  `test_varredura_historica.py`,
  `test_vision_multi_boleto.py`, `test_barcode_self_refuted.py`,
  `test_contact_block_nonpayable.py`, `test_is_processed.py`,
  `test_onda8_gate_ia.py`, `test_react_versao_unica.py`, `test_docx_content.py`,
  `test_docx_extract.py`, `test_docx_pipeline.py`, `test_extraction_source_consistency.py`). Cobre o
  pipeline de extração; rodar após mexer em `read_emails.py`/`extract_pdf.py` ou nos
  scripts de reprocessamento. Não é incluída no `npm test` (que soma **1.557** no Node —
  frontend-vite **882** em 145 arquivos · api-backend **620** · packages/shared 53 · portal-next 2,
  medidos em 2026-08-15 com `--maxWorkers=1`. Os **7** do api-backend naquele dia (613 → 620) são a
  migration 129: 4 de atribuição de modelo em `gateway.test.ts` (servido × pedido, última resposta
  vale, fallback, falha antes de qualquer resposta), 2 em `log.test.ts` (modelo na linha de erro +
  a sanidade NEGATIVA do parser de migrations) e 1 em `route.test.ts` (o fallback que o TypeScript
  não protege). Todos validados por mutante. Os **9** daquele dia (873 → 882): **3** no próprio
  delta dos dashboards, **2** de PÁGINA em `Dashboard.test.tsx` (code review light — a ressalva de
  filtro nos subtítulos e o wiring de "trocar de mês limpa o filtro"), **2** de BORDA da janela de
  7 dias em `dashboard.test.ts` (code review max — ver o bloco de `isoDaysFromToday`; a suíte
  ficava verde com a janela deslocada um dia) e **2** de acesso por teclado à região rolável em
  `DataGrid.test.tsx` (violação `serious` que só o scan em navegador via — ver o bloco do
  `scrollable-region-focusable`). A medição anterior, **1.541** com frontend-vite
  873, é de 2026-08-14, depois do streaming SSE, que acrescentou **71**: 18 no cliente/rótulo, 31 na rota SSE
  e no transporte, 6 no progresso do gateway, 15 no contrato compartilhado e 1 no teto de linhas da
  resposta). A suíte Python está em
  **1.428** — o mais recente é a Onda 10 (comparação de estado entre medições consecutivas no
  `roadmap-gatilhos`, **+19 casos**, validada por mutante — detalhe em `SKILL.md` da skill; o
  19º entrou no code review de 2026-08-14, que corrigiu a exclusão do registro do próprio dia
  na comparação).
  Antes dela, a guarda que exige `assertChatAllowed` em **toda** rota de chat
  (`test_onda8_gate_ia.py`, validada por mutante). Antes dele, os **18** de
  `test_gasto_por_periodo_parcial.py` (o balde parcial da série temporal: as 4 colunas lidas pelo
  NOME e não por substring, o fuso de São Paulo, o domínio cross-layer Zod × SQL e a declaração na
  descrição da tool e no prompt), mais os **8** que a **125** acrescentou a
  `test_onda9_pontualidade.py` (que foi de 27 para **35**: mês parcial, fuso, a guarda de NULL
  amarrada ao `LEAST` e o mês vindo do DADO, não do rótulo). Antes deles, os **39** de
  `test_roadmap_gatilhos.py` (o medidor mensal dos gatilhos: domínio cross-layer script × CHECK,
  limiares nas duas bordas, isolamento entre medidores, contagem pelo header, retry de 429/5xx,
  teto de tempo e desmembramento do lote). Os **25** da Onda 9 são
  `test_onda9_pontualidade.py` (assinatura cross-layer TS↔SQL, fonte única da data de corte e do
  domínio do eixo, a negação do nome DPO, o período sem cobertura, sondas e grants); os **31** da
  Onda 8, `test_onda8_gate_ia.py` (**28**) e
  `test_react_versao_unica.py` (**3**), medidos contra `fbb2dc0` (1.283 → 1.314); os 56 anteriores
  são a Onda 5 e a barra na chave de acesso; os 34 antes disso, a Onda 7.
  (`test_roadmap_gatilhos.py` foi de **39** para **58** casos — 57 na Onda 10, +1 no code
  review de 2026-08-14.)
  > 🔴 **O TOTAL da suíte vive AQUI e em nenhum outro doc.** Registro de onda cita o INCREMENTO,
  > que é propriedade dela e não envelhece; total muda a cada PR, e a 2ª cópia diverge no dia
  > seguinte — foi o que aconteceu com o roadmap da Onda 8, errado nos **três** números 24 h depois
  > (inclusive no incremento, que nunca fora medido). Ao fechar onda, meça contra o commit anterior
  > num `git worktree` isolado; não conte de cabeça.
  > ⚠️ **Medir o `frontend-vite` com `--maxWorkers=1`.** Em paralelo, o sandbox do agente
  > derruba ~9 casos de a11y (`StatusBadge.a11y`, `DashboardHeader.a11y`) por esgotamento de
  > recursos — eles passam isolados e em série. É a mesma classe de falso alarme já
  > registrada em `vitest-worker-crash-sandbox`: falha espalhada em arquivo que a mudança
  > não tocou é sintoma de ambiente, não de regressão.
- 🔴 **Teste não pode depender de estado LOCAL herdado do ambiente** *(lição de 2026-08-03)*.
  `MainDryRunTest` lia o `data/varredura_checkpoint.json` **real**: enquanto o script nunca tinha
  rodado o arquivo não existia e os 7 casos passavam **por acidente** — na primeira execução de
  verdade, o checkpoint apareceu com o UIDVALIDITY da caixa e o teste ficou vermelho. Nem o code
  review nem 15 mutantes pegaram, porque **nenhum deles alterava o disco**. Arquivo de estado
  (checkpoint, cache, lock, diretório de saída) se isola no `setUp` com
  `tempfile.TemporaryDirectory` + `mock.patch.object`, nunca se herda do projeto.
- Referência de granularidade: `frontend-vite/src/components/StatusBadge.test.tsx`,
  `ExpandableText.test.tsx`, `organisms/LoginForm.test.tsx`.
- **`apps/portal-next`**: testado via **server rendering** (`react-dom/server`
  `renderToStaticMarkup`) em vez de jsdom + `@testing-library/react` (`app/page.test.tsx`).
  O React agora é **unificado em 19** em todo o monorepo (Fase 2 do upgrade), então o
  antigo conflito "duas versões do React" não existe mais: **medido em 2026-08-12, `react@19.2.7`
  em 23 nós do grafo e UMA só cópia física** — não há `react@18` nem como transitivo. Os
  `resolve.dedupe: ['react','react-dom']` do portal e do `frontend-vite` ficam como defesa contra
  um transitivo futuro, **não** como contorno de um problema atual. Guarda:
  `tests/test_react_versao_unica.py` (lê as declarações dos workspaces; validada por mutante).
  🔴 **Não medir versão de React por substring** — `lucide-react@1.21.0` e
  `@testing-library/react@16.3.2` casam `react@<versão>` e devolvem uma resposta confiantemente
  errada; medir por cópia em disco ou por chave do dicionário de dependências.
  **Sobre o portal voltar a jsdom:** medido que **já funciona** (sonda com jsdom + Testing Library
  passou). Segue em `renderToStaticMarkup` por mérito próprio — a página é um placeholder sem
  hooks, e jsdom custaria ~16 s de ambiente por nada. Ao migrar, **declarar `jsdom` e
  `@testing-library/react` como devDependencies do portal**: hoje só resolvem por hoisting da raiz.

### 3 — REST no backend

Duas camadas, dois envelopes — **não misturar**:

| Camada | Onde | Envelope |
|---|---|---|
| Flask (Python) | `server/app.py` | `{"ok": bool, ...}` — legado, manter |
| Next API (TS) | `apps/api-backend/app/api/**/route.ts` | `{ success, data?, error?, meta? }` (`lib/response.ts`) |

Regras comuns a toda rota nova:

| Decisão | Regra |
|---|---|
| URL | Substantivo no plural (`/api/contas`, `/api/contas/:id`) |
| Verbos | `GET` leitura · `POST` criação/ação · `PUT`/`PATCH` atualização · `DELETE` remoção |
| Status codes | `200`/`201` sucesso · `400`/`422` validação · `401`/`403` auth · `404` não encontrado · `5xx` servidor |
| Sessão | Stateless — autenticação via `Authorization: Bearer <token>` no header |

Rotas novas de CRUD/dados vão na **Next API** (envelope `{ success, ... }`, Repository →
Service → Route, conforme `monorepo-crud-spec.md`). A exceção aceita: a leitura de e-mails
(`POST /api/emails/read` síncrono · `POST /api/emails/read/start` assíncrono ·
`GET /api/emails/progress`) usa POST + corpo de parâmetros porque é uma **ação de disparo**,
não um recurso CRUD.

**Catálogo completo dos CRUDs** (fornecedores, contas, os 6 cadastros de Tabelas, usuários/auth,
anexos), com rotas, status codes, schemas e o raciocínio de cada decisão:
**[docs/knowledge/api-crud.md](docs/knowledge/api-crud.md)**. Os invariantes abaixo não podem
regredir e valem para **toda rota nova**:

**Autorização e visibilidade**

- **Modelo de papéis (single-org):** toda sessão autenticada opera o app — criação/edição usam só
  `requireAuth`, não papel. **Três exceções:** `POST /api/users` exige `requireAdmin`
  (`app_metadata.role`, campo server-controlled), o **hard delete** exige `requireAdminGroup`
  (`user_profile.group_id = 1`) e o **chat de IA** exige `assertAiChatAllowed`
  (`user_group.ai_chat_enabled`, migration 120). Gate de UI é cosmético; a autorização é imposta
  no servidor.
- 🔴 **Visibilidade por LINHA é dimensão à parte do papel.** Grupo com
  `user_group.sees_only_own_accounts` (hoje só o Comercial) só vê — e só edita — o que é seu. É
  imposto no BANCO (RLS 076/078/080/081), não na tela.
- 🔴 **`user_group` carrega DUAS flags ORTOGONAIS — não confundir nem "unificar":**
  `sees_only_own_accounts` decide quais **LINHAS** o usuário enxerga (visibilidade, imposta pela
  RLS) e `ai_chat_enabled` decide se ele pode **CHAMAR** uma feature paga (autorização, imposta na
  Next API). São independentes: um grupo pode ver tudo e mesmo assim não usar o chat, e vice-versa.
  Elas também têm **defaults opostos, de propósito** — a 076 usou `false` para *não restringir*
  quem já trabalhava; a 120 usa `false` para *negar*, porque o recurso protegido custa dinheiro por
  uso e grupo novo não pode nascer com acesso sem ninguém decidir.
- ⚠️ **Exposição ACEITA, não descuido:** a policy de `user_group` é `USING (true)`, então qualquer
  usuário logado lê o catálogo inteiro — inclusive quais grupos têm o chat e com que cota. É
  **configuração, não segredo**, e é justamente o que permite ao gate de UI funcionar com o token
  do próprio usuário, sem endpoint novo nem `service_role` no cliente. Registrado porque uma
  auditoria de segurança vai levantar isso; a decisão é mantê-la. Restringir exigiria uma policy
  por linha (`group_id = <o meu>`) e quebraria a leitura do catálogo pelo front.
- 🔴 **`canSeeConta` (`lib/auth.ts`) é obrigatório em rota que recebe id de conta.** A Next API lê
  com **service_role, que IGNORA a RLS**: sem o guard, um id alheio devolve (e edita) a conta de
  outro. Ele checa com o **token do usuário**, para a regra ficar onde já está (a policy) em vez de
  virar 2ª fonte de verdade. Responde **404, não 403** — 403 revelaria que a conta existe. Aplicado
  em `GET`/`PATCH /contas/:id` e nas **3 rotas de anexo**; sem ele, o `upload-url` entregaria
  credencial de ESCRITA no Storage para a conta de outro.
- 🔴 **Exceção deliberada: o DELETE de conta NÃO chama `canSeeConta`** — o propósito é o
  Administrador excluir qualquer conta; acoplar à visibilidade bloquearia um admin restrito.
- 🔴 **Toda VIEW nova sobre `auth.*` precisa de `REVOKE` explícito de escrita.** View simples é
  auto-atualizável e o Supabase concede grants default: a `app_user` permitia a qualquer usuário
  logado trocar o e-mail de outro em `auth.users` e tomar a conta por "esqueci minha senha".
- 🔴 **Nunca `REVOKE UPDATE` em `financial_account_control` nem `email_control`** — derrubaria os
  **grants por COLUNA** (`has_invoice`/`has_bank_slip`/`status_id`; `reviewed_at`) que sustentam a
  curadoria inline. As policies de UPDATE usam o MESMO predicado do SELECT.

**Contrato de escrita**

- 🔴 **Schemas de create/update derivam de `manualEditSchema` via `.pick()`** — colunas de
  pipeline/auditoria (`gmail_message_id`, `source_file`, `extraction_source`, `created_by`,
  `payment_date`…) não são graváveis pelo cliente. `has_invoice`/`has_bank_slip` ficam **FORA do
  pick**: elas têm `.default(false)` e o `.partial()` do Zod **não remove default**, então um PATCH
  que as omitisse **apagaria a curadoria**.
- 🔴 **Erro nunca vaza detalhe interno:** `failFromError` só ecoa a mensagem de um
  **`ApiServiceError`** com status < 500 **ou marcado `clientSafe`** — qualquer outra coisa vira
  500 genérico. Classe de erro de service nova **DEVE estender `ApiServiceError`** (senão a
  mensagem curada vira 500), e o mock de teste também. Erro de escrita passa por `mapWriteError`:
  default **500**, não 422.
  🔴 **`clientSafe` é opt-in e default `false` — não ligar por conveniência.** Ele nasceu porque o
  corte em 500 descartava, em silêncio, as **três mensagens 503** que `translateAnthropicError`
  produz de propósito (timeout, falha de rede, 5xx do provedor): o usuário lia "Erro interno" no
  exato momento em que a causa era temporária e havia o que fazer. Hoje só `AiChatError` o liga,
  porque toda mensagem daquela classe é escrita para ser lida. Marcar um 5xx genérico com ele
  reabre o vazamento que a classe existe para fechar. Pareado ramo a ramo em `errors.test.ts`.
  🔴 **Ecoar NÃO desliga o log** (achado do review de 2026-08-13): o 5xx marcado passa por
  `console.error` antes do eco. A marca resolve o que o **usuário** lê, não o que o **operador**
  precisa ver — sem essa linha, uma indisponibilidade do provedor atingiria todo mundo sem deixar
  rastro na function, e a rastreabilidade sobreviveria só porque *este* consumidor grava o próprio
  `ai_chat_log`: acidente do consumidor, não garantia do helper, que é opt-in para ser reusado.
  4xx curado segue **sem** log (ali o erro é do pedido, não do servidor). Os dois em `response.test.ts`.
  🔴 **QUEM ENUNCIA O CORTE TEM DE ENUNCIAR A EXCEÇÃO** — travado por guarda
  (`tests/test_onda8_gate_ia.py`): doc vivo que diga "ecoa se status < 500" sem citar `clientSafe`
  descreve um comportamento que o código não tem mais. O contrato vive em **três** lugares (código,
  esta regra e [docs/knowledge/api-crud.md](docs/knowledge/api-crud.md)); a mudança corrigiu o
  código e cada correção seguinte esqueceu um doc — o `api-crud.md` afirmou o oposto por um PR
  inteiro. Numa regra de SEGURANÇA isso é o pior modo de falha: quem lê acredita e reporta um
  vazamento que não existe. `docs/review/**` fica fora da guarda (são retratos datados).
- **Remoção padrão de conta = `PATCH status_id = cancelado`** (preservação). Hard delete é a
  exceção do grupo Administrador. Fornecedor usa **soft delete**; os 6 cadastros de Tabelas usam
  hard delete bloqueado por FK (409).
- **Ordenação server-side** valida a coluna contra o allowlist `SORTABLE_COLUMNS` do service
  (`lib/sort.ts`); 🔴 **`applyOrder` desempata pela PK** — sem isso, empate + paginação por offset
  faz linha aparecer duas vezes e outra sumir.
- **`checkClassificationPair`** é a validação autoritativa do par centro × plano (422); o pipeline
  Python bypassa por service_role e já produz par consistente por construção.

**Anexos (`financial_account_attachment`)**

- 🔴 **A chave do objeto é gerada no SERVIDOR** (`manual/{account_id}/{ts}_{rand8}_{nome}.{ext}`) e
  o guard valida o **FORMATO INTEIRO**, não o prefixo: o Supabase Storage **normaliza `..`**, então
  `startsWith('manual/{id}/')` aceitaria o objeto de outra conta ou do pipeline.
- 🔴 **O register grava `size`/`mimetype` REAIS do `storage.info()`**, não os declarados pelo
  cliente — a URL assinada não valida conteúdo.
- 🔴 **O repository filtra `deleted_at` EXPLICITAMENTE**: a policy esconde o removido do papel
  `authenticated`, mas a Next API usa service_role e o anexo removido reapareceria no grid.
- **Remoção é soft delete**; anexo `origin='pipeline'` é irremovível (trilha de auditoria → 403).

### 4 — Conventional Commits (todo o projeto)

**Todos** os commits — frontend, backend, scripts, infra — seguem o formato:

```
tipo(escopo): mensagem em português ou inglês
```

| Tipo | Quando usar |
|---|---|
| `feat` | nova funcionalidade |
| `fix` | correção de bug |
| `test` | adição/correção de testes |
| `docs` | documentação (incluindo CLAUDE.md) |
| `chore` | manutenção, deps, configs |
| `refactor` | refatoração sem mudança de comportamento |

Escopo = área afetada: `login`, `email-reader`, `consulta`, `scheduler`, `migrations`, etc.

**Sem co-autoria do Claude (não regredir):** NÃO incluir a linha `Co-Authored-By: Claude ...`
na mensagem de commit nem no corpo do PR — pedido explícito do usuário. Isso sobrepõe a
instrução padrão do harness de assinar como co-autor.

> **NENHUMA operação de escrita em git roda sem pedido EXPLÍCITO na mensagem ATUAL** — `commit`,
> `push`, `gh pr create`, `gh pr merge`, `merge`, `rebase`, `reset --hard`. **Autorização é por
> TURNO e não tem efeito residual:** um "commit + push + pr + merge" numa mensagem NÃO autoriza a
> seguinte. Também não se infere de "resolva os itens", "atualize o CLAUDE.md", "implante" ou
> "garanta" — esses pedem terminar o trabalho e APRESENTAR; o resultado fica no working tree.
> Regra reafirmada 3× pelo usuário (2026-07-13, 07-23, 07-30).
>
> **A regra passou a ter barreira MECÂNICA em 2026-07-30, porque só documentação não bastou.** A
> causa da 3ª reincidência não foi falta de regra: o `~/.claude/settings.json` global tinha
> **coringas de allow** (`Bash(git commit *)`, `Bash(git push *)`, `Bash(git merge *)`,
> `Bash(gh pr *)`, `Bash(git reset *)`, `Bash(git rebase *)`) acumulados de cliques em "sempre
> permitir" — ou seja, o harness tinha autorização permanente e nenhum prompt aparecia. Os seis
> foram **removidos** (backup em `~/.claude/settings.json.bak-20260730`; as leituras
> `gh pr view/list/checks/diff/status` e `git status/log/diff/branch/fetch/pull/add` continuam
> liberadas), e `.claude/settings.local.json` (gitignored) declara `permissions.ask` para as mesmas
> operações em **Bash e PowerShell**. **NÃO reintroduzir coringa de escrita no allow** — é o que
> desarma a barreira, e o sintoma é a ausência de prompt, não um erro.

**Nomenclatura de Pull Request:** se o usuário informar o nome do PR, usar exatamente esse.
**Quando o usuário NÃO informar o nome (ou disser "pr seu nome"), o Claude escolhe** um
título descritivo do escopo (não genérico, não a numeração `#N`) e abre o PR direto — **não
perguntar**. PRs seguem de `Features` → `main` (ver "GIT STRATEGY" do workspace).

**FIM DE LINHA — o repositório é LF, normalizado por `.gitattributes` (não regredir):** o
arquivo na raiz declara `* text=auto eol=lf` (+ binários explícitos: `png`/`ico`/`pdf`/
`woff2`/`xlsx`). Antes dele o repo era LF **sem** normalização, com `core.autocrlf=false` —
e o desenvolvimento é em **Windows**, então qualquer ferramenta que reescreva um arquivo em
**modo texto** o convertia para CRLF. O caso real: `pathlib.write_text` (que traduz `\n`
para `os.linesep`) usado num script auxiliar reescreveu 7 arquivos, e o diff saltou de
**716** para **12.578** linhas.

**O estrago não é cosmético:** com o arquivo inteiro marcado como alterado, o **SonarCloud
trata CADA LINHA como código NOVO** — todo o passivo pré-existente (a começar pela
complexidade **55** de `extract_and_store_accounts`) entra no gate de *new code* e reprova o
PR, com o motivo real escondido atrás de milhares de linhas de ruído. Além de destruir o
`git blame` e gerar conflito para quem tocar nos mesmos arquivos.

Regras práticas: ao gerar/reescrever arquivo por script, **grave em BYTES**
(`write_bytes`) ou passe `newline="\n"` — nunca `write_text` puro no Windows. Antes de
commitar, se o `--stat` estiver desproporcional ao que você mexeu, compare com
`git diff --stat --ignore-cr-at-eol`: se a diferença sumir, é EOL. E **normalização vai em
commit PRÓPRIO**, separada de mudança de comportamento — `git add --renormalize .` mistura
tudo no index (foi o que aconteceu; desfeito com `git reset`).

### 5 — Lint limpo e análise estática

> **O `npm run lint` verde NÃO garante o PR verde:** o ESLint local e o **SonarCloud** do CI têm
> conjuntos de regras DIFERENTES, e o Sonar **reprova o merge** (quality gate). Ex. real: o
> `<div onClick={…}>` do PR #129 passou no lint e foi barrado pelo Sonar (S1082).
> Ver "SonarCloud no CI" abaixo.

- **`npm run lint` na raiz deve passar com 0 erros e 0 warnings** em todos os workspaces
  (cobre `frontend-vite`, `api-backend`, `portal-next` **e `packages/shared`** — cada um com
  seu `eslint.config.mjs`). O `packages/shared` usa flat config type-aware **sem React**
  (`@eslint/js` + `typescript-eslint` `recommendedTypeChecked`, `globals.node`, glob `**/*.ts`
  para o próprio `eslint.config.mjs` ficar fora do lint type-aware) — binários resolvidos por
  hoist. O shared **não** tem `prune` (ver nota do ts-prune abaixo).
- **Relatório de cobertura fica FORA do lint nos 3 apps (não regredir):** `coverage/` é ignorado
  no `frontend-vite` (`ignores: ['dist', 'coverage', 'e2e', …]`) e, desde 2026-07-28, também no
  `api-backend` e no `portal-next` (`"coverage/**"` no `globalIgnores`). Motivo: os arquivos do
  **lcov-report do istanbul** trazem `/* eslint-disable */` no topo e o
  `reportUnusedDisableDirectives` (ligado por padrão no ESLint 9) os acusa como diretiva inútil —
  1 warning por app Next, em código **gerado**, que derrubava a regra de "0 erros e 0 warnings".
  Não some apagando a pasta: o workflow do SonarCloud roda `vitest --coverage` a cada PR e a
  recria.
- **Versões de ESLint divergem por workspace (intencional):** `frontend-vite` usa **ESLint 10**
  (+ `typescript-eslint@8.61`); os apps Next ficam em **ESLint 9** porque o
  `eslint-config-next` depende de um `eslint-plugin-react` que quebra no ESLint 10 (`getFilename`
  removido). Carve-out documentado em `eslint10-next-carveout` (memória) — subir quando o
  upstream suportar ESLint 10.
- **Regras do React Compiler ativas** (`eslint-plugin-react-hooks@7` `recommended`): pureza de
  render, `set-state-in-effect`, etc. Disables justificados (`// eslint-disable-next-line
  react-hooks/...`) onde o effect é a ferramenta correta — `void load()` (fetch-on-change em
  `Consulta`/`Emails`/`Erros`), reconcile de prefs (`useGridPreferences`) e `incompatible-library`
  do `@tanstack/react-table` (`DataGrid`). Padrões corrigidos de verdade: sincronizar prop no
  render (não em effect) e não chamar funções impuras (`Date.now`) no escopo de render.
- **Transform de build do React Compiler HABILITADO** (`vite.config.ts`): memoiza
  componentes/hooks automaticamente. No `@vitejs/plugin-react@6` (oxc/Rolldown) entra via
  `@rolldown/plugin-babel` + `reactCompilerPreset()` (peers: `@rolldown/plugin-babel`,
  `@babel/core`, `babel-plugin-react-compiler@1`, `@types/babel__core`) — **não** pelo antigo
  `babel` option do plugin. Alvo React 19 (runtime embutido `react/compiler-runtime`); o
  compiler faz "bail out" seguro em código incompatível (ex.: `useReactTable` no `DataGrid`).
  Confirma-se no bundle pela presença de `useMemoCache`.
- **`frontend-vite`** usa flat config type-aware (`typescript-eslint` + `react-hooks` +
  `react-refresh`). Ajustes deliberados, **manter**: `no-misused-promises` com
  `checksVoidReturn: { attributes: false }` (handlers async em `onClick`/`onSubmit` são
  idiomáticos); regras `no-unsafe-*` desligadas só em `*.test.tsx` (mocks tipados `any`).
  Promessas fire-and-forget (`load()` em `useEffect`) levam `void` explícito.
- **`tsconfigRootDir`**: todo `eslint.config.mjs` ancora `parserOptions.tsconfigRootDir:
  import.meta.dirname` — não remover, é o que evita o erro "No tsconfigRootDir was set" no
  editor. Nos apps Next, **não** habilitar `projectService: true` (quebra o parsing dos
  `*.config.mjs`); apenas `tsconfigRootDir`.
- **`.vscode/settings.json` (não remover)**: o monorepo só tem flat config **por-app**
  (sem `eslint.config` na raiz). Sem `eslint.workingDirectories: [{ "mode": "auto" }]` a
  extensão ESLint roda com cwd na raiz, não acha config e acusa "couldn't find an
  eslint.config file" / "No tsconfigRootDir was set" nos componentes. O `mode: auto` faz a
  extensão rodar com cwd em cada app.
- **ts-prune (dead code / exports órfãos)**: `npm run prune` na raiz roda nos **3 apps**
  e **deve reportar 0**. `ts-prune` está declarado só em `frontend-vite` (resolvido por
  hoist nos apps Next). Os apps Next ignoram os defaults do framework via
  `--ignore "next.config|...|app.*(page|layout|route)"`. **`packages/shared` deliberadamente
  NÃO tem `prune`**: sendo um pacote de barrel (biblioteca pura cuja API é consumida
  cross-package via `@sheild/shared`), o ts-prune isolado reportaria **toda** export pública
  como órfã (falso positivo). A cobertura de uso real vem do `prune` dos apps consumidores;
  no shared fica só `lint` + `typecheck` — **mas ele TEM suíte** (`vitest run`), acrescentada no
  PR #224; o que ele não tem é `prune`. Export público intencional **sem
  consumidor** (scaffolding da camada CRUD ou contrato de tipo consumido por inferência —
  `getSupabaseAdmin`, `ApiResponse`/`ApiResponseMeta`, `ReaderSummary`/`TriggerReaderOptions`)
  leva `// ts-prune-ignore-next` na linha acima, documentando a intenção. Não deixar export
  morto de verdade: removê-lo (foi assim que saíram o hook `useGridColumns` e os
  `scripts/_check_*.py`).
- **Python — `vulture`** (`py -3 -m vulture server/ skills/ scripts/ --min-confidence 60`):
  caça funções/variáveis mortas. Rotas Flask decoradas (`@app.get`/`@app.post`) aparecem
  como "unused function" — **falsos positivos**, ignorar.
- **SonarLint** (engine da IDE, sem CLI): manter o código livre dos achados recorrentes —
  condições positivas em vez de negadas com `else` (S7735: `v == null ? '—' : …`), par
  `[x, setX]` no `useState` (S6754), sem ternário/template literal aninhado no JSX (S3358/
  S4624 — extrair para uma const antes do `return`), sem import não usado (S1128), sem
  seletor booleano que escolhe a ação dentro do método (S2301 — preferir uma única ação
  com valor por ternário, ex.: `setItem(key, on ? '1' : '0')` em vez de `if/else` com
  `setItem`/`removeItem`), e sem texto solto logo após um elemento inline em JSX (S6772 —
  envolver o texto em `<span>`, ex.: `<input … /><span>Lembrar-me</span>`).
  Também recorrentes: props de componente React como `Readonly<…>` (S6759 —
  `{ children }: Readonly<{ children: ReactNode }>`); função com complexidade cognitiva
  >15 (S3776 — extrair helpers, ex.: o laço de `reprocess_link_emails.py` virou
  `_process_row`/`_first_pdf`/`_store_pdf`); `logging.exception()` em vez de `logging.error()`
  dentro de `except` (S8572); e f-string sem campo de substituição (S3457 — usar string
  normal). Mais um recorrente, achado no PR #129: **handler de clique em elemento
  NÃO-INTERATIVO** (S1082 — `<div onClick={…}>`, `<dialog onClick={…}>`); a saída é pôr o
  handler no `<button>`/`<a>`, não adicionar um `onKeyDown` inútil ao lado (ver "Contenção do
  clique" em "Anexos de conta").
- **SonarCloud no CI — BARRA o PR (não é só a IDE):** além do SonarLint local, o repositório tem
  a integração **SonarCloud** (projeto `SHE-ADM_email-financeiro`), que roda a cada PR e **reprova
  o merge** pelo quality gate — o `npm run lint` local passa e o PR fica vermelho assim mesmo. A
  condição que mais morde é **`new_reliability_rating > 1`**: UM único BUG no código novo (mesmo
  MINOR) já reprova. Não há workflow em `.github/workflows/` (é o app do GitHub); consulte o
  motivo pela API pública, sem token:
  ```bash
  node -e "fetch('https://sonarcloud.io/api/qualitygates/project_status?projectKey=SHE-ADM_email-financeiro&pullRequest=<N>').then(r=>r.json()).then(j=>console.log(JSON.stringify(j.projectStatus,null,1)))"
  node -e "fetch('https://sonarcloud.io/api/issues/search?componentKeys=SHE-ADM_email-financeiro&pullRequest=<N>&types=BUG&resolved=false').then(r=>r.json()).then(j=>j.issues.forEach(i=>console.log(i.component,i.line,i.message)))"
  ```
  (o `curl` do Git Bash falha no TLS do sonarcloud.io — use `node -e` com `fetch`.) Antes de
  concluir que é ruído, confira se PRs anteriores passavam (`gh pr view <N> --json
  statusCheckRollup`): se passavam, o achado é seu.
- **Análise CI-based + escopo VERSIONADO — `sonar-project.properties` + `.github/workflows/sonarcloud.yml`
  (migração de 2026-07-18 — não regredir):** o método passou de **Automatic Analysis** (GitHub App)
  para **CI-based** (o workflow roda o scanner a cada PR/push). No modo CI o arquivo de escopo lido é
  **`sonar-project.properties`** na raiz (o `.sonarcloud.properties` do Automatic Analysis foi
  **removido** — só valia naquele modo). **PRÉ-REQUISITO no dashboard:** desligar Administration →
  Analysis Method → "Automatic Analysis" (senão o scan CI é rejeitado com "Automatic Analysis is
  enabled") + cadastrar o secret **`SONAR_TOKEN`** no GitHub. O motivo da migração é o mesmo do
  escopo versionado: resolver issue na UI ("Won't Fix"/"False Positive") **NÃO é permanente** — o
  engine perde o rastreamento ao re-basear e **REABRE** a issue (`REOPENED`; diagnóstico de
  2026-07-18: 266 de 376 issues do `main` estavam REOPENED). O `sonar-project.properties` fixa o
  escopo de forma determinística: (1) **exclui `supabase/migrations/**`** — PostgreSQL analisado
  pelo engine **PL/SQL (Oracle)**, semântica divergente (`'' = NULL`) → falsos positivos plsql
  sistemáticos, e são artefatos IMUTÁVEIS (proibido editar migration aplicada), logo inanalisáveis
  por definição (trade-off: bug real em migration nova fica coberto por revisão de PR + testes, ex.:
  `tests/test_doc_type_domain_consistency.py`); (2) **marca os testes como TEST sources**
  (`sonar.tests`/`sonar.test.inclusions`) — o Sonar não levanta em fixture de teste as regras de
  "main" que viram falso positivo (IP hardcoded `S1313`, http `S5332`, "secret" `S2068/S6418` — ex.:
  `tests/test_ssrf_guard.py`, cujas fixtures SSRF são propositais); (3) **supressão por regra+arquivo
  via `sonar.issue.ignore.multicriteria`** (que — ao contrário do Automatic Analysis — **funciona** no
  modo CI): `pythonsecurity:S8707` no CLI do `extract_pdf.py` (Won't Fix deliberado). O workflow
  também **roda a cobertura** (Vitest → lcov por app + pytest → coverage.xml) e a reporta ao Sonar —
  logo um teste quebrado passa a **reprovar o PR** neste workflow. **O backlog NUNCA bloqueou deploy**
  — o gate julga só código NOVO (`new_*`); o escopo versionado limpa o RUÍDO acumulado, não o gate.
- **Backlog de issues do SonarCloud (não é o gate — dívida pré-existente) e TRIAGEM (2026-07-17):**
  o gate reprova só **código novo**; o backlog do `main` (facetar por `resolved=false`) é dívida que
  não bloqueia PR. Triagem feita e ações tomadas — **não reinvestigar do zero**:
  - **Segurança:** os 106 issues Python eram **100% code smells** (0 bug/vulnerabilidade). As 9
    "vulnerabilidades" eram **falsos positivos**: `email_sender.py` já usava `ssl.create_default_context()`
    (resolvido de vez fixando TLS 1.2 — ver abaixo); `auth.schema.ts` `PASSWORD_CHANGED_META_KEY`
    (nome de chave, não senha); tokens/URLs `http://` de **fixtures de teste** (o `http://` do
    `test_ssrf_guard` é PROPOSITAL — testa o bloqueio). **O `S6418` "hard-coded secret" em
    `tests/test_flask_csrf_guard.py` (Blocker que reprova o gate) foi CORRIGIDO** — o literal
    `"segredo-de-disparo"` (repetido em 3 pontos) virou `_FAKE_TRIGGER_TOKEN = "test-" +
    uuid.uuid4().hex` (gerado em runtime): sem literal, a heurística não flagra, e some a duplicação
    (S1192); comportamento do teste inalterado. **Regra:** token/senha em teste = valor computado
    (uuid), nunca string fixa que pareça segredo. Os **4× `S8707`** (path de CLI em
    `extract_pdf.py`) foram marcados **Won't Fix** na UI — é CLI de operador confiável (in-process em
    prod); a entrada realmente não-confiável (boleto por link) já é guardada (`_is_within_inbox`/SSRF).
  - **1 BLOCKER real (077):** `UPDATE` de backfill sem `WHERE` (`plsql:DeleteOrUpdateWithoutWhereCheck`)
    — corrigido com `WHERE updated_by = '<sentinela do DEFAULT>'` (idempotente; efeito idêntico no
    backfill único, no-op na reexecução). A migration já estava aplicada — mudança só no arquivo.
  - **Limpeza mecânica aplicada (37 smells, comportamento preservado, 604 testes verdes):** `S8572`
    `log.error`→`log.exception` em `except` (21), `S3457` f-string sem campo (5), `S1481` var não
    usada→`_` (3), `S125` comentário que parecia código (3), `S1186` método-stub vazio (2), `S1192`
    só as TÉCNICAS — `_PREFER_MINIMAL`/`_HTML_TAG_RE` (3).
  - **Backlog resolvido em 2026-07-18 (S6418/S6819/S6845/S125):** `S6418` "hard-coded secret" em
    `tests/test_flask_csrf_guard.py` → token de teste gerado em runtime (`uuid.uuid4().hex`); os a11y
    do Dashboard `S6819` (`role="region"`→`<section>`) e `S6845` (`tabIndex` redundante removido — KPIs
    já são `<button>` focáveis, ver seção 6); `S125` na migration 073 → bloco de VERIFICAÇÃO reescrito
    de SQL comentado para prosa (a migration já estava aplicada; comentário não afeta reprodutibilidade).
  - **DELIBERADAMENTE não corrigidos:** `S1192` de **vocabulário de domínio** (mime types, "nota
    fiscal"/"honorários"/"conta de luz"… em listas que espelham o CHECK do banco — a constante piora
    a legibilidade sem ganho) e os **refactors estruturais** `S3776` (complexidade, 22) + `S8786`/
    `S7632`/… no **núcleo do pipeline** (`read_emails.py`): mudar fluxo de controle do coração da
    extração para satisfazer métrica é anti-robustez — fazer, se um dia, função a função com a suíte
    como rede, não em sweep.
  - **Precedente do "função a função" (2026-07-28):** `extract_from_email_body` foi a primeira
    a ser tratada, quando a complexidade (**61, grau F** por `radon`) já impedia revisar uma
    alteração com segurança. O padrão que funcionou — **repetir nas próximas, não improvisar**:
    (1) extrair as **cadeias de precedência** como funções PURAS (`_resolve_body_*`), sem tocar
    na ordem, que É a regra de negócio; (2) trocar `if` encadeado por **tabela de fontes**
    (`_BODY_INVOICE_SOURCES`); (3) provar equivalência por **A/B sobre dados reais** (139 corpos
    + 764 assuntos reprocessados com o código de HEAD e com o novo → **0 diferenças**), não só
    pela suíte. Resultado: **61 (F) → 17 (C)**. Sem o A/B, um refactor desse porte no núcleo não
    deve ser mesclado.

### 6 — Acessibilidade (WCAG 2.1 AA)

Alvo: **WCAG 2.1 Nível AA** em todas as telas. Regras práticas:

- **Todo controle de formulário tem nome acessível + `id`/`name`.** Inputs/selects de filtro
  recebem `aria-label` (nome para leitores de tela e para o axe) **e** `id`/`name` (resolve
  o alerta de autofill do Chrome). Campos com label visível usam `<label htmlFor>` ligado a
  um `id` — ver `FilledTextField`/`AuthInput`, que geram `id` via `useId` e associam o erro
  por `aria-invalid` + `aria-describedby`. Botão só-ícone leva `aria-label` (ex.: olho de
  senha).
  > ⚠️ **Exceção conhecida: os controles react-select ficam SEM `name`, e a prop `name` NÃO
  > resolve** *(medido em 2026-08-04 — não repetir a tentativa)*. O `inputId` vira o `id` do
  > input de busca, mas o `name` do react-select renderiza um **input OCULTO** para submissão
  > de formulário: sondado no `ChartAccountSelect`, o resultado é
  > `text|id=cca|name=-` (o campo visível, que é o que o Chrome avalia) **mais**
  > `hidden|id=-|name=cca`. Ou seja, passar `name` acrescenta um campo oculto e deixa o
  > visível exatamente como estava. Não há prop para nomear o input de busca sem alterar a
  > biblioteca. Vale para `ChartAccountSelect`, `CostCenterSelect` e `SupplierSelect`.
- **Contraste**: pares texto/fundo cumprem AA — texto normal ≥4.5:1, texto grande/ícone de
  UI ≥3:1. Ao criar ou alterar um token de cor, **validar o ratio** (controles desabilitados
  são isentos pela 1.4.3). Em **superfícies escuras** (sidebar `bg-sidebar`) o texto deve ser
  **claro**: `slate-300/400`, não `slate-500/600` (estes invertem e reprovam). `text-white`
  sobre `bg-brand` sólido reprova (3,4:1) — usar `bg-brand-dark` quando houver texto branco.
- **Testes a11y automatizados (jest-axe, AA)**: matcher em `tests/setup.ts`
  (`expect.extend(toHaveNoViolations)`); runner configurado em `tests/axe.ts` (tags
  `wcag2a/2aa/21a/21aa`). Todo componente/página relevante ganha um `*.a11y.test.tsx` com
  `expect(await axe(container)).toHaveNoViolations()`. Páginas com serviços mockam os
  serviços (ver `pages/Consulta.a11y.test.tsx`, `pages/Emails.a11y.test.tsx`).
- **Contraste é travado por teste** em **dois guardas** que compensam o axe em **jsdom** não
  avaliar `color-contrast` (regra desligada em `tests/axe.ts`):
  - `tests/contrast.a11y.test.ts` — pares dos **tokens do projeto** (`loginGreen-*`, `status-*`),
    lendo os `--color-*` do bloco `@theme` em `src/index.css` (fonte de verdade v4 CSS-first;
    parse via regex) e falhando abaixo do mínimo AA.
  - `tests/contrast-usage.a11y.test.ts` — pares das **cores default do Tailwind em uso** como
    texto/ícone (`gray/slate/zinc/amber/orange…`) sobre seus fundos reais. Mantém um array
    `COMPLIANT` (asserção dura, não regride) e um padrão de **ratchet** documentado: uma nova
    cor de baixo contraste vai para um `KNOWN_VIOLATIONS` verificado com `it.fails` (suíte segue
    verde, dívida visível) e, ao corrigir, sobe para `COMPLIANT`. Texto AA ≥4.5:1 · ícone/UI ≥3:1;
    ao introduzir cor default escura, **subir o tom** (ex.: `*-400`→`*-500`/`amber-600`) em vez de
    relaxar o threshold.
- **Camada de acessibilidade em NAVEGADOR REAL** (Playwright + `@axe-core/playwright`) — cobre o
  que o jsdom não vê: contraste sob render efetivo, ordem de foco e autofill. Config em
  `playwright.config.ts`, specs em `e2e/*.a11y.e2e.ts` (`public-auth` = login/forgot/reset sem
  login; `protected` = `/consulta`/`/emails`/`/erros`/**`/dashboard_vencimentos`**/
  **`/dashboard_despesas`** + o **painel do assistente de IA aberto** (o `<dialog>` só existe no DOM
  depois do clique; o caso NÃO envia pergunta — a resposta viria da Claude API, paga e
  não-determinística) atrás de `A11Y_TEST_EMAIL`/
  `A11Y_TEST_PASSWORD`, pulado sem credencial — o Dashboard entrou no scan pelo achado A3-8, e
  `/dashboard_despesas` só em 2026-08-15: era a rota com MAIS superfície exclusiva — os ramos
  `<button>` do donut e do ranking (que só ela liga, via `onSliceSelect`/`onSelect`) e o
  `ExpenseDetailModal` — e mesmo assim nunca fora escaneada em navegador),
  helper `e2e/axe.ts` (tags AA).
  🔴 **Rota cujo DOM muda por interação declara ESTADOS extras (`PageState`), um `test` cada** —
  escanear só a abertura cobre metade do que a tela renderiza. São **três** (12 testes no total):
  `/dashboard_vencimentos` "sem filtro de KPI" e, em `/dashboard_despesas`, "sem filtro de KPI" e
  "card de detalhe aberto". Nenhum é enfeite: desde que as telas passaram
  a abrir em `vencendo7` (2026-08-15), a linha crítica do `PriorityList` — o ramo tintado
  `bg-status-error-bg` + `border-l-status-error-solid` — ficou **inalcançável em qualquer base**, já
  que o filtro exige "a vencer" e `critical` exige "vencido"; e o `<dialog>` do drill-down só existe
  no DOM depois de um clique numa fatia/linha. O `enter` do estado é **tolerante à
  ausência** do gatilho (o default pode mudar de novo) e **intolerante à permanência** do estado que
  promete deixar: sem essa asserção, um `enter` que falhasse em silêncio faria o teste escanear o
  MESMO DOM duas vezes e reportar verde — pior que não existir, porque a suíte declararia cobertura
  que não tem. ⚠️ O estado restaura a cobertura anterior, **não** garante o dado: mês sem conta
  vencida não tem linha crítica para escanear, e assertar a presença dela acoplaria o CI ao dado de
  produção. 🔴 **Quando não há gatilho, o `enter` ANOTA em vez de silenciar**
  (`test.info().annotations`, tipo `estado-nao-exercitado`) — é a terceira saída entre "falhar por
  falta de dado" (acopla o CI à produção) e "escanear o mesmo DOM de novo" (verde por uma cobertura
  que não houve). ⚠️ E o `enter` do detalhe espera um `h3` **antes** de contar os gatilhos:
  `count()` não tem auto-wait, então um disparo cedo demais anotaria "sem dado" numa tela que só
  não tinha pintado ainda. O seletor do gatilho é `button[title^="Ver contas de "]`, que casa a
  fatia do donut **e** a linha do ranking (os dois componentes emitem o mesmo `title`) — o nome
  acessível não serviria, porque é o conteúdo do botão e muda a cada carga.
  O reporter do `axe.ts` emite, por nó, o **`failureSummary`**
  (para color-contrast: `foreground`/`background`/`ratio`/esperado) **+ o HTML do elemento**, além
  do seletor — a falha fica depurável só pelo **log do CI** (essencial, já que o navegador não
  roda no sandbox do agente). Scripts `test:e2e`/`test:e2e:headed`. Os
  specs **não** rodam no `npm test` (runner separado, fora do `tsconfig`/ESLint — `e2e/` está nos
  `ignores`). Ver `e2e/README.md`. O **workflow `.github/workflows/a11y.yml`** roda a camada a cada
  PR/push na `Features` (runner `ubuntu-latest`, Chromium provisionado), com os 4 secrets cadastrados
  (`VITE_SUPABASE_URL`/`ANON_KEY` + `A11Y_TEST_EMAIL`/`PASSWORD`). O usuário do CI é
  **`teste-a11y@sheild.app.br`** (grupo 0), dedicado — trocado em 2026-08-07, quando o anterior
  (`teste@otimotex.com.br`) foi removido. **Não é "só-leitura"**, como este parágrafo já afirmou:
  o app não tem papel de leitura, e um usuário autenticado qualquer pode curar NF/Boleto e situação
  em `/consulta`. O que protege é o spec, que só varre — não a permissão.
  🔴 **Usuário de CI PRECISA de `app_metadata.password_changed = true`.** Criá-lo pelo Dashboard
  **não** define a marca, e sem ela o `ProtectedRoute` manda o 1º login para
  `/auth/change-password`: os specs protegidos nunca chegam a `/consulta` e falham por um motivo
  que não tem nada a ver com acessibilidade. Criar pela **Admin API** já com a marca e **provar o
  login antes de cadastrar o secret** (`POST /auth/v1/token?grant_type=password` com a anon key —
  criar o usuário não prova que ele loga). Receita em `e2e/README.md`.
  🔴 **E o grupo dele PRECISA ter `ai_chat_enabled = true`** (migration 120): o caso
  *"Assistente de IA — painel aberto"* **clica no botão flutuante**, e o gate de UI não o renderiza
  para grupo sem acesso — o spec falharia por timeout, num erro que não tem nada a ver com
  acessibilidade. Por isso o usuário do CI foi movido do grupo 0 (sentinela, **que não pode ser
  liberado** — é o destino de qualquer usuário sem perfil, e liberá-lo transformaria o opt-in em
  opt-out) para o **7 Financeiro**, em 2026-08-12. Neutro para visibilidade: os dois grupos têm
  `sees_only_own_accounts = false`. **Esta é a 2ª vez que o CI aparece como dependência
  não-óbvia de uma mudança de autorização** — a 1ª foi a remoção do usuário sentinela; ao mexer em
  grupo, papel ou flag, conferir o `a11y.yml` antes.
  ✅ **O workflow TEM `workflow_dispatch`** (Actions → *Acessibilidade (a11y)* → **Run workflow**),
  acrescentado em 2026-08-13 — antes só havia `pull_request` e `push` na `Features`, e uma troca de
  credencial do CI só era exercitada de fato no PR seguinte, que é como as duas dependências acima
  foram descobertas **depois**. 🔴 **O disparo manual leva o input `require_protected` (default
  `true`) e FALHA CEDO quando algum dos 4 secrets está ausente** — sem essa guarda o `test.skip` do
  spec pularia as rotas protegidas em silêncio, e "pulado" num log de CI se lê como "passou": o
  verde não provaria nada, que é o oposto do motivo de o disparo existir. Para varrer só as páginas
  públicas, rode com `require_protected = false`. **Não rodar `npm run test:e2e` no sandbox do
  agente** — o renderer do Chromium crasha ao montar a SPA completa (limite de recursos do ambiente,
  não do código); validar na máquina do usuário ou no CI. A camada já **pegou e corrigiu 45 violações
  de contraste** nas páginas protegidas (sidebar/cabeçalhos/grid/toolbar) que os guardas por token e o
  jsdom não viam — ver "Guia de cores — grid de dados".
- **Achados de a11y do navegador corrigidos em 2026-07-08 (não regredir):** a suíte esteve
  **vermelha ~5 dias** por causas que só o axe em navegador via:
  - **Sidebar transbordava sobre o `<main>` branco.** O `<nav>` era `flex-1` **sem overflow**; com
    todos os itens (19 links + 5 grupos) o conteúdo excedia o viewport e os últimos itens + o rodapé
    (avatar/e-mail) caíam sobre o fundo BRANCO do `<main>`, onde `text-slate-400` dá 2,57:1.
    Fix (`Layout.tsx`): `nav` = **`flex-1 min-h-0 overflow-y-auto`** — rola DENTRO da sidebar escura
    (`bg-sidebar`, ~7:1). **Não** remover o `min-h-0`/`overflow-y-auto`.
  - **Corpo do Dashboard = região rolável sem acesso por teclado** (`scrollable-region-focusable`,
    WCAG 2.1.1). Ao conter a sidebar, o layout de altura passou a constringir o corpo, que agora ROLA
    de fato. **Solução ATUAL (revisada 2026-07-18 — não regredir):** o container `overflow-y-auto` é
    um **`<section aria-label="Indicadores e gráficos">`** — o `<section>` com nome acessível expõe o
    papel `region` **implícito** (sem `role="region"` — evita SonarCloud **S6819**), e os **5 cards de
    KPI (`<button>`, estáticos)** são os descendentes **focáveis** que dão acesso por teclado à
    rolagem, tornando o **`tabIndex={0}` desnecessário** (evita **S6845** "tabIndex só em elemento
    interativo"). A versão anterior usava `<div tabIndex={0} role="region">` — foi trocada porque os
    KPIs viraram `<button>` focáveis (feature "Cards de KPI clicáveis = filtro"), então o axe
    `scrollable-region-focusable` já fica satisfeito pelos botões, em qualquer estado (loading/vazio,
    pois os 5 KPIs são um array estático). **Não** reintroduzir `tabIndex`/`role="region"` no
    contêiner nem transformar os KPIs em `<div onClick>` (voltaria a exigir o `tabIndex`).
    🔴 **A MESMA regra mordeu o `DataGrid` em 2026-08-15, e ali a saída é a OPOSTA — não
    confundir.** O viewport com `maxBodyHeight` (`<section>` em `DataGrid.tsx`) passou a levar
    **`tabIndex={0}` + `aria-label`**, porque a primeira saída (ter conteúdo focável dentro) só
    valia **de carona**: em `/consulta` e `/emails` há checkbox de seleção e cabeçalho ordenável,
    mas no **`ExpenseDetailModal`** não há NADA focável (linhas não-selecionáveis, colunas não
    ordenáveis, e no modo não-gerenciado o `<th>` é `<th onClick>`, não `<button>`) — quem navega
    por teclado **não conseguia rolar** a lista do drill-down. Violação `serious` pega no primeiro
    scan em navegador daquele `<dialog>`. É **sem opt-in** (todo grid com `maxBodyHeight` é
    focável): uma prop opcional reintroduziria o mesmo modo de falha no próximo grid sem conteúdo
    focável, e ninguém notaria. `<section>` **sem** nome acessível tem papel `generic`, então grid
    sem `maxBodyHeight` não ganha landmark nem tab stop. ⚠️ **O jsdom NÃO pega isto** — a regra
    do axe depende de layout para saber que o elemento rola; a rede em jsdom é a guarda
    ESTRUTURAL de `DataGrid.test.tsx` (`getByRole('region')` + `tabindex`, validada por dois
    mutantes), e a prova de comportamento é a camada e2e.
  - **Contraste do Dashboard sobre fundo claro:** legenda do donut `text-slate-400`→**`slate-600`**
    (2,57:1 sobre card branco) e a linha "vence …" da lista de prioridades `text-slate-500`→
    **`slate-600`** (4,35:1 sobre `bg-status-error-bg` #fef2f2 nas linhas críticas). Regra geral em
    fundo CLARO: secundário mínimo `slate-600` quando puder cair sobre tinta (não `slate-400/500`).
- **Achado a11y de `/erros` corrigido em 2026-07-17 (hover tintado — não regredir):** as linhas
  `erro_api` de `/erros` (`rowClass` em `Erros.tsx`) recebem `bg-status-error-bg` (#fef2f2) e, no
  hover, escureciam para **`bg-status-error-border` (#fecaca)**. O axe **escaneia a linha sob o
  cursor**, e sobre esse fundo o texto vermelho `status-error-fg` (#b91c1c) dava só **4,47:1**
  (< 4,5) — vermelho-sobre-vermelho é intrinsecamente baixo. **Fix:** o hover passou a ser um **anel**
  (`hover:ring-1 hover:ring-inset hover:ring-status-error-border`), mantendo o fundo SEMPRE em
  `#fef2f2`, onde todo texto passa AA (status-error-fg 5,9:1 · gray-600 6,9:1); espelha o estado
  `selected`, que já usa o mesmo ring. A célula `source_file` também subiu `text-gray-500`→
  **`text-gray-600`**. **Regra:** em linha de fundo tintado, o **hover não deve escurecer o fundo**
  (usar ring) — ou o texto colorido sobre o hover reprova. Guard jsdom `contrast-usage.a11y.test.ts`
  travado com os pares reais (`gray-600`/`status-error-fg` sobre `status-error-bg`).

---

## Padrão de execução e robustez técnica

**Fonte completa: [docs/padrao-execucao.md](docs/padrao-execucao.md)** — ler antes de reportar
qualquer rotina como concluída. Não afirmar "está tudo ok" sem ter executado a verificação.

Resumo dos gates (detalhe no doc): **aceite** — nulos/vazios/edge cases explícitos, controle
transacional (commit/rollback, sem recurso vazado), exceção com log/rastreabilidade (nunca
`except`/`catch` vazio), validação de contratos (Zod é fonte única), e checagem de regressão
(`npm test`/`pytest`). **Padrões por stack** — Python, TS/React 19/Next 16, PostgreSQL/Supabase,
Firebird 5 (`fdb`), DW/ETL idempotente e PowerShell. **Fechamento** — autorrevisão adversarial
("o que quebra isto?") + escopo reforçado em alto risco (migrations, transação, ETL, concorrência,
deploy manual — nunca `deploy-prod.ps1` sem pedido).

---

## Autenticação (Supabase Auth)

O acesso às rotas internas (`/emails`, `/consulta`, `/erros`) exige login.

- **Sem auto-cadastro**: usuários criados apenas pelo admin no Supabase Dashboard
  (`Authentication → Users → Add user`, com "Auto Confirm User" marcado).
  `supabase.auth.signUp()` nunca é chamado pelo frontend.
- **Alterar o e-mail de um usuário — use a Admin API, NUNCA `UPDATE` em `auth.users`
  (não regredir):** o e-mail vive em **dois lugares** (`auth.users.email` e
  `auth.identities.identity_data->>'email'`); um `UPDATE` via SQL atualiza só o primeiro e
  deixa a identidade inconsistente. O caminho correto é
  `PUT /auth/v1/admin/users/:id` (ou `auth.admin.updateUserById`) com
  `{ email, email_confirm: true }` — o `email_confirm` pula a confirmação por link, exigida
  de outra forma pelo "Secure email change" (ON neste projeto). **Preservado
  automaticamente:** o `id` (UUID) não muda, então senha, `app_metadata.password_changed`,
  grupo (`user_profile.group_id`) e a autoria das contas (`created_by`/`updated_by`/
  `status_changed_by`) sobrevivem intactos. **O que EXIGE atenção** são as duas regras que
  casam por **TEXTO** do e-mail, não por UUID: (1) a RLS de `/emails` e `/erros`
  (migration 078) compara `lower(sender_email) = lower(auth.email())` — um usuário de grupo
  com `sees_only_own_accounts` (hoje só **Comercial**) **perde de vista** os e-mails enviados
  do endereço antigo; (2) `resolve_user_for_account(sender_email)` deixa de casar o endereço
  antigo, então contas históricas seguem apontando para o dono já resolvido (o `created_by`
  é UUID, não muda), mas convém rodar a **re-varredura** descrita em "Visibilidade de contas
  por dono" se houver linhas com o endereço antigo. Antes de trocar, meça o impacto:
  `SELECT count(*) FROM email_control WHERE lower(sender_email) = '<e-mail antigo>'` (idem
  `email_processing_errors` e `financial_account_control`). O usuário passa a **logar com o
  e-mail novo, com a mesma senha**; peça logout/login para a sessão refletir a mudança.
  Aplicado em 2026-07-17: `lucas@otimotex.com.br` → `lucas@lebianco.com.br` (grupo Diretor,
  sem `sees_only_own_accounts` e com 0 linhas casando o endereço antigo → impacto nulo).
- **Quatro telas** (`apps/frontend-vite/src/pages/auth/`): `LoginPage` → `signInWithPassword`,
  `ForgotPasswordPage` → `resetPasswordForEmail`, `ResetPasswordPage` → `updateUser`,
  `ChangePasswordPage` → `updateUser` (troca obrigatória no 1º acesso).
- **Troca de senha OBRIGATÓRIA no 1º acesso (`/auth/change-password`):** o usuário criado
  pelo admin entra com uma senha temporária e é forçado a definir a sua própria antes de
  acessar qualquer rota. Mecânica por **marca POSITIVA** `password_changed` em **`app_metadata`**
  (`PASSWORD_CHANGED_META_KEY` + helper `mustChangePassword` em `@sheild/shared`): a marca só
  é gravada quando o próprio usuário troca a senha; **ausência da marca = senha ainda é a
  temporária → força a troca**. Cobre QUALQUER caminho de criação (Dashboard **ou**
  `POST /api/users`), pois usuário novo nunca tem a marca. `ProtectedRoute` redireciona para
  `/auth/change-password` enquanto a marca faltar (lê `user.app_metadata`); `ChangePasswordForm`
  faz `updateUser({ password })` e, em seguida, **`POST /api/users/me/password-changed`**
  (`requireAuth` → `userService.markPasswordChanged` via Admin API) + `refreshSession()` —
  sem deslogar, segue para `/consulta` (o `TOKEN_REFRESHED` atualiza o `AuthContext`). É a
  diferença para o `ResetPasswordForm` (fluxo "esqueci a senha": vem de link de e-mail e
  **desloga** ao final).
  **`app_metadata` é SERVER-CONTROLLED (não regredir — achado S1-1):** só é gravável via Admin
  API/`service_role`, então o usuário não consegue forjar a marca e pular a troca. **Nunca**
  voltar a marcar/ler em `user_metadata`, que é client-writable — era exatamente o furo que
  tornava a "troca obrigatória" cosmética.
  **Usuários existentes** (anteriores à correção) foram marcados via **backfill** em
  `auth.users.raw_app_meta_data` (`password_changed: true`) — só usuários NOVOS são forçados;
  quem ficou com a marca antiga em `raw_user_meta_data` é forçado a trocar uma vez.
  **Criar usuário pelo Dashboard:** Authentication → Users → Add user + "Auto Confirm User";
  NÃO definir `password_changed` no metadata (a ausência é justamente o que força a troca).
- Estado de sessão: `AuthContext`/`useAuth` (`apps/frontend-vite/src/contexts/AuthContext.tsx`),
  via `supabase.auth.getSession()` + `onAuthStateChange`. Ao restaurar, primeiro aplica o
  early-out de inatividade (`isIdleExpired`, ver abaixo); se não expirou, valida a sessão no
  servidor com `getUser()`: 401/403 → desloga; falha de rede → mantém otimisticamente.
- **Persistência da sessão (storage híbrido — "Lembrar-me")**: `supabaseClient.ts` usa
  `storage: hybridAuthStorage` (`src/lib/authStorage.ts`), que roteia o token pelo checkbox
  "Lembrar-me" via flag `pag:remember` no localStorage (`'1'`/`'0'`): **marcado →
  `localStorage`** (sobrevive ao fechar o navegador), **desmarcado → `sessionStorage`**
  (reabrir sempre exige login). `LoginForm` chama `setRememberPreference(remember)` antes do
  `signIn`; o checkbox **inicializa refletindo a última preferência salva**
  (`getRememberPreference` no `useState`) — desmarcado na primeira vez e, uma vez marcado,
  permanece marcado nas próximas sessões até o usuário desmarcar. Refresh (F5) na mesma aba
  mantém em ambos os casos.
- **Logout por inatividade (teto de 30 min, vale em ambos os modos)**: `useIdleLogout`
  (`src/hooks/`) desloga após `VITE_SESSION_IDLE_MINUTES` sem atividade (padrão 30 min).
  Marcador de atividade em `localStorage` (`pag:last-activity`, compartilhado entre abas);
  reiniciado no `SIGNED_IN`, limpo no `SIGNED_OUT`. O helper `isIdleExpired(timeoutMs)`
  (exportado do mesmo hook) é usado no `AuthContext.init()` para deslogar já na reabertura
  quando o período ocioso herdado expirou — assim "Lembrar-me" mantém a sessão por **no
  máximo 30 min** entre reaberturas, sem flash de conteúdo protegido.
- **Suspensão durante processamento**: `suspendIdleLogout()`/`resumeIdleLogout()`
  (contador no `useIdleLogout`) pausam o teto de inatividade enquanto a leitura de
  e-mails roda (`Emails.handleRead` suspende no início e retoma no `finally`, ambos os
  modos). Evita logout no meio de um processamento longo; `resume` reinicia a janela.
- Rotas protegidas: `ProtectedRoute.tsx` redireciona para `/auth/login` sem sessão.
- RLS: migration `015` trocou policies de leitura de `TO anon` para `TO authenticated` —
  `services/supabase.ts` envia `access_token` no header `Authorization` (além do `apikey`).

## Arquitetura e fluxo de dados

Monorepo (npm workspaces): `apps/frontend-vite` (SPA interno, React 19/Vite 8/TS 6, :5173),
`apps/api-backend` (Next 16/TS, camada de dados, :3000), `apps/portal-next` (portal
público, Next 16, :3002), `packages/shared` (Zod) + camada Python (`server/`, `skills/`).

```
IMAP (Locaweb SSL)                  apps/frontend-vite (React+Vite TS, :5173)
      │                                        │
      │                          ┌─────────────┼────────────────────────────┐
      │                          │ /emails     │ /consulta      /erros       │
      │                          │ email_control  financial_account_control  errors   │
      │                          │   fetch direto Supabase REST              │
      │                          │   (apikey: anon + Authorization: token)   │
      │                          └─────────────┼────────────────────────────┘
      │                                        │ POST /read/start + GET /progress (poll)
      │                                        ▼  (proxy /api → Flask :8000)
read_emails.run_reader() ◄───────── server/app.py (Flask, porta 8000)
      │                                        ▲
      │ por e-mail:                            │ ponte HTTP (lib/python-bridge.ts)
      │  1. deduplica via email_control.message_id (UNIQUE) — pula já vistos
      │  2. SEM keyword no assunto → registra como 'ignorado' (sem baixar/extrair)
      │  3. COM keyword → salva PDF em data/pdfs_inbox/  apps/api-backend (:3000)
      │  4. in-process → extract_pdf.extract_to_csv (Claude API: pdf_text ou pdf_vision)
      │  5. UPSERT em email_control  +  fallback CSV em data/csv_output/
      ▼
Supabase (PostgreSQL)  ── financial_account_control (dados extraídos)
                       ├─ email_control     (controle/dedup)
                       ├─ email_processing_errors (log de falhas)
                       └─ supplier          (fornecedores — auto-criados + curadoria; preservado)
```

> **Topologia de portas (dev):** o frontend (`:5173`) chama o Flask (`:8000`) **direto**
> via proxy `/api` para a leitura de e-mails. A Next API (`:3000`) é camada de dados
> independente (CRUD futuro) e expõe a mesma ponte ao Flask; não intercepta o caminho
> atual do frontend.
>
> **Ponte com timeout (`lib/python-bridge.ts`, S3-1 — não regredir):** `triggerReader`/
> `probePythonHealth` passam `AbortSignal.timeout(...)` no `fetch` ao Flask — um Flask travado
> (IMAP pendurado) **não** pendura o handler Next junto. Teto de **300s** na leitura
> (`PYTHON_BRIDGE_TIMEOUT_MS`, a leitura síncrona real leva minutos) e **5s** no health; o timeout
> vira `PythonBridgeError(504)` (indisponível segue `502`). Teste em `lib/python-bridge.test.ts`.

## Chat de IA (Fases 0–3 APLICADAS e validadas em produção)

Chat conversacional embarcado no app para análise **read-only** dos dados de contas a pagar
(perguntas em linguagem natural → texto + tabela). **Desenho, histórico de cada fase, os code
reviews e as medições estão em
[docs/arquitetura-chat-ia-pagamentos.md](docs/arquitetura-chat-ia-pagamentos.md)** — §13 Fase 0 ·
§16 Fase 1 · §18 Fase 2 · §19 code review · §20 Fase 3 e a primeira execução real. **Ler antes de
implementar qualquer parte.** Aqui ficam só os invariantes.

**Estado:** a migration **098** criou o schema `analytics` (2 views, funções de tool calling,
`ai_chat_log` com RLS); o gateway vive em `apps/api-backend/lib/ai-chat/`
(`tools.ts` · `errors.ts` · `gateway.ts` · `log.ts` · `model.ts` · `rate-limit.ts` · `gate.ts` ·
`session.ts` · `sse.ts`) + `app/api/ai-chat/route.ts` e `app/api/ai-chat/stream/route.ts`;
a UI é o widget global do `frontend-vite`. **Validado em produção em 30/07/2026** (§20.9): 5
perguntas reais, 2 usuários, `error IS NULL` em todas, 4 tools distintas exercitadas e
`cache_read_input_tokens > 0` em 5 de 5. Pilares: **nunca `service_role` no caminho de leitura** ·
**tool calling** sobre funções de negócio como via primária · log de toda interação para auditoria.

> ⚠️ **São 12 tools, não 6.** As 6 da Fase 1 + `demonstrativo_despesas` (104) + `buscar_emails`
> (106) + `documentos_fiscais` (108) + `auditoria_eventos` e `auditoria_resumo` (118) +
> `pontualidade_pagamento` (121). Menções a "6 funções" no doc de arquitetura descrevem a Fase 1 e
> valem como histórico; a lista viva é `lib/ai-chat/tools.ts`, travada por teste.

> ✅ **RECORTE DA RLS PROVADO (2026-08-12), com usuário real do grupo Comercial.** A prova estava
> adiada até a forma do gate ser decidida (item 8.3); com ela fechada, foi executada e passa nas
> três condições — bruna@lebianco.com.br: `vw_payables` **830 → 5**, batendo **exatamente** com o
> oráculo `count(*) WHERE created_by = <uid>` = 5; `analytics.resumo_situacao()` (a **tool**, não
> só a view) **R$ 12.581.149,54 → R$ 10.004,70**; `fiscal_document` 293 → 0 (coerente com a regra
> já registrada — quem envia CT-e é a transportadora). 🔴 **Duas armadilhas, se for refazer:**
> rodar tudo num **único `DO $$`** (o MCP pode embrulhar cada chamada numa transação própria, e aí
> o `SET LOCAL ROLE` da 1ª sumiu na 2ª — a medição volta a ser como `postgres`, que **ignora a
> RLS**, e "prova" que não há recorte); e assertar **`auth.uid() = <uid>` ANTES de tudo**, senão
> claims malformadas zeram todas as contagens e o zero é lido como recorte.

> **A `ANTHROPIC_API_KEY` do `.env` da RAIZ NÃO vale para a Next API (não regredir):** o Next
> carrega env do diretório do próprio app, então a chave tem de estar em
> `apps/api-backend/.env.local` (o `.env` da raiz é do pipeline Python). Até 2026-07-30 ela só
> existia na raiz — e por isso a rota devolvia **500 em dev também**, não apenas na Vercel. O
> `.env.example` do app documenta a chave + `ANTHROPIC_MODEL`/`ANTHROPIC_TIMEOUT_MS`.

**`analytics` está EXPOSTO no PostgREST** (Data API → Settings → Exposed schemas: `public`,
`graphql_public`, `analytics`) — passo de dashboard, feito em 2026-07-29. Se algum dia voltar
`PGRST106 Invalid schema`, a exposição foi desfeita.

> **`Content-Profile`, NÃO `Accept-Profile`, seleciona o schema em RPC (não regredir):** para
> **POST** (que é como o PostgREST expõe função), o header é **`Content-Profile: analytics`**. Com
> `Accept-Profile` a função é procurada em `public` e a resposta é **`PGRST202` — "function does
> not exist"**, que aponta para o lugar errado (parece migration não aplicada). O
> `.schema('analytics')` do supabase-js já envia o header certo; isto importa para depuração e
> para chamada manual via cURL.

**Invariantes do gateway (`lib/ai-chat/` — não regredir):**

- 🔴 **O ACESSO ao chat é opt-in POR GRUPO e imposto no SERVIDOR** (`lib/ai-chat/gate.ts`,
  migration 120). `assertAiChatAllowed(userId)` lê `user_profile → user_group.ai_chat_enabled` com
  `service_role` e devolve as cotas do grupo; grupo não liberado ⇒ **403 com mensagem curada**
  (`MENSAGEM_SEM_ACESSO`, ecoada porque 403 < 500) e a tentativa **é auditada** no `ai_chat_log` —
  "quem está pedindo acesso" é o sinal que a feature produz.
- 🔴 **`gate.ts` NÃO pode ser fundido ao `rate-limit.ts`, e é a política de FALHA que separa os
  dois:** o gate é AUTORIZAÇÃO e falha **FECHADO**; o rate limit é VOLUME e falha **ABERTO**. Sob
  um arquivo só, o refactor natural ("unificar o tratamento de erro dos dois pré-checks") vira
  bypass de autorização, sem erro e sem teste vermelho. A falha de consulta do gate lança `Error`
  **comum** (500 genérico), nunca `AiChatError` — esta classe significa "mensagem escrita para o
  usuário ler".
- 🔴 **A ORDEM na rota é dependência de DADOS, não convenção:** `assertWithinRateLimit(user.id,
  gate)` consome o retorno do gate, então inverter as linhas não compila. **Chamar o gate e
  ignorar o retorno COMPILA** (o parâmetro é opcional) e deixa a cota do grupo **inerte, sem
  sintoma** — é o defeito mais provável desta área, travado por caso próprio em `route.test.ts` e
  validado por mutante.
- 🔴 **O grupo vem de `user_profile`, NUNCA do JWT.** Medido em 2026-08-12:
  `raw_app_meta_data->>'group_id'` existe em **2 dos 13** usuários e nos **dois** diz `0` enquanto
  o `user_profile` diz `1` e `7`. Ler o claim autorizaria e negaria as pessoas erradas **sem
  levantar erro**. Guarda de ausência em `tests/test_onda8_gate_ia.py`.
- **A cota do grupo (`ai_chat_limit_per_hour`/`_per_day`, `NULL` = teto do `.env`) tem de aparecer
  na MENSAGEM do 429** — dizer "limite de 30" ao barrar na 5ª pergunta contradiz o comportamento e
  manda o suporte procurar um problema que não existe.
- **Gate de UI (`Layout` + `AuthContext.aiChatEnabled`) é COSMÉTICO** e falha **ABERTO** de
  propósito — o inverso do servidor: esconder o botão de quem tem direito por causa de um soluço de
  rede é o pior desfecho de uma camada que não protege nada. `null` = "ainda não sei" e **não**
  monta o widget; `=== true`, nunca `!== false` (que piscaria o botão para todo usuário negado, a
  maioria sob o default opt-in).
  🔴 **O embed to-one é NORMALIZADO nas DUAS pontas** (objeto **ou** array — `primeiro()` no
  `gate.ts`, `Array.isArray` no `AuthContext`). A forma é propriedade da VERSÃO do supabase-js, não
  do contrato (mesma classe do `auth.concurrency.test.ts`), e a faixa é `^2.45.0`: lendo só objeto,
  um array faria a flag virar `undefined` → `false` para **todos** e o botão sumiria da tela
  inteira, sem erro, com a API intacta — e o servidor, que normaliza, não acusaria nada. Só o lado
  do servidor tinha a guarda até o review de 2026-08-13; hoje há caso de teste para cada forma nos
  dois arquivos.
- **`getAnonClient()` + JWT do usuário, NUNCA `getSupabaseAdmin`** no caminho de dados. Só o
  **log** usa `service_role`, e é exceção deliberada: deixar o usuário auditado escrever a própria
  trilha permitiria omitir a própria pergunta (a policy da 098 o deixa **ler** só as dele).
- **Log gravado ANTES de responder e aguardado.** Em serverless a function é **congelada** no
  `return`, então `void gravarLog()` depois dele simplesmente não roda — e nada acusaria a perda.
  A pergunta que **falhou** também é auditada: é dela que sai "quais tools faltam" (§11).
  **O mapeamento de colunas é travado por teste (`lib/ai-chat/log.test.ts`):** como `logInteraction`
  **nunca lança**, um nome de coluna errado deixaria a auditoria **morta em produção** sem erro, sem
  teste vermelho e sem log. O caso central compara o payload com as colunas declaradas nas
  **migrations 098/101** (guarda cross-layer), tem asserção de sanidade do parser e é ancorado em
  `import.meta.dirname` (não `process.cwd()`, que muda conforme o vitest é invocado). Ao acrescentar
  campo ao log, migration e teste andam juntos — foi o que a **102** fez com `truncated`/`iterations`.
- **`export const maxDuration = 300` na rota.** O default da Vercel (10–15 s) mata um loop de 2–3
  iterações que funciona perfeitamente em dev.
- **Teto de 6 iterações**, e ao atingi-lo uma chamada final que **não pode usar tools**
  (`tool_choice: none`, com as tools ainda presentes — ver o bullet do fechamento) — o usuário
  recebe o que já foi apurado com `truncated: true`, em vez de um erro seco.
- **Tool calls paralelos voltam em UMA mensagem `user`**; falha de tool vira `tool_result` com
  `is_error` (nunca bloco omitido, que quebraria o pareamento), com o detalhe no log, não no modelo.
- **A data de hoje vai na MENSAGEM, não no system prompt.** No bloco cacheado, o prefixo mudaria a
  cada requisição e o prompt caching nunca acertaria — silenciosamente, sem erro.
- **`stop_reason: 'max_tokens'` marca `truncated`** e o resultado de tool tem **teto de 60 KB**,
  cortado **por registro** — JSON partido ao meio é ilegível para o modelo. Quando UM registro
  estoura sozinho (`additional_info` é TEXT sem limite), corta a string e **DECLARA** o corte
  (`JSON CORTADO`): cortar sem avisar faria o modelo ler o fragmento final como dado.
- **Streaming (`.stream().finalMessage()`)**, não `.create()`: mantém o socket ocupado num turno
  longo (timeout de proxy) **e** é de onde sai o texto em tempo real da rota SSE — ver "Streaming
  da resposta" abaixo.
- 🔴 **SÃO DUAS ROTAS PARA O MESMO RECURSO, E UM SÓ LOOP.** `/api/ai-chat` responde em JSON,
  `/api/ai-chat/stream` em SSE, e as duas chamam o MESMO `runChat` — o streaming é observação
  lateral (`ChatProgress`), nunca um segundo loop. Duplicar o loop criaria duas cópias do teto de
  iterações, do pareamento tool_use/tool_result, do acumulador de tokens e da tradução de erro.
  Sem `events`, `runChat` se comporta byte a byte como antes (travado em `gateway.test.ts`).
- 🔴 **Autenticar, validar, autorizar e auditar vivem em `lib/ai-chat/session.ts`** — nunca
  copiados entre as rotas. O modo de falha da cópia não é código feio: é a rota nova nascer **sem o
  gate de acesso**, respondendo perfeitamente bem enquanto entrega um recurso pago a um grupo sem
  direito. Guarda: `test_onda8_gate_ia.py` varre `app/api/ai-chat/**/route.ts` e exige
  `assertChatAllowed` em **todas** — rota nova entra no escopo sozinha (validada por mutante).
- **401/400 do SDK NÃO são traduzidos** (viram 500 + log): são erro de configuração/payload
  **nosso**; dizer "sessão expirada" mandaria o usuário deslogar sem efeito. Só se traduz o que o
  usuário pode **agir** — 429 (`RateLimitError`), **qualquer 5xx do provedor** (→ 503) e timeout.
- **A chamada de FECHAMENTO manda as MESMAS `tools` + `tool_choice: {type:'none'}`** — não basta
  omitir o array. Remover `tools` é mudança de DEFINIÇÃO de tool, que invalida os três níveis de
  cache (tools + system + messages) justamente na chamada de histórico mais longo.
- **O log registra os QUATRO campos de token.** `usage.input_tokens` é só o **resto não-cacheado**;
  sem `cache_read_input_tokens` não há como estimar custo nem **notar um invalidador silencioso do
  cache**, que não gera erro — só zera o número e aumenta a fatura (migration 101).
- 🔴 **O log registra QUAL MODELO serviu o turno** (`response.model`, migration 129) — e o
  `CONFIGURED_MODEL` vive em **`lib/ai-chat/model.ts`, não no gateway**. A constante é
  CONFIGURAÇÃO, e mantê-la no gateway fazia todo teste que mockasse `runChat` perder o fallback da
  auditoria com um erro que não tinha nada a ver com o que ele verificava ("No CONFIGURED_MODEL
  export is defined on the mock"). Ensinar cada mock a reexportá-la seria pior: duplicaria o valor,
  e a asserção sobre o payload passaria a comparar com uma ficção. **Configuração não fica refém do
  mock de um módulo de comportamento.**
- 🔴 **O DEFAULT de `CONFIGURED_MODEL` espelha o que roda de fato** (hoje `claude-sonnet-5`). Ele
  ficou em `claude-opus-5` enquanto dev e Vercel já rodavam Sonnet — valor que **nenhum ambiente
  usava** e que, por isso, só entraria em cena por ESQUECIMENTO da env var: exatamente quando
  ninguém está olhando, trocando o modelo em silêncio, com preço e mínimo de prefixo cacheável
  diferentes. **Ao trocar o modelo dos ambientes, trocar o default junto** — um default que ninguém
  usa é armadilha, não rede.
  ⚠️ **A suíte roda SOBRE o default:** o `vitest.config.ts` do api-backend não carrega `.env`, então
  `ANTHROPIC_MODEL` é `undefined` nos testes. Consequência: **nunca** asserte um literal de modelo
  em teste — compare com `CONFIGURED_MODEL`. O caso do aviso de caching passava por coincidência
  (o literal era igual ao default) e teria quebrado na troca, por um motivo sem relação com o que
  ele afirma.
- 🔴 **`accumulate` recebe a MENSAGEM inteira, não só o `usage`.** Mesmo motivo de o acumulador ser
  único: são dois pontos de chamada (o loop e o fechamento), e tudo que precise sair de uma resposta
  do modelo tem de sair dali. Passando só o `usage`, registrar o modelo viraria uma segunda linha a
  lembrar em cada call site — e o fechamento é justamente o que alguém esqueceria.
- **A falha leva o estado parcial até a auditoria.** Sem isso, a falha de uma pergunta que custou 5
  iterações era logada como "0 tokens, 0 tools". O `attachPartialRun` **engole a própria falha**
  (`try/catch` + log): `defineProperty` lança em erro não-extensível e, como é chamado DENTRO do
  `throw`, essa exceção substituiria o erro traduzido (429 → `TypeError` genérico). Perde-se a
  auditoria parcial, nunca o erro.
- 🔴 **TROCAR `ANTHROPIC_MODEL` pode desligar o prompt caching EM SILÊNCIO.** O mínimo de prefixo
  cacheável varia por modelo e **não é monotônico entre gerações**: 512 no Opus 5 e **1.024 no
  Sonnet 5**, mas **4.096** no Opus 4.6 e no Haiku 4.5. Abaixo do mínimo o `cache_control` é ignorado
  sem erro — só `cache_read_input_tokens` zerado e a conta subindo. **Depois de qualquer troca de
  modelo, conferir essa coluna em `analytics.ai_chat_log`.** Desde a migration **129** a conferência
  é ATRIBUÍVEL: agrupe por `model` em vez de adivinhar a data em que a env var mudou —
  `SELECT model, count(*), sum(cache_read_input_tokens) FROM analytics.ai_chat_log GROUP BY 1`.
  ⚠️ **O prefixo NÃO é constante: cresce a cada tool** (as definições entram no bloco cacheado —
  ~1,2k tokens por tool; é o outro lado de "acrescentar tool invalida os 3 níveis de cache").
  Medido: **3.653** com 6 tools (30/07) → **7.408** com 9 tools (10/08) — e 11 tools desde 11/08; dobrou em 11 dias e
  **inverteu a conclusão** sobre o risco de trocar de modelo. Por isso **não há número a decorar
  aqui**: quem vigia é **`warnIfCachingDisabled` (`lib/ai-chat/gateway.ts`)**, que roda a **cada
  turno** e emite `console.error` quando `cache_read` e `cache_creation` vêm os DOIS zerados —
  sinal seguro de que a API ignorou o `cache_control`. É aviso, não erro: a resposta ao usuário
  está certa; o que está errado é o custo. Série histórica e o raciocínio em
  [docs/arquitetura-chat-ia-pagamentos.md](docs/arquitetura-chat-ia-pagamentos.md) §19.10.

**Invariantes da camada `analytics` (não regredir):**

- **Views e funções são `SECURITY INVOKER`** — é isso, e só isso, que faz a RLS de
  `financial_account_control` (076) valer para o chat. `SECURITY DEFINER` aqui, ou `service_role`
  no gateway, seria escalada de privilégio silenciosa: o chat passaria a ver contas de todo mundo.
  Validado com o papel `authenticated` real — ester (Comercial) vê **48** contas, barbara
  (Financeiro) vê **578**.
- **O `REVOKE EXECUTE ... FROM PUBLIC` é obrigatório** em função nova do schema: o PostgreSQL
  concede `EXECUTE` a `PUBLIC` por default, então sem ele o `anon` executaria a função mesmo sem
  `USAGE` no schema. Mesma família do resíduo que a 097 limpou.
- **Despacho de parâmetro (`date_field`, `granularity`, `group_by`) é por `CASE` + `IN (...)`,
  nunca SQL dinâmico.** Tudo viaja como bind, e valor fora do domínio devolve **vazio** em vez de
  agregar errado em silêncio.
- **`cancelado` (id 9) fica fora dos totais por padrão**; "em aberto" é o set explícito
  `status_id IN (1,2,3)` (as flags `has_opened`/`has_closed` da dimensão `status` estão todas
  `false`); e **aging é por `due_date < CURRENT_DATE`, nunca pelo rótulo `status_name`** — que é
  defasado pela trigger + batch diário.
- **Âncora de teste NÃO pode ser número absoluto** — o dado deriva em 24 h (574→578 contas entre
  28 e 29/07). Usar oráculo diferencial (tool × query de controle) ou janela histórica fechada.
- **O `service_role` PRECISA de GRANT explícito para gravar `ai_chat_log` (migration 101):** a 098
  concedeu tudo a `authenticated` e **nada** ao `service_role`, que é quem escreve a trilha. Ele
  burla RLS (`rolbypassrls`) mas **não é superuser** — sem `USAGE` no schema e `INSERT` na tabela o
  write falha com `42501`, e como `logInteraction` **nunca lança**, o pilar de auditoria ficaria
  **morto em produção sem nenhum sintoma**. A 101 concede `USAGE` + `SELECT, INSERT` **só no log** —
  e **nada** nas funções nem nas views: o caminho de dados tem de passar pelo JWT do usuário.
  **Toda tabela nova em `analytics` repete esse cuidado.**

**Decisões de arquitetura que não devem ser reabertas** (fundamentação em §13/§15 do doc):

- **Acesso a dados = PostgREST + JWT do usuário, NÃO uma role `ai_readonly`** — role dedicada não
  casa policy alguma (elas são `TO authenticated` + `auth.uid()`) e cairia no default-deny, vendo
  **0 linhas**.
- **Tools são FUNÇÕES SQL (RPC) `SECURITY INVOKER`, não views filtradas** — o PostgREST só agrega
  com `db-aggregates-enabled`, **desligado por padrão no Supabase**.
- **`generate_sql` (text-to-SQL) ADIADO** — não roda por PostgREST e é o maior vetor de risco. Foi
  essa análise que expôs o resíduo de grants da **097** (`TRUNCATE` ignora RLS e estava concedido a
  `anon`/`authenticated`); já revogado, então o pré-requisito está pronto se o fallback voltar.
- **ADR-001 — sem vetores/RAG no núcleo analítico:** o cálculo é determinístico sobre linhas, então
  nada de pgvector/embeddings no caminho do número; casamento aproximado de nome de fornecedor/
  empresa usa `unaccent` + `pg_trgm` (os índices trigram já existem).
- **`payment_date` responde caixa realizado direto** (`date_field: 'pagamento'`), por decisão do
  dono do produto — ver o bloco da migration 096 na seção de banco.

**Streaming da resposta (SSE — 2026-08-14):** a espera percebida caiu de ~12 s de tela parada para
o texto surgindo conforme é gerado; **o tempo total não muda**. Protocolo em
`@sheild/shared/ai-chat-stream.ts`; transporte em `lib/ai-chat/sse.ts`; rota em
`app/api/ai-chat/stream/route.ts`; cliente em `askAiChatStream`.

🔴 **O CUSTO DO TURNO É O TAMANHO DA RESPOSTA — medido em produção (14/08, 8 turnos, Sonnet 5):**

> **latência ≈ 3,9 s fixos + ~10 ms por token de SAÍDA**

É o único modelo que se sustenta nos dados, e ele derruba as três explicações intuitivas:

- **Não é o banco.** As tools respondem em **44–230 ms** — 0,4% do turno. É o que mantém de pé a
  decisão "sem tabelas agregadas".
- **Não é o input.** O turno mais lento levou **53.437 tokens** de input não-cacheado e ainda assim
  o output sozinho explica quase toda a latência: processar entrada é paralelo, **gerar saída é
  sequencial**.
- 🔴 **Não é "a primeira pergunta", nem cold start.** Sintoma relatado e REFUTADO: a primeira de uma
  sessão custou **10,5 s** com o mesmo cache miss (`cache_criado = 14.689`); a de 53 s foi lenta
  pelo conteúdo. Cruzando o timestamp do Vercel com o `latency_ms`, o cold start é **~1 s**. Antes
  de culpar a infra, some `output_tokens × 10 ms`.
- **Trocar de modelo quase não move.** Opus 5 → Sonnet 5 cortou **9%**, não os 2–3× esperados: a
  geração dos dois é quase igual aqui (~65 × ~71 tok/s). O ganho da troca é de custo, não de tempo.

🔴 **DAÍ O TETO DE 15 LINHAS NO SYSTEM_PROMPT.** O caso real: uma pergunta trouxe **167 linhas**
(`listar_contas` 50+50 + `gasto_por_fornecedor` 67), o modelo listou todas, gerou **4.970 tokens** e
o turno levou **53 s** — contra 6–15 s dos demais, que geram 200–1.000. O prompt pedia "tabela
enxuta" sem nenhum teto. ⚠️ **O teto vale para a LISTAGEM, nunca para a RESSALVA** — cobertura,
balde parcial e `total_encontrado` são uma frase e valem mais que a tabela inteira; apertar a
concisão é exatamente o que faria o modelo sacrificá-los, desfazendo o que as ondas 6 a 9
instalaram. A guarda de `regression.test.ts` trava as **duas** metades (validada por mutante: tirar
só a cláusula da ressalva — a "otimização" plausível — deixa o teste vermelho).

✅ **FUNCIONOU, e o número está aqui para que ninguém o reverta por achar que não fazia diferença.**
A MESMA pergunta, depois do deploy: **53,2 s → 25,1 s (−53%)**, **4.970 → 2.102** tokens de saída,
**167 → 15** linhas exibidas. O modelo de latência previu **24,9 s** contra os **25,05 s** medidos
(erro de 0,6%) — 3ª validação independente da equação. ⚠️ **A próxima alavanca seria a LARGURA, não
a altura:** dos 2.102 tokens restantes, ~1.100 são as 15 linhas (a ~70 tokens cada, com razão
social por extenso e 8-9 colunas) e ~1.000 são introdução, ressalvas e fechamento. Enxugar as
colunas levaria o turno a ~18-20 s. **Deliberadamente NÃO feito:** o ganho (~5-7 s) é pequeno perto
do desta rodada, e menos coluna é menos informação — é decisão de conteúdo, não de desempenho.

Invariantes do transporte:

- 🔴 **A FRONTEIRA DO STATUS HTTP.** Tudo que pode ser recusado ANTES do corpo abrir (401/400/422
  da sessão, **403 do gate, 429 da cota**) é recusado com JSON e status, igual à rota irmã — por
  isso `assertChatAllowed` fica FORA do `ReadableStream`. Depois do primeiro byte o status já foi
  enviado e a falha vira evento `error` (com `status` dentro, para o cliente saber o que dá para
  tentar de novo).
- 🔴 **A regra de eco é a MESMA, pelo MESMO helper** (`describeClientError`, extraído de
  `failFromError`): 5xx não-curado vira mensagem genérica nos dois transportes. Uma segunda cópia
  dessa regra é o pior lugar possível para divergir — quem escrevesse a versão do SSE por conta
  própria acabaria ecoando detalhe interno sem que nada acusasse.
- 🔴 **Auditoria ANTES de `controller.close()`**, não antes do `return` — em serverless a function
  é congelada quando o corpo termina, então gravar depois de fechar é gravar em nada. É o §17.3
  traduzido para streaming.
- 🔴 **`SseWriter` nunca lança.** `controller.enqueue` **lança** quando o cliente já fechou — o
  caminho NORMAL de "Parar" e de fechar a aba. Se subisse, abortaria o turno de dentro de um
  callback, em ponto arbitrário do loop, e **pularia a auditoria** do que já foi gasto. Mesmo
  motivo do `safeEmit` no gateway (validado por mutante nos dois).
- 🔴 **`text_start` DESCARTA o buffer.** O modelo escreve um preâmbulo, pede a ferramenta e só
  então redige — sem o reinício os dois apareceriam grudados e a tela divergiria do `answer`, que
  é só o texto da última mensagem.
- 🔴 **Stream sem `done` NÃO promove o texto parcial a resposta.** O `answer` canônico é o que vai
  para o histórico enviado ao modelo na pergunta seguinte; um texto truncado ali envenenaria a
  conversa seguinte em silêncio. Falta o `done` ⇒ erro de conexão interrompida.
- 🔴 **A POLÍTICA DE FALLBACK É ESTREITA.** Só cai para a rota JSON em **404** (deploy sem a rota)
  e em **200 sem `text/event-stream`** (proxy transformou o corpo) — casos em que nada foi cobrado.
  403/429/5xx sobem como erro: reenviar faria a MESMA pergunta rodar duas vezes, cobrando dois
  turnos por uma recusa que a segunda tentativa vai reencontrar.
- **Acessibilidade:** chips e texto parcial ficam `aria-hidden` — eles mudam dezenas de vezes por
  turno dentro do `role="log"` e seriam reanunciados a cada token. Quem usa leitor de tela recebe a
  resposta uma vez, completa, quando ela vira `ChatEntry`; o progresso vem do rótulo textual
  (`rotuloDoProgresso`), que muda pouco e diz algo verdadeiro.
- ⚠️ **Headers `no-transform` + `X-Accel-Buffering: no` não são decoração:** um proxy que bufferize
  anula o streaming por completo, e o sintoma ("funciona em dev, não em produção") é caro porque o
  código está certo dos dois lados.

**Widget do assistente (`frontend-vite`):** `organisms/AiChatWidget.tsx` (botão flutuante + **o
estado da conversa**) montado **uma vez no `Layout`**, e **só quando `aiChatEnabled === true`**
(migration 120) — em nenhuma tela de auth, e em nenhuma tela para grupo sem acesso;
`organisms/AiChatPanel.tsx` (side sheet apresentacional, `lazy()`) usa `<dialog>` +
`showModal()`, herdando role/aria-modal, trap de foco, Esc e retorno de foco nativos. A resposta é
markdown renderizado por `lib/markdownLite.ts` + `molecules/MarkdownMessage.tsx`, **JSX puro, sem
`dangerouslySetInnerHTML`** e sem dependência nova. Cliente em `services/aiChat.ts`.

- 🔴 **CANCELAMENTO É PONTA A PONTA (§20.8).** "Parar"/"Nova conversa" abortam um `AbortController`;
  `askAiChat` combina esse signal com o teto de tempo via **`AbortSignal.any`** (preserva o `reason`,
  que distingue cancelamento de timeout); a rota repassa **`request.signal`** ao gateway, que checa
  `throwIfAborted` no limite de cada iteração e manda `{ signal }` ao modelo. Sem isso, desistir era
  só fechar o painel — e o servidor seguia gastando tokens. **Quem decide se foi aborto é o SIGNAL,
  não o tipo do erro:** no SDK 0.115.0 `APIUserAbortError` tem `name === 'Error'`, e `instanceof` num
  membro do namespace **lança** se a classe não existir — dentro de um `catch`, essa exceção
  substituiria o erro real. Cancelamento é **aviso, não erro**: vira `Alert variant="info"` no
  cliente (daí `feedback: {variant,text}`, não `error: string`) e `AiChatAbortedError` (**499**) no
  servidor, logado COM o custo parcial — os tokens gastos não voltam.
- 🔴 **GUARDA DE GERAÇÃO (`generationRef`)** — incrementada em "Nova conversa"; resposta de geração
  anterior é **descartada**. Sem ela, resetar a conversa com requisição em voo anexa a resposta a
  uma conversa **vazia** (balão sem pergunta, histórico começando em `assistant`, sem erro nenhum), e
  a janela é larga porque a requisição leva dezenas de segundos. O `setLoading(false)` fica **fora**
  da guarda, senão o painel trava em "Consultando…". Validado contra mutante.
- **`buildHistory` só envia PARES completos** (máx. 8 mensagens) e **NORMALIZA** para
  `{role, content}`: a rota rejeita com **422** histórico ímpar ou fora da alternância, e a conversa
  em tela termina em `user` em dois estados normais (aguardando resposta e após falha). É isso que
  faz o "Tentar novamente" não virar 422. **`ChatEntry` mora no SERVIÇO** (`extends AiChatMessage`),
  não no painel — senão o widget importaria tipo de um chunk que ele carrega sob demanda.
- **NÃO existe trava de reentrância — é intencional (§20.8b):** com `loading` o painel desabilita
  campo, envio e "Tentar novamente" e nem renderiza as sugestões; a exclusão mútua é **estrutural**.
  Ao criar um call site novo de envio (atalho, deep link), respeite o `loading`.
- **Os DOIS caminhos de fechamento são fiação não-óbvia — têm teste, mantenha:** Esc vem do evento
  **`cancel`** do `<dialog>`; o clique no backdrop vem de um listener **NATIVO** que compara
  `e.target === dialog` — não `onClick` no `<dialog>`, que é o smell S1082 e ainda fecharia ao
  clicar no conteúdo.
- **Trade-off assumido:** o `showModal()` deixa a página de fundo inerte — não se consulta o grid de
  `/consulta` com o chat aberto; é o preço do trap de foco/Esc nativos. O footer de `/consulta` leva
  `pl-1 pr-20` (não `px-1`) para o botão flutuante não cobrir o "Carregar mais".

**Alicerce verificado (não regredir):** `canSeeConta` — e o gateway, que reusa o padrão — chama
`.setHeader()` sobre o **singleton** `getAnonClient()`. O postgrest-js isola as requisições por
**duas** camadas (`from()` clona os headers; `setHeader` faz copy-on-write), então não há vazamento
de token entre requisições concorrentes. Isso é garantia da **versão instalada**, não do contrato
público, e a falha seria silenciosa (um usuário lendo a conta de outro, sem erro) — por isso o
invariante está travado em `apps/api-backend/lib/auth.concurrency.test.ts`, em arquivo separado de
`auth.test.ts` (que mocka o SDK inteiro e portanto **não** cobre isto). Validado contra o mutante
das duas camadas sabotadas.

> **Duas lições de método que saíram deste módulo e valem para o projeto todo:**
> **(1)** os dez achados dos dois code reviews foram encontrados conferindo o código contra o
> SISTEMA REAL (catálogo do Postgres, tabela de invalidação de cache da API, mutantes no SDK
> instalado), **não** relendo o código; e **todo `catch`/teto/fallback novo merece uma sonda que
> force o caminho ruim** — código defensivo é a categoria que menos aparece em teste, porque só roda
> quando algo já deu errado. **(2)** `beforeEach(() => mock.mockReset())` **com corpo de expressão**
> é armadilha: `mockReset()` devolve o próprio mock, o Vitest trata retorno de função num hook como
> **teardown** e chama o mock ao fim do teste; com `mockRejectedValue` ativo isso vira rejeição não
> tratada e o teste falha exibindo a mensagem do erro, não uma asserção. Hook de reset sempre em
> **bloco**.

## Roadmap de enriquecimento de dados — 9 ONDAS (1–4 e 6–7 CONCLUÍDAS; próxima é a 5)

Plano completo em **[docs/roadmap-enriquecimento-dados.md](docs/roadmap-enriquecimento-dados.md)** —
**ler antes de mexer em qualquer item abaixo.** Objetivo: ampliar a acurácia e a gama de perguntas
do chat **sem quebrar o pipeline de extração**. Execução **uma onda por vez**, cada uma cumprindo o
protocolo de 5 passos da §3 do plano (baseline → migration idempotente → não regredir o pipeline →
verificação por oráculo diferencial → fechamento). Migrations usadas até aqui: **103–125** — a Onda
6 ocupou **111–115** (o plano dizia 112–116, mas a 109/110 foram consumidas por trabalho não
relacionado; deixar buraco na sequência seria pior). A **116** corrigiu a truncagem silenciosa das
duas funções da 115 (achado B1 do review de 2026-08-10), a Onda 7 deslocou para **117–118** e a
Onda 5 (item 5.3) saiu na **119**.
> 🔴 **Número de migration NÃO se reserva com antecedência.** O plano reservava 109/110/111 para a
> Onda 5 e os três foram consumidos por outro trabalho antes de ela começar. Confira sempre a
> última aplicada; a tabela de um roadmap escrito há meses não é fonte de verdade para isso.

| # | Onda | Entrega |
|---|---|---|
| 1 | ✅ **CONCLUÍDA** (migrations **103/104**) | 9 colunas na `vw_payables` · filtros de compliance · eixo `tipo` · **7ª tool `demonstrativo_despesas`** · somas de juros/descontos · **rate limit** · 15 sugestões em 4 temas · bateria de regressão |
| 2 | ✅ **CONCLUÍDA** (migrations **105/106**) | `body_full` + `body_search` (tsvector) + GIN · backfill de 383 corpos · reader grava o corpo completo · **8ª tool `buscar_emails`** — deploy do `read_emails.py` **APLICADO e verificado em prod** |
| 3 | ✅ **CONCLUÍDA** (migrations **107/108**) | `fiscal_document` pela **chave de acesso** (CT-e 57 · NF-e 55 · CF-e 59 · NFC-e 65), sem LLM · `fiscal_key.py` · gancho no Passo 1 · purga preservando o PDF fiscal · backfill de 172 documentos · **9ª tool `documentos_fiscais`** — deploy **APLICADO e verificado em prod** (27/27, 2026-08-01) |
| 4 | ✅ **CONCLUÍDA** (sem migration, sem deploy) | `scripts/varredura_historica.py` — passada única e estritamente aditiva na caixa postal: **+70 corpos · +7 chaves fiscais · +4 objetos**, 0 falhas, contas intocadas. 🔴 **A premissa caiu: a INBOX tinha 264 de 1.166 e-mails — 0 CT-e recuperados** |
| 5 | ⚠️ **PARCIAL — 5.3 CONCLUÍDO** (migration **119**) | conteúdo do CT-e (rota · peso · NF transportada · destinatário · frete) **sem LLM**, da fatura agregada: `cte_content.py` + gancho no reader + backfill de **57 CT-e** + `documentos_fiscais` com filtro `rota`. 🔴 **5.1/5.2 (itens de NF-e) SUSPENSOS por falta de população — 15 DANFEs medidos** |
| 6 | ✅ **CONCLUÍDA** (migrations **111–116**) | `dim_date` + feriados · `competence_month` · `days_late` · `extraction_confidence` · `installment_number`/`installment_base` (o **`installment_total` do plano NÃO existe na origem**) · `analytics.fornecedores_recorrentes` e `analytics.parcelamentos` · 5 colunas novas na `vw_payables` · **116** = correção do achado B1 (truncagem silenciosa) |
| 7 | ✅ **CONCLUÍDA** (migrations **117/118**) | trilha de auditoria: `audit_log` populada por trigger em `financial_account_control` **e `supplier`** · vazamento da tabela fechado · ator propagado por header · **10ª e 11ª tools** (`auditoria_eventos`, `auditoria_resumo`) |
| 8 | ✅ **CONCLUÍDA** (migration **120**) | rate limit (Onda 1) · few-shot + as 2 lacunas de capacidade declaradas no prompt · 2 mapeamentos errados da bateria corrigidos · **gate de acesso ao chat por GRUPO** (`user_group.ai_chat_enabled` + cota própria), imposto no servidor e auditado — mais a **prova do recorte de RLS** que a onda devia |
| 9 | ⚠️ **1 de 7 itens** (migration **121**) | onda CONDICIONAL — os 7 gatilhos foram **medidos** em 2026-08-13 e só um ocorreu: **pontualidade de pagamento** (12ª tool `pontualidade_pagamento`). Seguem sem evidência: CF-e/NFC-e (0 documentos), NFS-e (1 conta), text-to-SQL (0 pergunta descoberta no log), agregados (2–7 ms contra teto de 500), receitas/DRE (0 entradas) e conciliação (sem integração) |

**Decisões que NÃO devem ser reabertas sem evidência nova** (todas medidas em 2026-07-31):

- **SEM tabelas agregadas / materialized view.** As 6 tools respondem em **3–25 ms** (fato: 609
  linhas, 2,4 MB), contra **8–30 s** de latência real do chat: o SQL é **0,04–0,3%** do tempo, o
  resto é a Claude API. Zerar o banco não mudaria a latência percebida. Gatilho para reabrir:
  alguma tool passar de **~500 ms** warm.
  ✅ **Reconfirmado em 2026-08-14 com 12 tools e medição em produção** (não mais em bancada): as
  tools levaram **44–230 ms** em turnos de 5,9 a 53 s — **0,4%** do tempo. E a decomposição
  registrada em "Streaming da resposta" fecha a porta de vez: o que domina é o número de tokens
  **gerados**, que nenhuma pré-agregação reduz.
  ✅ **Remedido em 2026-08-13, quando a pergunta voltou como "comparativos semanais para acessos
  mais rápidos":** a série semanal por emissão custa **40 ms cold e 11 ms warm** — 45× de folga
  contra o gatilho. A granularidade `semana` **já existe** em `gasto_por_periodo` desde a Fase 1,
  então "comparativo semanal" também não era dado novo. 🔴 **O que faltava não era velocidade nem
  série: era a RESSALVA** — e virou a migration **124** (balde parcial). Antes de reabrir a
  decisão por desempenho, meça: quem vigia esse gatilho todo mês é a skill `roadmap-gatilhos`
  (`tabelas_agregadas`), e o custo do outro lado é 2ª fonte de verdade + job de atualização +
  pré-agregado que teria de respeitar `sees_only_own_accounts` — recorte por usuário e
  pré-agregação por linha não convivem.
- **SEM tabela de dados de boleto** — já estão na fato (`barcode`, `nosso_numero`, juros,
  descontos, `amount_charged`); duplicar criaria 2ª fonte de verdade.
- **DRE completo DESCARTADO** (decisão do usuário — opção B): o sistema tem **0 receitas**, é
  contas a **pagar**. No lugar, a tool **`demonstrativo_despesas`** (Onda 1), com esse nome — não
  "DRE". Reabrir só via integração de receitas do Firebird (Onda 9).
- **DPO (o indicador contábil) segue FORA — a PONTUALIDADE entrou na Onda 9.** O que adiou o item
  era o backfill da 096 (450 de 463 pagas com `payment_date = due_date` por artefato, 2 dias de
  histórico real); medido em 2026-08-13 há **218 contas com carimbo real em 3 semanas contínuas**,
  e a tool da 121 mede só essa população. 🔴 **O artefato não sumiu, foi CERCADO:** agregar
  `days_late` sem o corte de `analytics.payment_date_confiavel_desde()` reproduz o mesmo "atraso
  médio zero" falso. E **DPO continua não sendo calculável** — exige o passivo contábil e o CMV da
  empresa, não o que chegou por e-mail; o prompt nega o nome em vez de ignorá-lo.
- **Cupom fiscal NÃO eletrônico fora** — sem chave, sem estrutura, **0 ocorrências**.
- **`amount_paid` e `approved_by` automáticos fora** — trigger inventaria dado.
- **`is_overdue` / aging como COLUNA fora** — muda com o tempo sem UPDATE (o bug da 095).

**O que a Onda 1 entregou e os invariantes que ela criou (não regredir):**

- **7 tools** (as 6 da 098 + `demonstrativo_despesas`). A lista é travada em `tools.test.ts`:
  acrescentar tool invalida os 3 níveis de prompt cache, então tem de ser deliberado.
- **`demonstrativo_despesas` SEMPRE FECHA** — as linhas (Custos de Mercadorias · Custos de
  Importação · Despesas Fixas · Despesas Variáveis · Tributos · Não classificado) são mutuamente
  exclusivas e exaustivas, e a função devolve a própria linha "Total de saídas" para o modelo
  **não somar**. Verificado contra a tabela base: R$ 8.854.971,36 dos dois lados. **`Não
  classificado` é LINHA, não filtro** — um demonstrativo que omite o que não classificou não
  fecha, e número que não fecha destrói a confiança em todos os outros. **NÃO é um DRE** (0
  receitas) e o nome é deliberado.
  🔴 **"Custos de Importação" (`chart_subgroup_type_id = 9`) foi ACRESCENTADO pela migration 127
  (2026-08-14) — NAQUELE MOMENTO a lista de linhas não era fechada por natureza, era fechada pelo
  `CASE` da função, e ele precisava ser ensinado toda vez que o catálogo `financial_type_group`
  ganhasse um tipo novo.** O tipo 9 foi criado direto no banco (não há CRUD para
  `financial_type_group`) e a função, escrita em 31/07, não sabia dele: 23 contas (R$ 1.900.565,19,
  grupo de natureza Custos) caíam em "Não classificado" e 6 contas (R$ 633.683,10, grupo de
  natureza Passivo) eram contadas como "Tributos" — inflando essa linha com custo de importação,
  não tributo. **Achado pelo próprio assistente de IA**, que sinalizou a fatia de "Não
  classificado" como incomum numa resposta ao usuário. `gasto_por_classificacao` com
  `group_by='tipo'` **nunca teve esse problema** — lê o nome do tipo dinamicamente do catálogo, sem
  `CASE` fechado; só `demonstrativo_despesas` (e o prompt do chat, que enumerava as linhas)
  precisou de correção. ✅ **A versão DINÂMICA foi implementada NO MESMO DIA, pela migration 128**
  (a função passou a ler `financial_type_group.demonstrativo_line_order`/`demonstrativo_line_label`
  — ver "Banco de dados" → entrada da 128) — a frase "plano futuro, não implementada" que este
  bullet trazia originalmente **não vale mais**; mantida aqui só como registro histórico da decisão
  tomada na 127, revertida horas depois na mesma sessão.
- **A linha "Tributos" sai da NATUREZA do grupo (`= 4`)**, nunca de ids de subgrupo hardcoded.
- 🔴 **`gasto_por_fornecedor` é um RANKING TRUNCADO** (máx. 100 de 165 fornecedores): **somar suas
  linhas NÃO dá o total do período** — subestima em silêncio. Está proibido explicitamente no
  SYSTEM_PROMPT; para totais, `gasto_por_periodo` ou `demonstrativo_despesas`.
- 🔴 **FUNÇÃO QUE AGRUPA POR PERÍODO DECLARA O BALDE PARCIAL** (migration **124**). Os baldes das
  duas bordas quase sempre cobrem menos dias que os do meio — o primeiro é cortado por
  `p_date_from`, o último pelo **presente**. `gasto_por_periodo` devolve `is_partial`,
  `days_covered` e `days_total`, e o prompt manda **dizer quantos dias** o balde cobre. Medido: na
  série semanal por emissão, a semana corrente tinha **42 contas em 4 dos 7 dias** ao lado de 84 da
  anterior — sem a ressalva, "queda de 50%", que é falso. É a mesma família de
  `fora_da_cobertura` (121) e de `total_encontrado`: **o número está certo, e a ausência da
  ressalva faz o leitor concluir o oposto**. ⚠️ Em `date_field='vencimento'` o dia futuro **não**
  torna o balde parcial — ali são contas a vencer, dado real. E o "hoje" é
  `America/Sao_Paulo`: a sessão do banco roda em **UTC**, então `CURRENT_DATE` consideraria a
  semana corrente COMPLETA das 21h à meia-noite.
  ✅ **Estendido a `pontualidade_pagamento` com `group_by='mes'` (migration 125)** — `mes_parcial`,
  `dias_cobertos`, `dias_totais`. Ali a truncagem é **pior**: o rótulo `2026-07` se lê como julho
  inteiro e o mês tem **3 dos 31 dias**, porque quem o corta não é o filtro do usuário e sim o
  próprio **corte de cobertura** da 121 — invisível por definição. Medido: 38 contas em julho
  contra 187 em agosto, que sem a ressalva vira "agosto teve 5× mais contas". 🔴 Nos demais eixos
  as três colunas vêm **NULL**: ali o grupo não delimita período, e preenchê-las com a janela da
  consulta daria a impressão de uma ressalva por grupo que não existe.
  🔴 **`LEAST` e `GREATEST` IGNORAM NULL** — ao contrário dos operadores aritméticos. Sem o
  `CASE WHEN mes_ini IS NULL`, `LEAST(NULL, p_date_to, hoje)` devolve `hoje` e a coluna sai
  preenchida com a largura da consulta: número plausível e sem sentido. Reproduzido no ensaio da
  125 (11 linhas de `geral`/`faixa`/`fornecedor`) e travado por guarda **amarrada ao `LEAST`** —
  a versão solta da asserção passava com a guarda daquela expressão desativada, porque a da outra
  coluna ainda casava.
- **Expor coluna na view não basta** — `fine_interest`/`discount` só viraram resposta quando foram
  ao **RETORNO** de `gasto_por_fornecedor`. Ao destravar dado novo, verificar se alguma tool o
  **agrega**, não só se a view o expõe.
- **Rate limit** (`lib/ai-chat/rate-limit.ts`): 30/hora e 150/dia por usuário, contados no próprio
  `analytics.ai_chat_log` (serverless — contador em memória zeraria de forma imprevisível).
  **Fail-open deliberado**: se a contagem falhar, deixa passar e loga — derrubar o chat por causa
  do contador seria pior. Conta também as tentativas que falharam (elas gastaram tokens).
- **Sugestão do painel é CONTRATO**: só entra pergunta coberta por tool e travada na bateria
  `regression.test.ts`. DPO, auditoria de autor e taxa de extração ficaram **fora** por não terem
  dado que as sustente. ✅ **A auditoria de autor VOLTOU na Onda 7** e a **pontualidade na Onda 9**
  (as duas pelo mesmo motivo: o gatilho era dado acumulado e ele chegou). **Taxa de extração segue
  fora** — as falhas vivem em `email_control`, e nenhuma tool as alcança.

**O que a Onda 2 entregou (não regredir):**

- **`email_control.body_full`** guarda o corpo INTEIRO; **`body_preview` continua truncado em 500**
  e é o que a tela `/emails` mostra. Não "unificar" os dois: são preview e conteúdo.
- **`body_search`** é `tsvector` GERADO de **assunto + corpo**, com `to_tsvector('portuguese'::regconfig, …)`
  — a versão de **1 argumento é STABLE** e o PostgreSQL recusaria em coluna gerada (mesma família da
  lição do `competence_month`).
- **Teto de 100 KB no corpo, com o corte DECLARADO no texto** (`[CORPO TRUNCADO — …]`). Corte
  silencioso é o defeito que esta onda corrigiu: o `[:500]` cortava 53% dos corpos sem deixar
  sinal, e só se descobriu contando quantos batiam exatamente no teto.
- 🔴 **O teto vive TAMBÉM na expressão gerada** (`left(…, 100000)` na migration 105), não só no
  reader. `tsvector` estoura em **1 MB**, e estourar **quebra o INSERT** — numa coluna gerada, isso
  derruba a gravação do e-mail inteiro. O reader **não é o único caminho de escrita**: a varredura
  da Onda 4, scripts de backfill e correção manual gravam `body_full` direto por `service_role`.
  Teto só no cliente protege apenas o cliente que se lembrou dele. Medido no pior caso (lexemas
  todos únicos): 100 KB de texto → tsvector de ~128 KB = **12% do limite**.
- 🔴 **`COALESCE(subject, '')` na concatenação do `ts_headline` não é redundante.** Em SQL,
  `NULL || texto` devolve **NULL** — um e-mail sem `Subject` faria o `trecho` sair nulo, entregando
  ao modelo uma linha sem contexto. Hoje há 0 e-mails assim, mas mensagem sem Subject é comum.
- 🔴 **O teto do corpo é COERENTE entre as duas camadas, e há teste travando isso.** Python
  (`BODY_FULL_MAX_CHARS`) diz quanto **guardar**; o `left(…, N)` da expressão gerada diz quanto
  **indexar**. Se o do Python ficar maior, o excedente é gravado e **fica fora do índice** — a busca
  responde "não encontrado" para texto que está no banco, sem erro e sem sinal. O teste
  `test_teto_do_python_nao_excede_o_teto_do_SQL` lê a migration (localizada pelo **conteúdo**, não
  pelo nome) e compara.
- **São DOIS os caminhos que gravam o corpo** — o reader (`process_message`) e
  **`scripts/reprocess_body_emails.py`**, que rebusca o corpo no IMAP para reprocessar e-mails em
  `falha`. O segundo descartava o texto inteiro e gravava só `[:500]`; hoje persiste via
  `save_body_full`, reusando o `_body_full_for_storage` do reader (mesmo teto, uma fonte de
  verdade). **Ao mexer no corpo, mexer nos dois** — corrigir só o produtor principal deixa a perda
  viva pelo outro caminho.
- **`NULL` ≠ string vazia** em `body_full`: NULL significa *"ainda não temos o corpo"* (e-mail
  antigo ou sem keyword), string vazia significaria *"o corpo é vazio"*. A busca depende dessa
  distinção.
- 🔴 **No `ts_headline`, passar o MESMO texto que o tsvector indexa.** Passar só o corpo deixava
  **41% dos resultados sem destaque** (50 e-mails casam apenas pelo assunto e não têm corpo algum)
  — o modelo recebia linha sem contexto, sem saber por que ela veio.
- **Cobertura da busca é PARCIAL e o prompt diz isso**: corpo completo só a partir de 31/07/2026;
  a Onda 4 recuperou 70 corpos antigos e **436 seguem sem corpo, DEFINITIVAMENTE** (os e-mails
  saíram da INBOX — não são mais recuperáveis por via nenhuma); e os **255 sem keyword** não têm
  corpo por decisão de escopo. O modelo é instruído a responder *"não encontrei nos e-mails com
  corpo disponível"* — **nunca** *"nunca foi mencionado"*. Essa instrução ficou **mais** importante
  depois da Onda 4, não menos: a lacuna é agora permanente.
- **Decisão de escopo (item 2.3): opção A.** Não guardar o corpo do e-mail sem keyword — exigiria
  `FETCH RFC822` completo por mensagem (com anexos) para material não-financeiro, com PII.

**O que a Onda 3 entregou (não regredir):**

- **`public.fiscal_document`** (migration 107) — documento fiscal eletrônico identificado pela
  **chave de acesso de 44 dígitos** (NF-e 55 · CT-e 57 · CF-e 59 · NFC-e 65). Tabela de
  **PROVENIÊNCIA, append-only**: `access_key` UNIQUE, campos derivados da própria chave
  (UF/AAMM/CNPJ do emitente/série/número), `storage_key` e a origem do e-mail
  (`gmail_message_id`/`sender_email`/`subject`/`received_at`).
- 🔴 **Documento fiscal NUNCA soma em relatório financeiro.** O frete já entra como BOLETO e a
  NF-e é a origem da mercadoria, não a obrigação de pagamento — somar duplicaria despesa.
  ⚠️ **A barreira DEIXOU de ser estrutural na Onda 5** (migration 119): a tabela ganhou
  `freight_amount`/`cargo_amount`, então a antiga garantia "não há coluna de valor" **não vale
  mais** — não a cite. O que a substitui é uma barreira DECLARADA em três camadas (COMMENT da
  coluna, descrição da tool e SYSTEM_PROMPT), sustentada por **guarda de teste**: a bateria
  `regression.test.ts` reprova se a tool expuser `frete_rs` sem que o prompt carregue a proibição
  de somar — inclusive reprovando a frase antiga *"a ferramenta não devolve valor algum"*, que
  virou mentira. Declaração sem guarda seria só uma frase que alguém enxuga.
- 🔴 **A purga passou a preservar o PDF fiscal** (`scripts/purge_orphan_attachments.py` consulta
  `fiscal_document.storage_key` como TERCEIRA fonte de "referenciado"). Sem isso ela apagaria
  exatamente o que a onda registra — CT-e sem boleto, por regra de negócio, **nunca** tem linha
  em `financial_account_attachment` nem em `financial_account_control`. Medido: **72 PDFs**
  estavam nessa situação (órfãos no bucket 150 → 78). Travado por guarda cross-layer em
  `tests/test_fiscal_document_consistency.py`, validada contra mutante.
- 🔴 **CONSULTA REST CUJO RESULTADO VIRA DADO GRAVADO — OU DECIDE APAGAR — PRECISA PAGINAR**
  *(achado do code review de 2026-08-01; não regredir)*. O Supabase corta a resposta no **"Max
  rows" (1.000)** e devolve **HTTP 200**: sem erro, sem exceção, sem sinal. O `_rest()` dos dois
  scripts (`backfill_fiscal_documents.py` e `purge_orphan_attachments.py`) era um `urlopen`
  único — e o teto **já estava ativo**: `email_control` tem **1.158** linhas e devolvia 1.000.
  Consequência medida: **68 dos 172** documentos (**40%**) nasceram sem
  `sender_email`/`gmail_message_id`/`subject`/`received_at`, e como a tool filtra por
  `received_at` (`NULL >= data` é NULL) eles **sumiam de toda pergunta com recorte de data** — a
  tool respondia 104 de 172, e 66 de 80 CT-e, sem sinal de erro. **Corrigido** (paginação por
  `order=id&limit&offset`, determinística — sem `ORDER BY` o PostgREST não garante a mesma ordem
  entre requisições e o offset puro pularia linhas) **e os 68 registros foram reparados** com
  `--fix-provenance`. Guarda em `tests/test_fiscal_document_consistency.py`, validada por mutante.
  > 🔴 **A paginação vive em `scripts/supabase_rest.py` — fonte ÚNICA (refatoração de
  > 2026-08-01).** `purge_orphan_attachments.py` e `backfill_fiscal_documents.py` tinham CADA UM
  > sua cópia de `_rest`/`_storage_list`, e as cópias **divergiam no que importa**: a do backfill
  > filtrava `id` nulo (placeholder de pasta), a da purga **não** — então a entrada **`manual`**
  > (a pasta dos anexos manuais da 079) era listada como objeto, não tinha linha em tabela
  > nenhuma, virava órfã e **entrava na lista de APAGAR**. Um cluster que precisa da MESMA
  > correção em dois lugares é um módulo esperando para nascer (mesmo motivo do `febraban.py`).
  > O módulo trata falha de **rede** além de HTTP (`NETWORK_ERRORS` — `except HTTPError` sozinho
  > deixa timeout/DNS propagarem e derrubarem o laço), tem **teto de páginas** (servidor que
  > ignora `offset` levanta em vez de travar) e o `rest_write` **devolve `(ok, motivo)` em vez de
  > lançar**, para que uma falha não derrube os itens seguintes do laço.
  > **Guarda:** `PaginacaoCompartilhadaTest` + `RestGetFuncionalTest` — este último prova a
  > paginação pelo **COMPORTAMENTO** (servidor falso, conta as linhas), porque a guarda textual
  > deixou passar o mutante que troca `offset={pagina*PAGE_SIZE}` por `offset=0`: a palavra
  > `offset` continua no código e a paginação quebra. Não substituir por checagem de texto.
- ⚠️ **`_provenance_index` guarda a LISTA de e-mails por prefixo, não "o primeiro"** — e
  `_match_email` recebe o documento para **desempatar pela plausibilidade da emissão**
  (`_emissao_plausivel`: o `AAMM` da chave, escrito pelo emissor, contra a data do e-mail).
  O comentário antigo dizia que prefixo repetido são "reenvios da mesma thread, proveniência
  equivalente na prática" — **medido: falso em 27% dos casos**. Dos 1.015 prefixos, 82 colidem;
  60 são reenvio real, mas **22 têm assunto de fornecedor DIFERENTE**, porque
  `safe_filename(subject, 30)` trunca em 30 chars (`LE BIANCO - PAGAMENTO FORNECEDOR` ×
  `… (DOIS M)` × `… (NYBC)`). Sem desempate, o documento seria atribuído ao e-mail errado em
  silêncio. **A data nunca erra** — o prefixo contém `YYYYMMDD`, então todos os candidatos são
  do mesmo dia e o filtro temporal da tool não é afetado nem no pior caso.
  > **Na purga a falha é INVERTIDA e pior:** truncar `emails` só perde proteção, mas truncar
  > `anexos`/`sources`/`fiscais` transforma objeto **legitimamente referenciado** em falso órfão,
  > apagado num run que reporta "órfãos removidos" com naturalidade. Estavam a **17–40%** do teto
  > e crescem a cada conta lançada. Dano corrente medido na época: **0 objetos** — a redundância
  > que salvava era empírica (`email_processing_errors`), não estrutural.
- ⚠️ **`retry_extraction.py` alimentava o gancho fiscal sem proveniência** — `email_ctx` levava só
  `message_id` e `subject`, e o `fetch_pending` nem selecionava as outras colunas. Todo documento
  registrado por esse caminho nascia sem remetente e sem data, ou seja, fora de qualquer consulta
  temporal. É o **pior caso**, não um caminho raro: o modo padrão processa
  `pdf_extracted=false AND attachment_saved=true` — exatamente os PDFs cuja extração falhou, que
  é a população que o gancho (rodando ANTES do `run_extraction`) existe para capturar. Corrigido:
  os 4 campos viajam, e o `subject` gravado deixou de ser a versão cortada em 60 chars do log.
- **`skills/pdf-contas-pagar/scripts/fiscal_key.py`** — parser determinístico, **só stdlib**
  (mesmo espírito do `febraban.py`). **NÃO reusar `barcode_dv_refuted`**: o DV do boleto fica na
  posição 4 com resto→1 e o da SEFAZ na 43 com resto→0 — trocar um pelo outro devolve veredito
  plausível e errado, sem levantar erro.
- 🔴 **A validação tem CINCO camadas e nenhuma é dispensável** — UF IBGE, mês 01-12, **ano em
  [2006, corrente+1]**, modelo no domínio e DV. Medido: dos 8 barcodes de 44 dígitos não-boleto
  já gravados em contas, **7 são lixo**; e no backfill um "Boleto de Aluguel" passou nas quatro
  primeiras e virou uma **CF-e de setembro de 1991** — sequência aleatória fecha módulo 11 em
  ~1/11 dos casos. Os 7 códigos reais e o falso positivo do aluguel são fixtures em
  `tests/test_fiscal_key.py`.
- 🔴 **O SEPARADOR da chave inclui a BARRA — sem ela eram 61 CT-e perdidos, em silêncio**
  *(corrigido em 2026-08-12)*. Rodonaves, TRB e SSW imprimem a chave com o **CNPJ do emitente
  formatado dentro dela** (`35.2608.44.914.992/0001-38-57-001-…`); a barra faltava em
  `_DIGIT_RUN_RE`, o run de dígitos partia em 14+30 e **nenhum pedaço chegava a 44**. O sintoma
  não parecia defeito: **39 dos 88 PDFs de transporte** ficavam com `models=[55]` — só a NF-e
  citada no corpo do DACTE —, o que se lê como "documento sem CT-e", não como falha de leitura.
  Só apareceu ao **LER os 144 PDFs do bucket e comparar com o que estava gravado**; nem a suíte
  nem o dado agregado acusavam. Backfill reaplicado: **104 → 165 CT-e** (total 232 → 293).
  O risco de a barra COLAR números distintos foi **medido antes de aplicar**, em 138 PDFs
  NÃO-fiscais (boletos, guias, recibos): **0 falsos positivos** — as cinco camadas contêm.
  Guarda com a fixture real impressa em `ChaveComCnpjFormatadoTest`, validada por mutante.
  > **Lição que generaliza:** um extrator que erra **para menos** não gera erro, não gera linha
  > em `/erros` e não quebra teste — ele produz um acervo menor que parece completo. A única
  > verificação que o encontra é comparar o **conteúdo da fonte** com o que foi gravado.
  > ⚠️ No `--dry-run` do backfill, "novas" conta **ocorrências**: a mesma chave em 2 PDFs
  > (DACTE individual + fatura agregada) é contada 2×, e na gravação a 2ª vira duplicata
  > ignorada. Dry-run 65 × gravadas 61 é coerente, não perda — a reexecução acusa `0 novas`.
- **O gancho fica no Passo 1 de `extract_and_store_accounts`, e ANTES do `run_extraction`** — não
  nos 7 pontos de `skipped_nonpayable`. Ponto único, cobre o documento **mesmo quando a linha
  vira conta** (o boleto de transporte que traz a chave do CT-e junto) e captura a chave ainda
  que a Claude API esteja fora. A ordem é travada por teste (`test_registra_ANTES_da_extracao`),
  validado contra mutante.
- **Registro NÃO-FATAL e sem efeito colateral** (mesmo contrato do `register_attachment`): não
  altera o `status` do e-mail, não cria conta, engole a própria falha. **A regra de negócio ficou
  intacta** — CT-e/NF-e sem boleto continua sem gerar conta a pagar.
- **`register_fiscal_document` usa `return=representation`** e só devolve `True` quando a linha
  foi de fato INSERIDA. Com `ignore-duplicates` sozinho o PostgREST responde 201 mesmo sem
  inserir, e o log de produção — a via pela qual se confere se a onda funciona — diria
  "registrado" no reprocessamento inteiro.
- **`_pdf_text` substituiu `_pdf_mentions_lebianco`**: o texto do anexo passou a ter DOIS
  consumidores, então é lido **uma vez e por inteiro**. O curto-circuito da regra LEBIANCO segue
  valendo para a FLAG, não para a leitura.
- **Backfill aplicado** (`scripts/backfill_fiscal_documents.py`, dev-only): **172 documentos**
  (92 NF-e + 80 CT-e) de 511 objetos do bucket. Ganho não previsto: o DACTE referencia a **NF-e
  da mercadoria transportada**, então vieram 92 NF-e "de brinde" — inclusive emitidas pela
  própria OTIMOTEX. Escopo deliberado: só o bucket; os ~115 CT-e cujo PDF a purga já levou
  ficavam para a **Onda 4** (IMAP) — que rodou em 2026-08-03 e recuperou **0 deles**: aqueles
  e-mails não estão mais na INBOX. São **irrecuperáveis**, não pendentes.
- **Grupo restrito vê ZERO documentos fiscais** — a policy reusa o recorte da 078 (por
  remetente) e quem envia CT-e é a transportadora. Verificado com o papel real: ester
  (Comercial) **0**, barbara (Financeiro) **172**. É consequência da regra existente, não
  defeito; mudar exige decisão de política de acesso.
- **Limitação conhecida: PDF cifrado não entrega chave** — `_pdf_text` roda antes do
  `run_extraction`, que é quem descriptografa (boletos OBER/Amil). Não é regressão (antes não se
  capturava nada).
- **`documentos_fiscais` devolve `total_encontrado`** — 2ª ocorrência da armadilha da truncagem
  silenciosa; a regra geral está no bloco da Onda 6 ("Toda função com `LIMIT` DECLARA o total").

**O que a Onda 5 entregou — item 5.3 apenas (não regredir):**

A população foi medida **lendo os 144 PDFs fiscais do bucket** (pdfplumber, sem LLM). Detalhe e a
tabela por grupo em [docs/roadmap-enriquecimento-dados.md](docs/roadmap-enriquecimento-dados.md),
"POPULAÇÃO MEDIDA".

- 🔴 **Classificar documento fiscal por ASSUNTO ou NOME DE ARQUIVO ERRA.** 34 PDFs com assunto
  `CT-e - NNNN` tinham registrado só a chave da **NF-e citada dentro** do DACTE. Toda contagem
  por grupo tem de sair do TEXTO do PDF; foi a classificação por metadados que sustentou a
  premissa errada do levantamento anterior (41 DACTEs, quando são 83).
- 🔴 **5.1/5.2 (itens de NF-e) SUSPENSOS: 15 DANFEs, 6 com tabela de itens detectável.** Das 128
  NF-e registradas, a maioria são chaves **citadas** em guia GNRE ou dentro do DACTE — o DANFE
  não está no acervo. Reabrir só se o acervo crescer; tabela filha + LLM + tool + testes para 15
  documentos é desproporcional.
- **A fonte do 5.3 é a FATURA AGREGADA, não o DACTE** (`cte_content.py`, stdlib puro): 10 PDFs,
  um único emissor (BRASPRESS), tabela regular → regex, custo zero de LLM. O DACTE individual (83
  PDFs) tem layout por transportadora — "PESO" aparece em 80/83, mas "VALOR TOTAL DA PRESTAÇÃO"
  em **5/83** —, e fica para a etapa com LLM (5.3-b, **não implementada**).
- 🔴 **O parser é FAIL-CLOSED pelo SUB-TOTAL impresso na própria fatura**: se a soma do que
  extraiu não bate, devolve **NADA daquele PDF**. Estes números são um **rateio**; rateio a que
  falta uma linha não é "quase certo" — ele atribui frete ao conjunto errado, e a soma passa a
  discordar da conta a pagar sem que nada acuse. Medido: **10/10 faturas fechando**, e o oráculo
  recusa até a menor linha da fatura (R$ 133,87).
- 🔴 **`freight_amount` é DECOMPOSIÇÃO, nunca uma segunda despesa** — ver o bloco da Onda 3, onde
  está registrado que a barreira deixou de ser estrutural e passou a ser declarada + travada por
  teste. **Provado no dado:** cruzando pelo PDF de origem, **9 de 9** faturas com conta vinculada
  batem **exatamente** com o `amount` da conta a pagar (a 10ª diverge por causa do `source_file`
  cruzado da conta 521, limitação já conhecida do download por link).
  > ⚠️ **Ao cruzar `fiscal_document` com `financial_account_control` por `storage_key` =
  > `source_file`, AGREGUE OS DOIS LADOS ANTES do join.** Um PDF com 2 contas multiplica as
  > linhas de CT-e e **dobra o frete somado** — a primeira versão desta verificação acusou uma
  > divergência de exatamente 2× que não existia no dado, só no fan-out da consulta.
- 🔴 **O gancho de conteúdo roda DEPOIS do registro das chaves** (`_register_cte_content` ao fim
  de `_register_fiscal_documents`): conteúdo é **UPDATE**, então antes do INSERT ele grava em
  nada — sem erro, com o log dizendo "registrado". Ordem travada por teste que EXECUTA o gancho e
  observa a sequência das chamadas, validada contra 2 mutantes (inverter a ordem · remover o
  gancho). Guarda textual não serviria aqui — é a lição da regra 2, item 6.
- 🔴 **São DOIS níveis de teste, e o de cima NÃO é redundante** *(medido em 2026-08-12)*.
  `test_cte_content.py` chama `_register_fiscal_documents` **direto**, passando o texto na mão —
  prova o gancho, mas não o elo anterior. `ConteudoCteFluxoTopoTest`
  (`tests/test_fiscal_document_hook.py`) executa **`extract_and_store_accounts`**, provando que o
  Passo 1 lê o PDF e entrega **aquele** texto ao gancho. Medido com o mutante que troca
  `pdf_raw_text` por `row.get("description")` — plausível, não quebra nada e não é pego por
  typecheck: o teste de topo fica **18 vermelhos** e o do gancho direto segue **27 verdes**.
  Ao mexer no Passo 1, os dois níveis têm de continuar existindo.
- **A fixture da fatura vive em `tests/fixtures_cte.py`**, compartilhada pelos dois arquivos.
  Copiada, as versões divergem no primeiro ajuste e o oráculo do SUB-TOTAL — que só vale enquanto
  linhas e total forem coerentes entre si — deixa de valer sem nada acusar. Não é `conftest.py`
  porque estes testes são `unittest.TestCase`, que não recebe fixture por parâmetro.
- ✅ **`SupabaseControl.update_fiscal_content` PROVADO contra o banco real** (2026-08-12): o
  backfill grava por outro caminho (`rest_write`) e os testes usam controle falso, então o método
  que roda quando chega uma fatura por e-mail nunca tinha falado com o PostgREST. Sonda que
  regrava os MESMOS valores lidos do banco: `content_extracted_at` avançou (o UPDATE alcançou a
  linha), o hash do conteúdo ficou **idêntico** e as contagens globais não se mexeram
  (824 contas · 293 docs · 57 com conteúdo). Nome de coluna errado, Decimal serializado como
  float ou filtro `not.eq` malformado só apareceriam aí.
- **`content_source` existe para as duas fontes conviverem** (`braspress_invoice` hoje,
  `dacte_llm` no futuro), com CHECK de domínio fechado. O gancho e o backfill **não sobrescrevem
  conteúdo de outra fonte**: um dado mais rico não pode ser rebaixado por uma passada
  determinística que rodou depois.
- **`linked_invoice` é NULL quando a fatura diz "DIVER."** (várias notas no mesmo conhecimento) —
  guardar o literal inventaria uma nota fiscal que não existe. 6 dos 57 estão nesse caso.
- ⚠️ **A migration 119 precisou de DOIS `DROP FUNCTION`** — a assinatura antiga (6 parâmetros) e
  a nova (7). Com só o primeiro, a **reexecução** falha com *"function already exists with same
  argument types"*: na 2ª passada a antiga já não existe e o DROP não acha nada. É variante da
  armadilha da 116 (lá o risco era perder os GRANTs; aqui, a idempotência).
- **Cobertura declarada ao modelo:** o conteúdo existe só para CT-e recebido em fatura agregada
  (57 de 293 documentos). Campo vazio significa **"ainda não extraído"**, nunca "não tem".
- 🔴 **Ao contrário das Ondas 6 e 7, esta onda TOCOU `skills/` ⇒ EXIGIU deploy** —
  `cte_content.py` (arquivo NOVO), `read_emails.py` e `fiscal_key.py`, mais o
  `deploy-manifest.json`. **Aplicado e validado em produção em 2026-08-12**: paridade 28/28 +
  dois smoke tests na própria máquina (`modulo carregou: True` e a chave extraída do texto com o
  CNPJ formatado). Detalhe em [docs/deploy/historico-deploys.md](docs/deploy/historico-deploys.md).
  ⚠️ **`cte_content.py` degrada em SILÊNCIO se faltar** — é import lazy, então o pipeline segue
  verde gravando documentos **sem** peso/rota/frete e o único sinal é `Deploy parcial?` no log.
- ⏳ **O que ainda NÃO foi exercitado em produção:** a captura **automática** a partir de um
  e-mail novo. O backfill cobriu o acervo, o fluxo de topo tem teste e o
  `update_fiscal_content` foi provado contra o banco — falta apenas chegar a próxima fatura
  (são semanais). Conferir com
  `SELECT count(*) FROM fiscal_document WHERE content_extracted_at >= '<data>'`.

**O que a Onda 6 entregou e os invariantes que ela criou (não regredir):**

- **5 colunas GERADAS** em `financial_account_control` (`competence_month`, `days_late`,
  `extraction_confidence`, `installment_number`, `installment_base`) + **`public.dim_date`**
  (2015–2045, com feriados) + **2 funções de análise** em `analytics`. Guardas em
  `tests/test_onda6_campos_derivados.py` (**47 casos**, validados contra **18 mutantes**).
  A migration **116** fechou o achado B1 do code review (ver os 3 itens 🔴 abaixo).
- 🔴 **TODA FUNÇÃO COM `LIMIT` DECLARA O TOTAL** — `total_encontrado` via
  `(count(*) OVER ())::integer`, que o PostgreSQL avalia **antes** do `ORDER BY`/`LIMIT`. Sem ele,
  truncar é **indistinguível de "acabou"**: `fornecedores_recorrentes` devolvia **50 de 63** com
  HTTP 200 e nenhum sinal, e quem contasse as linhas responderia "50 fornecedores recorrentes".
  **É a 3ª ocorrência da mesma armadilha** (`gasto_por_fornecedor` na Onda 1, `documentos_fiscais`
  na Onda 3) — por isso virou regra, não mais um caso. Vale para função nova em `analytics` **e**
  para qualquer leitura cujo resultado o modelo possa contar ou somar. Guarda **G9**.
  ⚠️ Tem de ser **janela**, nunca subconsulta que repita o corpo: a subconsulta herdaria o `LIMIT`
  e devolveria o total **truncado** — o mesmo bug com cara de correção (mutante M2).
- 🔴 **`ORDER BY` + `LIMIT` exige ordem TOTAL também dentro do SQL.** `ocorrencias, supplier_name`
  empata (fornecedor homônimo existe; o nome pode ser NULL) e, sem desempate único, **o conjunto
  truncado varia com o plano de execução** — a mesma chamada devolve fornecedores diferentes entre
  execuções, sem erro. É a lição de `lib/stableOrder.ts`/`applyOrder` **estendida ao lado do
  banco**, onde ela ainda não estava registrada; o sintoma aqui seria "o ranking mudou sozinho".
  As duas funções terminam o `ORDER BY` na chave do agrupamento.
- 🔴 **`DROP FUNCTION` APAGA OS GRANTS.** Acrescentar coluna ao `RETURNS TABLE` muda o tipo de
  retorno, então `CREATE OR REPLACE` é recusado (**42P13**) e o par DROP+CREATE é obrigatório —
  e recriar sem reemitir `GRANT`/`REVOKE` deixa a função **executável por `PUBLIC`** (default do
  PostgreSQL) e **inexecutável por `authenticated`**: aberta para quem não deve, quebrada para
  quem deve. `LIMIT` também ganhou `GREATEST(COALESCE(p_limit, 50), 0)` — negativo levanta
  **2201W** em runtime, e `p_limit` vem de parâmetro de tool/LLM.
- ⚠️ **Guarda que localiza migration por CONTEÚDO segue a definição VIGENTE (a última), nunca "a
  única".** `_migration_que_contem` exigia `len(alvos) == 1` e ficou vermelha assim que a 116
  redefiniu `analytics.fornecedores_recorrentes` — dois arquivos passaram a casar. O erro aponta
  para ambiguidade do localizador, não para defeito no código, e a "correção" natural é afrouxar a
  guarda. Seguir a última também é o que faz as invariantes de G7 (SECURITY INVOKER, `search_path`,
  bandas disjuntas, `anon` sem EXECUTE) valerem sobre o que está **no banco**: travá-las na 115
  deixaria a 116 livre para regredir qualquer uma com a suíte verde. Efeito colateral tratado: o
  marcador da 115 em G8 passou a ser a **view** (único a ela) e G8 exige marcadores **distintos** —
  sem isso, dois colapsando na mesma migration deixariam outra sem verificação, em silêncio.
- 🔴 **Coluna GERADA tem de entrar no `.omit()` do `financialAccountControlInputSchema`.** O
  PostgreSQL recusa com **428C9** qualquer INSERT/UPDATE que cite coluna gerada — o `.pick()` de
  `manualEditSchema` já as excluiria, mas um write path futuro que use o InputSchema direto
  quebraria a gravação. É a guarda **G1**, que também fecha uma lacuna antiga: **não existia nada**
  comparando as colunas das migrations com o schema Zod, então uma coluna podia nascer no banco e
  ficar invisível para a API, o frontend e todo consumidor de tipo, sem nenhum teste vermelho.
- 🔴 **`to_date` é STABLE — o roadmap estava ERRADO.** Ele prescrevia `to_date(...)` afirmando que
  "com máscara explícita é IMMUTABLE"; conferido em `pg_proc` desta base, `to_date(text,text)` tem
  `provolatile = 's'` e o PostgreSQL **recusa** a coluna gerada (`generation expression is not
  immutable`). Quem serve é **`make_date`** (`'i'`). Foi a mesma classe de erro que o roadmap
  tentava evitar (`::date` é STABLE) — ele só errou qual função escapa dela. **Volatilidade se
  confere no catálogo, não se deduz da assinatura.**
- 🔴 **`days_late` é `payment_date - due_date` e nada mais.** `CURRENT_DATE` ali nem seria aceito
  (não é IMMUTABLE), e seria o bug da migration 095 de novo: coluna que passa a mentir com o tempo
  sem nenhum UPDATE. **Negativo é pagamento antecipado** — 13 contas na medição — e não deve ser
  normalizado para zero. **Não agregar como DPO:** nas contas pagas antes da 096 o `payment_date`
  veio do backfill (= vencimento) e produz 0 artificial.
- 🔴 **`installment_total` NÃO existe e não deve ser criada.** O reader monta `doc/ORDINAL`
  (`read_emails.py:5289`); o total não está na origem. Criar a coluna escreveria "3 de 3" num carnê
  de 12. O substituto é `analytics.parcelamentos()`, com `parcelas_observadas` e
  **`parcelas_faltando`** — que já achou **5 carnês com as parcelas 1 e 2 sem conta cadastrada**,
  um passivo que o "total" inventado jamais mostraria. A guarda G4 falha se alguém criar a coluna.
- 🔴 **Função usada em coluna gerada precisa de `GRANT EXECUTE` a `authenticated`.** A expressão é
  avaliada com o privilégio de **quem escreve a linha**, e `authenticated` escreve aqui
  (`has_invoice`/`has_bank_slip` por grant de coluna, `status_id`). Sem o grant, marcar "Tem NF" em
  `/consulta` devolveria **42501** — num lugar sem relação nenhuma com parcela.
- **A regra de parcela rejeita mais do que aceita, de propósito:** **19 de 40** candidatos, com as
  40 linhas lidas à mão. Os 21 rejeitados são nosso-número (`09/00018287242`, `109/09116046`,
  `112/250207258`). NULL é preferível a dado inventado — parcela ausente é pergunta sem resposta;
  parcela errada é resposta errada.
- 🔴 **Cadência se mede entre DATAS DISTINTAS, não entre contas** *(defeito achado ao RODAR a
  função, não ao revisá-la)*. OTIMOTEX tem **53 contas em 21 datas**; medindo entre contas, os
  intervalos vêm cheios de zeros, a mediana desaba e sai "cadência semanal, confiança provável"
  para série sem cadência nenhuma. E as **bandas são fixas e disjuntas**: derivá-las de uma
  tolerância de 5 dias fazia "semanal" virar `[2,12]` e "quinzenal" `[10,20]` — faixas sobrepostas.
  A tolerância governa a **dispersão** (`regular`), que é outra pergunta.
- **A saída da recorrência carrega a própria ressalva:** `ocorrencias`, `intervalo_min/max`,
  `regular` e `confianca` vêm ao lado de `cadencia`, então quem quiser só a palavra "mensal" tem de
  ignorar ativamente os campos que a contradizem. Com ≤5 meses de histórico, **só mensal/quinzenal/
  semanal é detectável**; bimestral sai `insuficiente` e trimestral/anual não é detectável.
  `parcelamento_provavel` separa **carnê** (um contrato) de fornecedor recorrente — sem ele, um
  carnê de 5 parcelas produz cadência mensal perfeita e seria contado como recorrência.
- **Classificar por CADÊNCIA, nunca por valor:** só 3 de 11 recorrentes têm valor estável;
  `valor_mediano`/`valor_variacao_pct` são saída informativa, jamais critério.
- **`parcelamentos()` não vive na view** — um `count(*) OVER (PARTITION BY ...)` dentro de
  `vw_payables` (que é `security_invoker`) seria calculado **depois** do filtro de RLS, e um usuário
  restrito veria "3 de 3" onde existem 5.
- 🔴 **GRANT SOZINHO NÃO BASTA em tabela nova do `public`: sem POLICY, o papel lê ZERO linhas.**
  O Supabase **habilita RLS automaticamente** em toda tabela nova do schema `public`, e RLS ligado
  com zero policies é **deny por default**. A 1ª versão da 111 concedeu `SELECT` a `authenticated`
  e não criou policy: medido com `SET ROLE authenticated`, **0 dias visíveis** e
  `dias_uteis('2026-01-01','2026-02-01')` devolvendo **0** em vez de 21 — sem erro, sem exceção, só
  o calendário respondendo que nenhum dia é útil, para todos os usuários do app.
  ⚠️ **E escapou da primeira verificação porque `psql` conecta como `postgres`**, que ignora RLS:
  os `GRANT`/`has_table_privilege` do checklist deram tudo certo. **Conferir tabela nova com
  `BEGIN; SET LOCAL ROLE authenticated; SELECT …; ROLLBACK;`** — privilégio concedido e linha
  visível são duas perguntas diferentes.
- **`dim_date` segue o calendário BANCÁRIO**, não a letra da lei: Carnaval e Corpus Christi são
  ponto facultativo, mas o banco fecha — e o que importa para conta a pagar é se o dinheiro anda.
  `holiday_kind` distingue `'nacional'` de `'bancario'`. Consciência Negra só é nacional a partir de
  **2024** (Lei 14.759/2023); marcá-la antes diria "banco fechado" num dia em que ele operou.
  A migration **aborta** se a tabela divergir das funções que a semearam.
- ⚠️ **Corrigir a regra de uma coluna gerada exige `DROP COLUMN` + `ADD COLUMN`.** Substituir a
  função com `CREATE OR REPLACE` **não recalcula** os valores STORED — a coluna fica com o
  resultado da regra antiga, em silêncio. E **nunca** forçar recálculo com `UPDATE ... SET x = x`:
  dispara `trg_fe_status_vencimento` em todas as linhas e pode reescrever situações.
- **Esta onda não tocou `skills/`** ⇒ **sem deploy em produção** e o `deploy-manifest.json` não
  mudou.

**O que a Onda 7 entregou e os invariantes que ela criou (não regredir):**

A trilha de auditoria (`public.audit_log`, migrations **117/118**) registra **UPDATE, DELETE e
TRUNCATE** em `financial_account_control` **e `supplier`** — INSERT fica de fora por decisão (a
linha recém-criada já está na fato, e o pipeline insere ~17/dia). Guardas em
`tests/test_onda7_auditoria.py` (**34 casos**, validados contra **9 mutantes**).

- 🔴 **O item 7.1 do roadmap NÃO era executável como escrito, e executá-lo abriria um vazamento.**
  Quatro achados medidos no catálogo antes de qualquer alteração: (1) `registro_id` era **uuid** e
  a PK da fato é **bigint** — não havia onde gravar o id da conta; (2) a tabela tinha policy
  `"Enable read access for all users"` **TO public** + `GRANT SELECT TO anon`, herdados de ter
  sido criada pelo dashboard — popular antes de revogar publicaria valores, fornecedores e autores
  da base inteira para quem tivesse a **anon key, que é pública**; (3) a policy de `authenticated`
  era `USING (true)`, ignorando a RLS 076; (4) `contaService.remove(id)` não recebia ator. Por isso
  a 117 **fecha o furo ANTES de ligar as triggers** — a ordem interna do arquivo é a correção.
- 🔴 **A trigger de linha é AFTER; a de TRUNCATE é BEFORE.** As 5 triggers atuais da fato são
  **todas BEFORE** e alteram `NEW` (`updated_at`, `status_id` recalculado, `payment_date`,
  `sk_company`): auditar antes delas gravaria o valor que ainda será sobrescrito — registro
  plausível e **falso**. Já o TRUNCATE precisa ser BEFORE, porque em AFTER a tabela já está vazia
  e o número de linhas destruídas seria inalcançável (roda na mesma transação, então some junto se
  o TRUNCATE abortar).
- 🔴 **`fn_audit_row` é `SECURITY DEFINER`, e isso não é estilo.** `authenticated` teve INSERT
  revogado em `audit_log` (056) e a RLS não tem policy de escrita: uma trigger INVOKER faria **toda
  a curadoria de `/consulta`** (marcar NF/Boleto, trocar situação — UPDATE por `authenticated` via
  REST direto) quebrar com `permission denied`. É a **regressão classe 074**, e a migration prova o
  contrário na própria aplicação, com `SET LOCAL ROLE authenticated`.
- 🔴 **`OLD.updated_by` NUNCA é fonte de ator.** Ele é o editor ANTERIOR — usá-lo numa alteração de
  batch atribuiria a um humano uma mudança que ele não fez, que é **acusação falsa**, pior que
  ausência de dado. A ordem de resolução é `auth.uid()` → header `x-audit-actor` → GUC
  `app.audit_actor` → NULL/`'servico'`, e **o JWT vir primeiro é invariante de SEGURANÇA**: se o
  header fosse consultado antes, um usuário logado poderia forjá-lo e assinar a alteração no nome
  de outra pessoa.
- 🔴 **O ator dos caminhos da Next API viaja por HEADER** (`lib/audit-actor.ts` → `withAuditActor`).
  Ela escreve por `service_role`, então `auth.uid()` é NULL em todo PATCH/DELETE: sem o header, o
  **hard delete** (irreversível, cuja única cópia da linha destruída fica em `audit_log`) e **toda
  edição de fornecedor** seriam auditados sem autor. Cadeia verificada ponta a ponta: `setHeader`
  põe o header no fio em `update` e `delete` → o PostgREST o expõe em `current_setting('request.headers')`
  → a trigger grava `ator_via='header'` com o uuid exato; **sem** o header, `'servico'` e autor
  nulo — subatribuição honesta, nunca atribuição errada.
- 🔴 **`ator_via='servico'` NÃO significa "ninguém".** Significa automação (pipeline, batch diário)
  ou edição não atribuível. O SYSTEM_PROMPT e a descrição da tool declaram isso; ler como "não houve
  alteração" inverteria a conclusão de uma auditoria.
- **UPDATE grava o DELTA; DELETE grava a linha INTEIRA.** Medido: a linha da fato em `jsonb` tem
  média **1,8 KB** e máximo **13 KB** — gravar a linha inteira em todo update custaria ~3,7 KB por
  evento sem responder melhor à pergunta de governança. No DELETE ela é a única cópia que resta.
  **UPDATE sem mudança real não gera linha**: `fn_set_updated_at` bumpa `updated_at` em TODO update,
  então sem essa saída o batch que remarca a mesma situação encheria a trilha de eventos vazios.
- 🔴 **Coluna de escrituração e coluna GERADA ficam FORA do delta** (`audit_ignored_fields()`):
  ninguém "alterou" `days_late`, que é consequência. Coluna gerada nova precisa entrar nessa lista,
  e há guarda cross-layer que compara com as migrations da Onda 6.
- 🔴 **A policy de leitura espelha a 076 por `registro_dono` DESNORMALIZADO.** O padrão `EXISTS` da
  079 (anexos) **não serve aqui**: ele herda a visibilidade consultando a conta pai, e a linha de
  auditoria precisa **sobreviver à conta apagada** — com `EXISTS`, o registro de DELETE ficaria
  invisível para todos exatamente quando passa a ser a única cópia. Um `CHECK` fail-closed garante
  que evento da fato nunca tenha dono nulo. Verificado com usuários reais: Comercial (restrito) vê
  **2 de 3** eventos, Financeiro vê **3 de 3**.
- **A coluna da tool chama-se `usuario`, não `usuario_email`** — ela carrega um **rótulo**, que
  pode ser `(automacao / nao atribuivel)` ou `(usuario removido: <uuid>)`. Um nome prometendo
  e-mail faria o modelo apresentá-lo como endereço. ⚠️ Mudar o nome ou a lista de colunas do
  `RETURNS TABLE` muda o TIPO DE RETORNO: o PostgreSQL recusa `CREATE OR REPLACE` (42P13), então a
  118 usa `DROP` + `CREATE` — e **o DROP apaga os grants**, reemitidos ao fim do arquivo (a lição
  da 116, que aqui já foi exercitada).
- **As duas tools herdam os invariantes das ondas 1/3/6**: `SECURITY INVOKER` (é o que faz a RLS
  valer no chat), `total_encontrado` por **janela** (4ª ocorrência da truncagem silenciosa),
  `ORDER BY` com ordem total, clamp do `LIMIT` negativo e `GRANT`/`REVOKE` nos dois sentidos.
  🔴 **`auditoria_eventos` nunca devolve `dados_antes`/`dados_depois` crus** — o gateway corta o
  resultado de tool em 60 KB por registro, e uma linha de DELETE chega a 13 KB.
- ⚠️ **A `audit_log` estava VAZIA quando a 118 foi escrita**, então um oráculo comparando contagens
  seria `0 = 0` — verde para sempre, provando nada. O `DO $$` da migration **insere eventos
  sintéticos, mede e desfaz por subtransação**, com asserção de sanidade de que a sonda exercitou
  dado. Mesma armadilha da Regra 2 ("teste que promete uma garantia tem de entregá-la").
- ⚠️ **`audit_sensitive_fields()` nasceu chamável por `anon`** (HTTP 200 com a anon key), como as 4
  funções da Onda 1 — o `REVOKE` explícito foi acrescentado. **Não confiar no default privilege**,
  pela quarta vez.
- 🔴 **O ator vem de FORA e pode vir malformado — validar antes de converter** *(achado da
  autorrevisão adversarial desta onda, reproduzido no banco)*. Com um valor não-uuid no canal de
  ator, o `::uuid` levanta **22P02** e, sendo a trigger fail-closed, **derruba a gravação da conta
  inteira**: um header ruim (proxy, cliente terceiro, chamador com bug) impediria de registrar um
  pagamento. A distinção que faltava: **fail-closed vale para o REGISTRO da auditoria** (não
  conseguiu auditar ⇒ não escreve, senão a trilha ganha buracos silenciosos), **não para
  INTERPRETAR uma dica de atribuição não-confiável** — ator ilegível degrada para o mesmo
  `NULL`/`'servico'` que já significa "não sei quem foi". Guarda de regex nos dois canais; não
  trocar por cast direto.
- ⚠️ **`audit_log.criado_em` é `now()`, o timestamp da TRANSAÇÃO** — todos os eventos de uma
  mesma transação (uma ação em lote de 126 títulos, por exemplo) compartilham o instante, e o
  desempate do `ORDER BY` é o `id`, um **uuid aleatório**. A ordem continua TOTAL (paginação
  determinística), mas **não é cronológica dentro da transação** — o que é correto, já que os
  eventos são simultâneos. Consequência prática: para identificar UM evento específico num
  conjunto gravado junto, filtre pelo CONTEÚDO (`dados_depois`), nunca por "o mais recente". Foi
  exatamente assim que a primeira versão de uma sonda desta onda leu o evento errado.
- 🔴 **A migration NÃO trunca a `financial_account_control` para testar o TRUNCATE.** `TRUNCATE`
  toma **ACCESS EXCLUSIVE** e o segura até o fim da transação — mesmo desfeito, bloquearia o
  pipeline (que roda a cada 5 min) e o app inteiro durante o resto da migration, **a cada
  reexecução**. A decomposição: a **lógica** de `fn_audit_truncate` é provada numa tabela TEMP
  descartável (sonda F), e o **binding** (`BEFORE TRUNCATE` na tabela real) pelo catálogo. Testado
  uma vez contra a tabela real, em transação desfeita: gravou `linhas_destruidas: 810`, batendo
  com a contagem, e as 810 contas ficaram intactas.
- **As sondas cobrem os quatro caminhos de escrita, e reexecutam junto com a migration:** UPDATE
  com delta e no-op (A), curadoria por `authenticated` sem quebrar (B), ator malformado (C),
  **DELETE gravando a linha inteira** (D), **atribuição por JWT** (E) e a lógica do TRUNCATE (F).
  ⚠️ A sonda E resolve um usuário **REAL em tempo de execução** (`auth.users`): com
  `request.jwt.claims` definido, `auth.uid()` passa a valer e a trigger de autoria grava
  `updated_by` — um uuid fictício viola a FK e derruba a migration, e hardcodar um uuid quebraria
  no dia em que aquele usuário fosse removido.
- ✅ **VALIDADA EM PRODUÇÃO no próprio dia (11/08/2026)**, sem intervenção — os três caminhos
  apareceram sozinhos na trilha: **`jwt`** (barbara marcou "Tem Boleto" na conta 962 pela UI →
  delta `has_bank_slip: false → true`, autor resolvido pelo e-mail); **`servico`** em lote (28
  eventos do batch diário — 20 `{status_id}` e 8 `{status_id, payment_date}`, este último o
  espelho exato da trigger da 096); e **`supplier`** (o pipeline gravou `pix_key2` no fornecedor
  H20IL — a alteração de chave PIX que motivou estender o escopo, agora rastreável). As tools
  responderam sobre esse dado com `total_encontrado` correto.
- 🔴 **USUÁRIO REMOVIDO ≠ AUTOMAÇÃO — são TRÊS estados, não dois** *(achado medido; corrigido
  por `analytics.audit_actor_label`, fonte única das duas tools)*. Um evento com `ator_via='jwt'`
  — **ação humana** — cujo autor foi apagado do `auth.users` caía num
  `COALESCE(u.email, '(automacao…)')` e era contado junto com os eventos do batch. A trilha não
  **perdia** o evento: ela o **reatribuía** a uma categoria que inocenta todo mundo, sem erro e
  sem sinal — o número continua batendo. **Não é hipotético: este projeto já apagou um usuário**
  (`teste@otimotex.com.br`, 07/08 — ver migration 110). Os três estados são `usuario_id` nulo
  (automação), com e-mail (a pessoa) e **sem e-mail** (removido, com o uuid preservado). Nunca
  reintroduzir um `COALESCE` local: duas cópias da regra divergem em silêncio.
- 🔴 **`audit_log.usuario_id` NÃO tem FK para `auth.users`, e isso é DELIBERADO — não "corrigir".**
  A tabela nasceu assim (criada à mão), mas a ausência virou **estrutural** na Onda 7: as três
  opções de FK destroem a trilha, cada uma de um jeito. `ON DELETE CASCADE` **apagaria as linhas
  de auditoria** do usuário removido — exatamente o histórico que se quer preservar quando alguém
  sai. `ON DELETE SET NULL` **zeraria a atribuição**, e o autor humano viraria "(automação)" — o
  bug que o `audit_actor_label` acabou de corrigir, reintroduzido pelo banco. `ON DELETE RESTRICT`
  impediria remover usuário, que é operação legítima e já praticada aqui (migration 110). O
  desenho correto para trilha de auditoria é **guardar o uuid e resolver o nome na leitura**,
  tolerando que ele fique órfão — é o que o rótulo de três estados faz.
- 🔴 **O filtro por CAMPO inclui a EXCLUSÃO do registro** — apagar a conta destrói aquele campo
  junto. Medido: filtrando `campo='amount'`, um DELETE que levou uma conta de **R$ 50.000** não
  aparecia (`campos_alterados` é NULL em DELETE), então *"quem mexeu no valor este mês?"* mostrava
  as alterações pequenas e **omitia a destruição da conta inteira**. O 1º ramo do filtro usa o
  índice GIN; o 2º só é avaliado nas linhas de DELETE. ⚠️ No eixo `campo` do **resumo** a exclusão
  continua fora de propósito — contá-la sob cada campo inflaria "amount alterado N vezes" com
  eventos que são de registro, não de campo; a descrição da tool manda usar `group_by='operacao'`
  para vê-la.
- **Cobertura declarada:** a trilha **começa em 11/08/2026**. Antes disso só existia o ÚLTIMO editor
  de cada conta; ausência de evento anterior NÃO prova que nada mudou, e a tool diz isso ao modelo.
- **Esta onda não tocou `skills/`** ⇒ **sem deploy em produção**; o `deploy-manifest.json` não mudou.

**O que a Onda 9 entregou e os invariantes que ela criou (não regredir):**

A onda é **CONDICIONAL**: os 7 gatilhos foram **medidos** contra o banco em 2026-08-13 e só um
ocorreu. A tabela com todas as medições está em
[docs/roadmap-enriquecimento-dados.md](docs/roadmap-enriquecimento-dados.md) § ONDA 9 — consulte-a
antes de implementar qualquer outro item, e **remeça** em vez de confiar no número escrito lá.

- 🔴 **É PONTUALIDADE, nunca DPO.** DPO é indicador contábil (saldo de contas a pagar ÷ CMV ×
  dias) e exige o passivo da empresa; a base aqui é só o que chegou por e-mail. É o mesmo erro que
  a decisão do DRE evitou. O prompt **nega o nome explicitamente** em vez de silenciar: perguntado
  por DPO, o modelo responde pontualidade e diz que DPO não é calculável. Travado nas duas camadas
  (`regression.test.ts` e `tests/test_onda9_pontualidade.py`).
- 🔴 **A população é só a do CARIMBO REAL.** As 441 contas do backfill da 096 têm `days_late = 0`
  por construção; incluí-las devolve "atraso médio zero" — exatamente o número falso que adiou o
  item. **Qualquer consulta futura sobre `days_late` precisa do mesmo corte**; ele é a métrica, não
  um detalhe dela.
- 🔴 **A data de corte vive em `analytics.payment_date_confiavel_desde()`, e SÓ ali.** Guarda: o
  literal pode aparecer **1× no repositório inteiro** (validada por mutante). Uma 2ª cópia diverge
  no primeiro ajuste e o backfill volta para dentro da conta, sem erro nenhum.
- 🔴 **`payment_date <> due_date` NÃO prova carimbo real — a hipótese foi REFUTADA pelo banco.**
  Parecia exata (o backfill sempre iguala), mas há **13 contas pagas antes do corte com desvio**, a
  primeira em 2026-05-06: o **`due_date` foi alterado depois do pagamento** (reemissão de boleto
  atualiza o vencimento da conta existente). Onde isso acontece, `days_late` mede a alteração do
  vencimento, não o pagamento — por isso a tool **exclui** esses casos (detectáveis na `audit_log`
  desde a Onda 7) e conta quantos. Hoje são 0; a exclusão existe para continuar correto quando
  deixarem de ser.
- 🔴 **`atraso_medio_dias` soma SÓ as atrasadas e vem NULL quando não houve nenhuma** — vazio ali
  significa "não houve atraso", nunca zero. Incluir as antecipações produziria um número menor que
  o atraso real com o nome de atraso; quem quer o líquido tem `desvio_medio_dias`.
- **Cobertura declarada no RETORNO** (`cobertura_desde`, `fora_da_cobertura`,
  `excluidas_venc_alterado`), repetida em cada linha como o `total_encontrado`: o consumidor é um
  modelo de linguagem, e ressalva que não vem junto do número não é dita ao usuário. ⚠️ A tool
  ganhou **mais três colunas depois desta onda** (`mes_parcial`/`dias_cobertos`/`dias_totais`, na
  migration 125) — a regra delas vive em "Chat de IA", não aqui, para não haver 2ª cópia.
- 🔴 **Período 100% fora da cobertura devolve UMA LINHA DE AVISO, nunca vazio** *(achado da
  autorrevisão adversarial, reproduzido no banco antes de corrigir)*. Junho/2026 tem **113 contas
  pagas**, todas anteriores ao corte, e a 1ª versão devolvia **zero linhas** — o modelo responderia
  *"não houve pagamento em junho"*, falso e invertendo a conclusão. **"Não existe" e "existe mas
  não dá para medir" são respostas diferentes**, e preservar essa diferença é a razão de ser desta
  tool. ⚠️ **A correção quase quebrou o domínio fechado** e foi a **sonda P3 que pegou, no ensaio**:
  com eixo inválido o agregado também fica vazio, e sem a guarda o aviso apareceria — trocando
  "parâmetro errado" por uma resposta de aparência legítima. O domínio virou CTE (`eixo`), fonte
  única para os dois ramos. *Quem corrige, reaudita.*
- **Herda os invariantes da camada `analytics`**: `SECURITY INVOKER` (é o que faz a RLS valer no
  chat), `total_encontrado` por **janela** (5ª ocorrência da truncagem silenciosa), `ORDER BY` com
  ordem total, clamp do `LIMIT` e `GRANT`/`REVOKE` nos dois sentidos. Verificado que o quadro de
  privilégios é **idêntico** ao das tools existentes (`authenticated` sim; `service_role` e `anon`
  não) — inclusive pelo PostgREST, onde o 403 (e não `PGRST202`) é o que prova que o cache de
  schema já enxerga a função.
- 🔴 **Ao contrário das Ondas 6 e 7, esta onda TOCOU `skills/` ⇒ EXIGIU deploy** —
  `skills/roadmap-gatilhos/scripts/run.py` é arquivo **NOVO** e entrou nos `DEPLOY_GLOBS`
  (`check_deploy_parity.py`), junto de `scheduler/run_gatilhos.ps1` e
  `scheduler/setup-gatilhos-task.ps1`; o `deploy-manifest.json` foi de **28 para 31** entradas e a
  5ª tarefa agendada roda em produção. Detalhe em "QUINTA tarefa" na seção do Task Scheduler.
- 🔴 **O ramo do aviso olha `confiaveis`, NUNCA `agrupado`** *(achado B1 do code review de
  2026-08-13, corrigido pela migration **123**)*. `agrupado` já passou pelo `HAVING count(*) >=
  p_min_contas`, então vazio ali significa **duas** coisas — "não há população confiável" e "há,
  mas nenhum grupo atingiu o piso" — e o aviso só vale para a primeira. Medido com os parâmetros
  que a **própria descrição da tool recomenda** ("use `min_contas` em `group_by=fornecedor`"):
  janela de 7 dias + `min_contas=10` ⇒ **118 contas confiáveis reais** e a tool respondia
  *"nenhuma conta com data de pagamento confiável no período"*. É a mesma inversão que a CTE do
  aviso existe para impedir, entrando pela outra porta. ⚠️ **Nenhuma das 8 sondas da 121 pegou, e
  o motivo generaliza:** todas exercitavam `p_min_contas` no **default**, valor em que o defeito é
  inalcançável — sonda que só roda o caminho padrão não prova o caminho parametrizado.

**Dois invariantes que a auditoria do plano descobriu (não regredir):**

1. 🔴 **`competence_date` NUNCA pode virar DATE.** Contém **`YYYY-MM`** (mês), não data —
   `'2026-06'::date` é erro de sintaxe. O formato é contrato de **3 camadas**: prompt do Claude
   (`extract_pdf.py`), template do CSV e schema Zod. Converter faria **todo INSERT do reader
   falhar**. A Onda 6 **acrescentou** (migration 112) a coluna derivada `competence_month`,
   **blindada por regex** (`CASE WHEN competence_date ~ '^\d{4}-(0[1-9]|1[0-2])$'`) — sem a
   guarda, um `'2026-13'` vindo do LLM lança `22008` e para a extração. ⚠️ A conversão é por
   **`make_date`**, não `to_date`: ver o item de volatilidade em "O que a Onda 6 entregou".
2. 🔴 **Função nova/recriada em `analytics` exige `GRANT` para `authenticated` E `REVOKE EXECUTE
   FROM PUBLIC, anon` — os DOIS, explícitos.** Medido na Onda 1: as 4 funções recriadas pela
   migration 104 nasceram **executáveis por `anon`** (chamáveis com a anon key pública, sem login),
   porque o PostgreSQL concede EXECUTE a PUBLIC por default e o `ALTER DEFAULT PRIVILEGES` da
   migration 098 **não deixou registro persistente** (`pg_default_acl` vazio). As funções antigas só
   estavam protegidas pelo REVOKE explícito da 098. **Não confiar no default privilege.**
3. ✅ **RESOLVIDO na Onda 3 — `scripts/purge_orphan_attachments.py` consulta `fiscal_document`.**
   Ele considerava órfão todo objeto não referenciado por `financial_account_attachment.storage_key`
   ou `financial_account_control.source_file` — e CT-e sem boleto, por regra de negócio, **nunca**
   tem nenhuma das duas. Sem a terceira fonte, apagaria os PDFs fiscais recém-registrados, de forma
   irreversível e sem sinal de erro. **A purga de 15/07 já havia levado 67% dos PDFs de CT-e**;
   agora **72 objetos** só sobrevivem por causa dessa consulta. Travado por guarda cross-layer
   (`tests/test_fiscal_document_consistency.py`) — não remover.

**Fatos medidos que justificam as ondas 2–4:** **48%** dos e-mails (545 de 1.133) são `ignorado` e
não geram nenhum dado estruturado; **180** deles são CT-e (172 com anexo); **39%** dos corpos estão
truncados; e **não há um único XML** — CT-e/NF-e chegam só como PDF.

> **O reader grava em outras tabelas** (Ondas 2, 3 e — futuramente — 5) para o e-mail que **não**
> vira conta. O gancho fiscal fica no **Passo 1 de `extract_and_store_accounts`** (um único ponto,
> grava sempre que houver chave de acesso válida, **antes** do `run_extraction`) — **não** nos 7
> pontos de `skipped_nonpayable`. ✅ Implementado na Onda 3. Em nenhuma onda o reader passa a criar
> conta onde hoje não cria: a regra de `financial_account_control` fica intacta.

## Comandos

> **Specs/templates de prompts (`docs/prompts/`)** — fonte dos prompts copy-paste para o
> Claude Code (padrão prompt-first). CRUDs/auth: `api-supplier-crud-spec.md`,
> `api-contas-crud-spec.md`, `api-users-auth-spec.md`. Qualidade/produção:
> `code-review-producao-spec.md` (review completo em 2 fases — **Phase 1: modo normal**
> read-only, diagnóstico cross-layer; **Phase 2: plan mode**, prompts XML de correção por área;
> gate lint+typecheck+test+prune+vulture; usa `claude-opus-4-8` p/ análise multi-arquivo) e
> `auditoria-seguranca-spec.md` (auditoria de segurança: AuthN/Z, RLS por coluna, IDOR/mass
> assignment, SSRF no download de boleto, XSS, segredos/deps; **Phase 1: modo normal**,
> **Phase 2: plan mode**). Os dois últimos escrevem só em `docs/review/` — rodar o de review
> antes do de segurança (compartilham `read_first`). Modelos: `claude-sonnet-4-6` para tarefas
> isoladas; `claude-opus-4-8` para análise cross-layer com muitos arquivos.

Dependências dos apps: `npm install` na **raiz** (workspaces — lockfile único).

```powershell
# Tudo de uma vez: Flask (:8000) + os 3 apps Node (vite :5173, api :3000, portal :3002)
npm run dev            # via concurrently — serviços falham de forma INDEPENDENTE (ver nota)

# …ou individualmente, em terminais separados:
npm run dev:flask      # backend Flask (:8000) — leitura de e-mails (py -3 server/app.py)
npm run dev:vite       # frontend Vite interno (proxy /api → Flask :8000)
npm run dev:api        # Next API de dados — opcional p/ o fluxo atual
npm run dev:portal     # portal público — opcional
```

Scripts da raiz: `npm run dev` (sobe **flask+vite+api+portal** em paralelo via
`concurrently`) · `npm test` · `npm run typecheck` · `npm run lint` · `npm run prune`
(rodam em todos os workspaces via `--workspaces --if-present`). Builds:
`npm run build:vite|build:api|build:portal`. O `dev` raiz **inclui o Flask**
(`dev:flask` = `py -3 server/app.py`); requer Python com `pdfplumber` no PATH. Para
subir só os apps Node, use os `dev:vite|dev:api|dev:portal` individuais.

> **Nota de estabilidade do dev server (2026-06-19):** o `--kill-others-on-fail` foi
> removido do script `dev` — cada serviço agora falha de forma independente. Antes, uma
> falha do Flask (ex.: porta `:8000` ocupada de sessão anterior) derrubava o Vite junto.
> **Para sessões de trabalho exclusivamente de frontend, prefira `npm run dev:vite`** —
> o Vite sobe sem depender do Flask e não há risco de queda por serviços externos.

> **Versão do Node — use 20.9+ ou 22 LTS, NUNCA a 24 (não regredir — 2026-06-30):** o
> `next dev` do **Next 16** (api-backend/portal) **crasha o worker** no **Node 24**
> (*"Jest worker encountered N child process exceptions, exceeding retry limit"*) — TODAS
> as rotas `/api/*` autenticadas passam a devolver uma **página HTML de erro 500** (não o
> envelope JSON), e o frontend mostra o genérico **"Erro 500 ao acessar a API de dados"**.
> **Só acontece no dev local** (a Vercel roda Node LTS, produção intocada), o que confunde
> o diagnóstico. O manifesto agora trava a versão: **`.nvmrc` = `22`** + **`engines.node`
> = `"^20.9.0 || ^22.0.0"`** na raiz (`nvm use` seleciona a certa; `npm install` avisa no
> Node fora da faixa). Se aparecer 500 HTML em TODAS as rotas autenticadas mas `/api/health`
> (pública) responder JSON: é o worker do dev, não o código — troque para Node 22
> (`nvm use 22`) e/ou limpe `apps/api-backend/.next` e reinicie. **Sintoma-chave:** o
> genérico "Erro {status} ao acessar a API de dados" só aparece quando a resposta **não é
> JSON** (`dataApiCall` não achou `error` no corpo) — indica falha de infra/dev-server,
> não erro de validação (que ecoa a mensagem curada do backend).

> 🔴 **`typecheck` dos apps Next é `next typegen && tsc --noEmit`, e o `tsconfig` EXCLUI
> `.next/dev/types` (não regredir — 2026-08-15).** O `include` que o Next gerencia traz
> **dois** diretórios de tipos gerados: `.next/types/**` (produzido sob demanda por
> `next typegen`/`next build`) e `.next/dev/types/**` (**cache do `next dev`**). O segundo
> tornava o gate **não-determinístico**: ele é escrito quando o dev server roda e nunca
> mais é revisado, então uma escrita parcial fica no disco e o `tsc` passa a acusar erro de
> SINTAXE em código que ninguém escreveu. Caso real: `routes.d.ts` com 7 linhas duplicadas
> terminando em `{ id } = await context.params` derrubou `npm run typecheck` por horas, com
> os 5 erros apontando para um artefato **gitignored** — e ainda desatualizado (não conhecia
> as rotas de anexo). Medido: `next typegen` regenerou `.next/types` **sem tocar** no cache do
> dev numa invocação e tocando na seguinte; é exatamente por não dar para confiar nisso que a
> exclusão existe. **`exclude` vence `include`**, então a regra sobrevive ao Next reescrever o
> `include` (verificado). Custo: ~5 s por app.
>
> **Ganho não-óbvio:** num clone limpo `.next` não existe, o glob não casava nada e o
> **`validator.ts`** — o arquivo gerado que confere a assinatura de cada `route.ts` contra as
> rotas reais — **nunca era checado**; ele só entrava no programa se alguém tivesse rodado
> `next dev`/`build` antes. Agora entra sempre. Provado por mutante nas duas direções:
> corromper `.next/dev/types/routes.d.ts` **não** derruba o gate (exit 0), e trocar o
> `params` de um handler por um nome errado **derruba** (exit 2, com o 1º erro vindo de
> `.next/types/validator.ts`) — ou seja, o gate ficou imune ao cache **sem** ficar cego.
> ⚠️ Ao medir gate, **nunca** encadeie `| tail`/`| grep`: o exit code do pipeline é o do
> último comando e o `tsc` imprime erro em **stdout** — foi assim que este vermelho passou
> despercebido em duas medições (memória `pipe-tail-masks-exit-code`).

Acessibilidade em navegador (Playwright + axe) — **não** roda no `npm test`; runner
separado em `apps/frontend-vite` (sobe o Vite dev sozinho via `webServer`):

```powershell
cd apps\frontend-vite
npx playwright install chromium      # uma vez (baixa o navegador)
npm run test:e2e                     # todas (protegidas pulam sem credencial)
npm run test:e2e -- public-auth      # só login/forgot/reset (sem login)
npm run test:e2e:headed              # com janela do navegador
```

Para escanear as rotas protegidas, exporte `A11Y_TEST_EMAIL`/`A11Y_TEST_PASSWORD` — hoje o
usuário dedicado `teste-a11y@sheild.app.br` (exige `app_metadata.password_changed = true`; ver
o bloco do workflow a11y em "Regras mandatórias · Acessibilidade" e a receita em
`e2e/README.md`). No CI, o workflow `.github/workflows/a11y.yml` roda isso a cada PR/push na
`Features`. **Não executar daqui (sandbox do agente)** — o renderer crasha na SPA completa.

**Scripts de manutenção do pipeline — use a skill `scripts-manutencao`**
(`.claude/skills/scripts-manutencao/`): leitura sob demanda, reprocessadores (link, corpo,
ignorados, CT-e, beneficiário final, Message-ID isolado), backfills, purga de anexos órfãos e
varredura histórica. Ela diz **qual** script para cada sintoma, em que **ordem** e o que cada
`--dry-run` prova. O detalhe de cada script vive na **docstring do próprio arquivo**, junto do
código — é lá que ele não diverge.

🔴 **Todos rodam no DEV e escrevem na Supabase compartilhada dev+prod.** Ficam em `scripts/`,
**fora dos `DEPLOY_GLOBS`** (não vão para produção). Os destrutivos —
`purge_orphan_attachments.py` (apaga do bucket, irreversível) e `reprocess_cte_accounts.py`
(hard delete de contas) — exigem `--dry-run` antes, sempre.

Verificar se a **máquina de produção está com os mesmos arquivos do repositório**: rodar
`py -3 scheduler\check_deploy_parity.py` EM PRODUÇÃO (exit 1 em divergência, portanto agendável)
— ver a skill `deploy-producao`.

Dependências:

```powershell
pip install -r server/requirements.txt   # deps Python do pipeline, pinadas com ~=
npm install                              # na raiz do monorepo — instala todos os workspaces
```

`server/requirements.txt` é a fonte de verdade das dependências Python (flask, python-dotenv,
pdfplumber, Pillow, anthropic, pandas), com versões fixadas em `~=` para dev/prod não
divergirem — não rodar `pip install` solto sem atualizar o arquivo.

## Frontend — componentes e design system

### Estrutura Atomic Design

**Dois estilos visuais de auth coexistem** — não misturar componentes entre eles:

| Estilo | Páginas | Tokens | Componentes-chave |
|---|---|---|---|
| **v2 loginGreen** | `LoginPage` | `loginGreen-*`, `font-jakarta`, `border-[6px]` frame | `FilledTextField`, `AccentPillButton`, `SocialLinksBar` |
| **auth gradient** | `ForgotPasswordPage`, `ResetPasswordPage` | `bg-gradient-auth`, `auth-navy` | `AuthLayout`, `AuthInput`, `GradientPillButton`, `InlineMessage` |

Tudo em TypeScript (`.tsx/.ts`) sob `apps/frontend-vite/src/`:

```
apps/frontend-vite/src/components/
├── atoms/
│   ├── Alert.tsx              # (app) banner de página via cva — error/success/warning/info + ícone
│   ├── FilledTextField.tsx    # (v2) campo label + fundo verde + id (useId) + aria-invalid
│   ├── AccentPillButton.tsx   # (v2) botão primário verde + ArrowRight
│   ├── AuthInput.tsx          # (gradient) campo label + input + erro inline (aria-describedby)
│   ├── GradientPillButton.tsx # (gradient) botão pill com bg-gradient-auth
│   ├── CheckToggle.tsx        # checkbox de curadoria (NF/Boleto) — escreve no banco
│   ├── SelectCheckbox.tsx     # checkbox de SELEÇÃO de linha (rowSelection) + indeterminate
│   ├── LabeledSelect.tsx      # (tabelas) <select> rotulado (htmlFor/id + erro) — lookups dos forms de cadastro
│   ├── FileInputButton.tsx    # (anexos) <input type=file multiple> REAL + sr-only (teclado/leitor de tela nativos)
│   └── StatusSelectCell.tsx   # (consulta) dropdown inline de situação no grid — altera status_id (STATUS_OPTIONS)
├── molecules/
│   ├── SocialLinksBar.tsx     # (v2) círculos Otimotex/Lebianco/WhatsApp — o do WhatsApp só entra na fileira QUANDO `WHATSAPP_NUMBER` está preenchido (vazio gerava `href="https://wa.me/"`, um link quebrado; a constante é anotada `: string` para o TS não estreitar o ramo a `never`)
│   ├── AuthHeroHeader.tsx     # (gradient) header decorativo com círculos sobrepostos
│   ├── InlineMessage.tsx      # (gradient) banner sucesso/erro — nunca alert()
│   ├── SupplierSelect.tsx     # (contas) react-select AsyncCreatable — busca/cria fornecedor (sort=name)
│   ├── ChartAccountSelect.tsx # (contas + fornecedores + FILTRO de /consulta) react-select Async — PLANO de contas por DESCRIÇÃO (1º da cascata invertida); value = descrição. Prop `variant`: 'form' (padrão, rótulo em bloco + carrega na montagem) | 'filter' (sem rótulo visível, carga TARDIA no 1º onMenuOpen — ver "FILTROS DEDICADOS de classificação contábil")
│   ├── CostCenterSelect.tsx   # (contas + fornecedores) react-select Async — CENTRO de custo do plano (2º da cascata; value = chart_account_id, onChange devolve chartAccountId+costCenterId)
│   ├── ColumnVisibilityMenu.tsx # (grid) popover mostrar/ocultar + fixar coluna (pin esq/dir)
│   ├── GridToolbar.tsx        # (grid) barra: colunas + densidade + restaurar + ações de seleção
│   ├── AttachmentPicker.tsx   # (anexos) fila CONTROLADA de arquivos a enviar — valida mime/tamanho/duplicata no cliente
│   ├── AttachmentList.tsx     # (anexos) lista apresentacional PURA (serve a fila e os salvos) — ícone/tamanho/selo e-mail
│   ├── SearchInput.tsx        # (cadastros) busca com lupa + botão limpar (X) — usado pelo grupo Tabelas + /fornecedores
│   └── MarkdownMessage.tsx    # (chat IA) renderiza a resposta a partir de lib/markdownLite (parágrafo/lista/tabela GFM/negrito/código) — JSX puro, sem dangerouslySetInnerHTML
├── organisms/
│   ├── LoginForm.tsx          # (v2) estado + validação + supabase.auth.signInWithPassword
│   ├── ForgotPasswordForm.tsx # (gradient) resetPasswordForEmail + mensagem genérica
│   ├── ResetPasswordForm.tsx  # (gradient) updateUser + signOut + redirect (fluxo "esqueci a senha")
│   ├── ChangePasswordForm.tsx # (auth) troca obrigatória no 1º acesso — updateUser + marca password_changed (sem deslogar)
│   ├── ResendErrosAction.tsx  # (cobrança) barra de seleção "Reenviar e-mails (N)" + confirmação inline + poll de progresso
│   ├── AiChatWidget.tsx       # (chat IA) botão flutuante + ESTADO da conversa; montado no Layout só quando aiChatEnabled === true (gate da 120); painel por lazy()
│   ├── AiChatPanel.tsx        # (chat IA) side sheet apresentacional em <dialog>+showModal (foco/Esc nativos) — mensagens, sugestões, chips de tool, retry, "Nova conversa"
│   ├── ContaForm.tsx          # (contas) form criar/editar conta — supplier + cascata INVERTIDA plano→centro; onSubmit(data, pendingFiles) — a fila de anexos sobe no PAI, após gravar a conta
│   ├── ContaAttachments.tsx   # (anexos) anexos SALVOS de uma conta — lista + viewer + soft delete (com confirmação); fallback legacySourceFile
│   ├── SupplierForm.tsx       # (fornecedores) form criar/editar fornecedor — classificação default (cascata INVERTIDA plano→centro) + contatos (telefone/WhatsApp/chave PIX, 2 slots)
│   ├── CostCenterForm.tsx     # (tabelas) form criar/editar centro de custo — código + descrição
│   ├── BankForm.tsx           # (tabelas) form de banco — código(3) + nome
│   ├── FinancialAccountForm.tsx # (tabelas) form de conta — descrição/banco/situação(lookups) + saldo
│   ├── ChartAccountForm.tsx   # (tabelas) form de plano de contas — centro/subgrupo(lookups) + nível + postável
│   ├── ChartAccountGroupForm.tsx     # (tabelas) form de grupo — código + descrição + tipo(1)
│   ├── ChartAccountSubgroupForm.tsx  # (tabelas) form de subgrupo — código + descrição + grupo(lookup obrigatório)
│   ├── CrudTablePage.tsx      # (tabelas) página CRUD genérica <T,TInput> (lista+busca+modais) — base das 5 páginas
│   ├── DataGrid.tsx           # grid sobre TanStack Table v8 (+ DataGrid.test.tsx) — ver seção própria
│   ├── dataGrid.variants.ts   # cva por slot (header/row/cell/skeleton/empty/footer/pin/resize/grip/densidade/wrap) default|silver
│   └── dataGrid.rows.ts       # buildRenderItems (achata linhas→itens row/second/footer/detail p/ virtualização)
├── dashboard/                 # primitivos de gráfico compartilhados pelos DOIS dashboards (vencimentos + financeiro)
│   ├── constants.ts           #   MONTHS/MONTHS_FULL + KPI_FILTER_LABEL e `kpiFilterSuffix(filter)` (a ressalva de recorte no subtítulo do card — ver "Casca compartilhada dos dashboards"). Sem componente, para as páginas importarem sem disparar `react-refresh/only-export-components`
│   ├── chartColors.ts         #   statusColor (semântico por status) + paletteColor (cíclica) — só tokens --color-status-*
│   ├── BreakdownDonut.tsx (+ .test.tsx)  #   donut genérico (conic-gradient + furo + legenda), prop {segs:{key,label,value}[], colorFor, size?, diameterPx?}. Arcos + % + ORDEM das fatias por VALOR (R$) desc; legenda = R$ (fmtMoney, `font-mono`) + % em `text-xs` (SEM contagem de contas); furo central = TOTAL em R$ compacto (fmtMoneyCompact, ex.: "R$ 12,3 mil") rotulado "total", em **`font-sans font-normal`** (SEM negrito/mono — só o valor central, não a legenda). **`size: 'sm'|'md'|'lg'`** (tipo `DonutSize`, exportado — substituiu o booleano `dense`) controla SÓ o círculo, com o furo proporcional: `sm`=108px/inset-3 (os 4 donuts na mesma linha de `/dashboard_vencimentos`; em `/dashboard_despesas` os 5 donuts também usam `sm`, mas numa grade de 2 colunas e com `diameterPx` sobrepondo o valor) · `md`=120px/inset-3 (default, = comportamento do antigo `dense={false}`) · `lg`=176px/inset-5 + número central `text-base` (sem call site — API do componente, coberto por teste). Classes LITERAIS por tamanho (mapa `SIZE_CLS`) — nome computado não é gerado pelo JIT e o donut ficaria sem tamanho, em silêncio (travado no teste). **`diameterPx?: number`** (opcional) SOBREPÕE `size` com um diâmetro CONTÍNUO em px via inline style (círculo + furo, razão `DYNAMIC_HOLE_RATIO=0.11`) — usado só por `/dashboard_despesas`, que passa o MESMO valor (gerado a partir do maior total R$ do conjunto) nos 5 donuts, nunca um valor por donut; sem ele, comportamento idêntico a antes (`/dashboard_vencimentos` inalterado)
│   ├── ChartCard.tsx (+ .test.tsx) / chartCard.variants.ts  #   MOLDURA de todo card de gráfico/lista (título + subtítulo + ícone opcional + `dense`); apresentacional puro, conteúdo por `children`. Existia duplicada em 10 blocos entre as duas páginas — duplicação em código novo reprova o quality gate do SonarCloud. A prop `className` é mesclada por `cn` (clsx + tailwind-merge), então a classe do CHAMADOR vence a da variante quando as duas mexem no mesmo utilitário (com `+` viraria "p-3 p-4" e quem ganha dependeria da ordem no CSS)
│   ├── DonutCard.tsx (+ .test.tsx)  #   ChartCard + BreakdownDonut (converte `slices:{label,value}[]` em `segs`, `key` = o próprio label — a agregação já é por label); repassa `size`/`dense`/`diameterPx`/`colorFor`/`onSliceSelect` e o `className` da moldura. Único uso hoje do `className`: o `self-start` do donut que divide a linha do grid com o card de ranking em /dashboard_despesas
│   ├── DashboardHeader.tsx (+ .test.tsx, .a11y.test.tsx)  #   CASCA dos dois dashboards: título + "filtrando: X ✕" e a barra empresa · escopo · mês · ano · Atualizar. Apresentacional puro; recebe title/subject/idPrefix + o objeto `filters` (hooks/useDashboardFilters). Ver "Casca compartilhada dos dashboards" abaixo
│   ├── KpiRow.tsx (+ .test.tsx)  #   faixa dos 5 cards de KPI (grid + map sobre KpiCard); concentra a regra "o KPI 'total' nunca fica ativo"
│   ├── KpiCard.tsx (+ .test.tsx)  #   card de KPI CLICÁVEL (= filtro) da faixa superior, compartilhado pelos DOIS dashboards (antes o bloco era duplicado literalmente nas duas páginas). Apresentacional puro: props {icon,label,amount,count,tone,active,onClick}; a página decide o que está ativo. Contagem em pt-BR (Intl, milhar com ponto)
│   ├── kpiCard.variants.ts    #   cva do KpiCard (card/ícone/valor) por `tone` (neutral|success|muted|danger — tipo `KpiTone`, fonte única do array `kpis` das duas páginas) e `active`. Ver "Destaque dos cards de KPI" abaixo
│   ├── MonthlyFlow.tsx        #   barras "mês a mês" (A pagar vs. Pago), prop {flow} — usado SÓ por /dashboard_vencimentos (o financeiro não tem esse gráfico)
│   ├── RankingList.tsx (+ .test.tsx)  #   ranking horizontal top-N por valor, prop {rows:{name,value,count,key?}[]} (fornecedores em /dashboard_vencimentos | subgrupo de plano de contas em /dashboard_despesas — o de CENTROS DE CUSTO saiu em 2026-08-15). A `key` da linha inclui a POSIÇÃO — `name` não é garantidamente único (fornecedores homônimos; cadastros sem UNIQUE em descrição) e a key duplicada fazia o React descartar a 2ª linha, sumindo com o valor sem erro visível. Prop OPCIONAL `onSelect(row)` (drill-down): com ela a linha vira `<button>` real e devolve `row.key` (balde); sem ela, `<div>` não-interativo (vencimentos)
│   ├── PriorityList.tsx       #   lista de contas críticas/prioritárias, prop {rows: PriorityAccount[]} — usado SÓ por /dashboard_vencimentos
│   └── ExpenseDetailModal.tsx (+ .test.tsx, .a11y.test.tsx)  #   card de DETALHE (drill-down) de /dashboard_despesas: modal <dialog> centralizado + DataGrid enxuto (getExpenseDetailColumns: Fornecedor/Plano de conta/Vencimento/Valor/Situação — Situação por último, badge read-only via StatusBadge+STATUS_NAME_BY_ID **SEM fallback local** — `status_id` é NOT NULL de domínio fechado (FK, ids 1-10), então o lookup nunca deveria vir `undefined`; o valor cru é passado direto ao `StatusBadge`, que já trata `undefined`/nulo sozinho (mesmo padrão de `r.keyword_matched` em `getConsultaColumns`) — **não** "alinhar" com o `String(id)` de `Consulta.tsx:applyStatusId`, que resolve um problema distinto (popular `status_dim.status_name` para persistência/CSV, não só exibição), célula com `className: 'whitespace-nowrap'` — grid SEM enableColumnManagement, onde `size` é ignorado; ver a nota "ColumnDef.size/minSize são IGNORADOS sem enableColumnManagement" na seção do DataGrid) das contas da fatia/linha clicada. Rows já filtradas pela página (filterExpenseDetailRows); ordena por VENCIMENTO asc (mais próximos primeiro; sem data vai ao fim; **sort estável** — empate de vencimento preserva a ordem original, travado por teste) + rodapé total. Ver "Card de DETALHE (drill-down)" na rota /dashboard_despesas
├── AuthLayout.tsx             # (gradient) wrapper full-page para Forgot/Reset
├── AttachmentViewer.tsx       # visualizador de PDF (signed URL do Storage) em <dialog> nativo (showModal: role/foco/trap/Esc nativos) + iframe SEM sandbox — o viewer PDF do Chrome (PDFium) não renderiza em iframe sandboxed, nem com allow-scripts (S5-1 introduziu e quebrou o boleto; revertido). NÃO reintroduzir sandbox; ver comentário no componente. `sourceFile` = chave CRUA do objeto (pipeline: nome flat; manual: `manual/{id}/…`); prop opcional `title` = nome amigável no cabeçalho (sem ela cairia a chave crua). Os botões (Fechar/Baixar/Nova aba) contêm o próprio clique — é montado dentro do <tr> de /consulta (ver "Contenção do clique")
├── Layout.tsx (+ Layout.test.tsx)   # sidebar; navLink = cva local (estado active); menu em 5 grupos (ver abaixo)
├── ProtectedRoute.tsx
├── ErrorBoundary.tsx          # boundary raiz (main.tsx): chunk lazy obsoleto → auto-reload; runtime → fallback "Recarregar" (+ teste/a11y)
├── StatusBadge.tsx (+ StatusBadge.test.tsx)   # componente; variantes em statusBadge.variants.ts
├── statusBadge.variants.ts    # cva(badgeVariants) + resolveBadge + badgeLabel + mapas de tipo/status
└── ExpandableText.tsx         # expansível "ver mais/ver menos" (+ ExpandableText.test.tsx)
```

**Menu da sidebar (`Layout.tsx`) — 5 grupos** (cabeçalho `uppercase`; itens `breve` são
`<span className="nav-link is-disabled">` com badge "breve", sem rota):

| Grupo | Itens (rota / estado) |
|---|---|
| **Recebimentos** | E-mails (`/emails`) · Log de erros (`/erros`) |
| **Envios** | E-mails (`/cobranca/envios`) · Log de erros (`/cobranca/erros`) — logs da cobrança automática de vencidos |
| **Contas** | Gestão de contas (`/consulta`) · Cadastro de contas (`/contas`) · Cadastro de fornecedores (`/fornecedores`) |
| **Tabelas** | Plano de contas (`/tabelas/plano-de-contas`) · Grupos de plano de contas (`/tabelas/grupos-plano-de-contas`) · Sub grupos de plano de contas (`/tabelas/subgrupos-plano-de-contas`) · Centro de custos (`/tabelas/centros-de-custo`) · Contas bancárias (`/tabelas/contas`) · Bancos (`/tabelas/bancos`) — CRUDs dos cadastros contábeis (ordem conforme `Layout.tsx`) |
| **Dashboards** | Indicadores de despesas (`/dashboard_despesas`) · Indicadores de Vencimentos (`/dashboard_vencimentos`) — nessa ordem (o financeiro vem primeiro, pedido do usuário) |

> "Gestão de contas" aponta para `/consulta` (só o rótulo difere da rota). Ao promover um
> item `breve` a ativo, troque o `<span … is-disabled>` por `<NavLink>` e remova o badge
> (feito para "Cadastro de fornecedores", "Cadastro de contas" e **"Dashboard"**). **Não há mais
> nenhum item `breve`** na sidebar — todos os itens são links ativos.

O **rodapé da sidebar** mostra apenas **avatar + e-mail + botão Sair** — o antigo texto de versão
`v1.0.0 — fase 1` foi **removido**. Os espaçamentos verticais foram **compactados** para o menu
**caber sem scroll** em telas ~900px+ (`nav-link` = `py-1.5`; cabeçalhos de grupo = `pt-2.5 pb-1`,
o 1º grupo `pt-0.5 pb-1`; `<nav>` `py-2`; logo `py-3`; rodapé `py-2.5`). O `overflow-y-auto min-h-0`
do `<nav>` **permanece** como rede de segurança para viewports muito baixas (rola DENTRO da sidebar
escura em vez de transbordar sobre o `<main>` branco — não regredir, ver a11y).

Hooks em `src/hooks/`: `useContainerBreakpoint.ts` (faixa `sm`/`md`/`lg` pela largura
**real do container** via `ResizeObserver` — não da janela; usado pelo `DataGrid` p/ ocultar
colunas considerando sidebar/paddings), `useGridPreferences.ts` (estado de layout do grid —
ordem/visibilidade/larguras/fixação/densidade — persistido em `localStorage` por `gridId`;
setters no formato `OnChangeFn` do TanStack + `reset()`; aceita **`defaultPinning`/`defaultDensity`**
semeados na 1ª carga e no `reset()` — prefs salvas prevalecem; ver seção do DataGrid),
**`useDashboardFilters.ts`** (estado mês/ano/escopo/filtro de KPI/empresa compartilhado pelos
DOIS dashboards + `toggleFilter`/`clearFilter`; **não** carrega dados — ver "Casca compartilhada
dos dashboards"), **`useClassificationFilterOptions.ts`** (opções dos 3 `<select>` nativos da 2ª
linha de filtros de `/consulta` — centro de custo, grupo e subgrupo; 3 lookups em **paralelo**
com `Promise.allSettled` (uma lista que falha não zera as outras), **cache de módulo** (a 2ª
visita à página não vai à rede) e falha silenciosa devolvendo `[]`; o plano de contas fica FORA
dele — ver "FILTROS DEDICADOS de classificação contábil") e
`useGridColumns.ts` (metadados de coluna — `ColumnDef` com `size?`/`minSize?`/`wrap?` opcionais,
`getConsultaColumns`, `getEmailColumns`; é módulo de **definições**, não um hook,
apesar do nome). `getConsultaColumns(onToggleFlag, onStatusChange)` é factory porque as
colunas "NF" e "BOL" (curadoria) renderizam o atom `CheckToggle` (checkbox que escreve no banco) e a
coluna "Situação" renderiza o `StatusSelectCell` (dropdown inline que altera a situação **por
`status_id`**; opções `STATUS_OPTIONS` value=id, e o badge é exibido pelo **nome** resolvido via
`STATUS_NAME_BY_ID`/embed `status_dim`) — ambos precisam dos callbacks da página. (A coluna "Ações"/`onEdit` foi removida — a edição da conta parte
do botão "Editar conta" do painel de detalhe.) Os cabeçalhos são abreviados (`NF`/`BOL`) para poupar
largura, mas o `aria-label` do checkbox continua descritivo (`Tem NF`/`Tem Boleto`). A coluna **"Fornecedor" deriva do JOIN com `supplier`** e exibe **nome fantasia + razão social
QUANDO DIVERGEM** (`fmtSupplierName`, `lib/format.ts` — separador ` · `, mesmo padrão de
`fmtChartAccountFull`); a antiga coluna **"CNPJ/CPF" foi REMOVIDA do grid** (segue no card de
detalhe + embed).

> **Por que a regra é "quando divergem" e não "sempre os dois" (2026-08-04 — substitui a decisão
> anterior de exibir só o `trade_name`):** com o fantasia cadastrado como **MARCA** — "PEGAMIL"
> para `ITW PPF BRASIL ADESIVOS LTDA` — o fantasia sozinho deixava o fornecedor irreconhecível e
> parecia a conta de outra empresa. Mas concatenar SEMPRE polui: em `CIPATEX` ×
> `CIPATEX IMPREGNADORA DE PAPEIS E TECIDOS LTDA` um nome **contém** o outro e a repetição não
> acrescenta nada. Por isso `fmtSupplierName` concatena só quando nenhum contém o outro,
> comparando **sem acento, caixa e pontuação** (senão `S/A` × `SA` contariam como distintos).
> Medido no cadastro (1.294 fornecedores ativos): **534** exibem os dois, **734** caem no caso
> "um contém o outro" e **26** têm só um dos nomes.
>
> **A ordenação continua por `supplier(trade_name)`** e permanece coerente: é pelo fantasia que a
> célula COMEÇA, então a ordem casa o que se lê. Aplicado também no **card de detalhe**
> (`fmtSupplier`, que prefixa o `sk_supplier`); no **CSV** a razão social ganhou **coluna própria**
> (`supplier_legal_name`) em vez de ser concatenada — numa planilha, dado separado por coluna é
> processável, texto concatenado não é. Testes em `src/lib/format.test.ts`. A **coluna "Plano de contas" tem visualização ENRIQUECIDA** (`fmtChartAccountFull`,
`lib/format.ts`): **concatena plano de contas + grupo + subgrupo + centro de custo** (cada parte
`código — descrição`, separador ` · `; partes ausentes/id 0 omitidas). A **antiga coluna "Centro de
custo" foi REMOVIDA do grid** (dobrada dentro da célula de plano de contas) — mas a **edição
(inclusão/alteração) do centro e do plano no `ContaForm` permanece inalterada** (só a visualização do
grid mudou). Grupo/subgrupo vêm dos **embeds ANINHADOS em `chart_account`**
(`group:financial_chart_of_account_group(...)` via a FK direta da migration 058 +
`subgroup:financial_chart_of_account_subgroup(...)`), acrescentados ao `SELECT_WITH_EMBEDS`; o centro
de custo é o da própria conta (`cost_center_id`, embed `cost_center` — o mesmo que era exibido na coluna
removida). Os schemas de embed de grupo/subgrupo reusam `chartAccountGroup/SubgroupEmbeddedSchema` dos
cadastros (sem duplicar). **A hierarquia aninhada precisa vir nos DOIS caminhos de leitura (não
regredir):** o `SELECT_WITH_EMBEDS` do frontend (`services/supabase.ts`, usado no fetch/refresh do grid)
**e** o `SELECT_WITH_SUPPLIER` da Next API (`apps/api-backend/lib/contas.ts`, resposta de POST/PATCH que
é **mesclada IN-PLACE** no grid por `Consulta.handleEditSubmit`, sem refetch). Se só um trouxer
group/subgroup, a célula fica **parcial após salvar a edição e só corrige no refresh** — foi exatamente o
bug corrigido ao acrescentar os embeds aninhados ao SELECT da Next API. **Fornecedor e Plano de contas
SÃO ordenáveis server-side** pelo recurso
embutido, via sintaxe do PostgREST `alias(coluna)` no `order` — `sortKey: 'supplier(trade_name)'` e
`'chart_account(account_description)'` (a coluna concatenada ordena pela **descrição do plano**). O
**alias** é o mesmo do `SELECT_WITH_EMBEDS` (`supplier`/`chart_account`); usar o nome real da tabela
(`financial_cost_center(...)`) é rejeitado pelo PostgREST (400). O `key` dessas colunas de embed no
`ColumnDef` é sintético (`ColumnDef.key` é `keyof T | (string & {})`; o `accessorFn` só alimenta
sort/filter client-side, que não usamos — a ordenação é sempre server-side). Ordem das colunas de
A coluna **"Empresa"** (`company.trade_name` via a FK `sk_company`, embed `company(trade_name)`) fica
**logo APÓS o Fornecedor** — mesma posição no **card de detalhe** e no **ContaForm** (pedido do
usuário). Há também **filtro por empresa** na barra (`<select>` "Empresa", vazio = TODAS, logo após
a busca): aplica no **"Buscar"** como os demais selects, filtra **pela FK** (`sk_company=eq.N`, não
pelo embed) e alcança o grid **e os 5 cards de KPI** — desde 2026-08-08 `getFinancialStats(applied)`
recebe os mesmos filtros de todo o resto (ver "KPIs de `/consulta` seguem o filtro" abaixo); a
frase anterior deste bloco, "os KPIs gerais seguem globais por design", **deixou de valer**. As
opções vêm do hook **`useCompanyOptions`**
(`hooks/useCompanyOptions.ts` → `GET /api/companies`), **compartilhado com o `ContaForm`** — sem
duas cópias do fetch; lista vazia (falha de rede) → o select fica só com "Empresa" (= sem filtro). É ordenável server-side por `company(trade_name)` e **não se confunde com o Fornecedor**:
pode haver conta da LEBIANCO cujo fornecedor é a OTIMOTEX. Ordem das colunas de
`/consulta`: **… Emissão → Fornecedor → Empresa → Tipo Documento → Tipo Pagamento → Plano de contas → Vencimento → Valor → NF → BOL → Situação → Extração**
(`Extração` é a última; **não há mais colunas "Ações" nem "Centro de custo"**). `Extração` (badge
`extraction_source`) aparece **só** no grid (removida do detalhe e do CSV); contas criadas
**manualmente** (`extraction_source` nulo) exibem o rótulo **"Criado pelo usuário"** (constante
`MANUAL_EXTRACTION_LABEL` em `useGridColumns`) em vez de "—" — o pipeline SEMPRE grava um
`extraction_source`, então vazio identifica de forma confiável a criação manual. O **card de detalhe** de
`/consulta` continua mostrando **Centro de custo e Plano de contas SEPARADOS** (via `fmtCostCenter`/
`fmtChartAccount`, inalterados) — a concatenação é exclusiva do grid.
A coluna **"Situação" ordena alfabeticamente pelo NOME** da dimensão (`sortKey: 'status'`, mapeado
no serviço para `order=status_dim(status_name)`), **não** por `status_id` (o ciclo de vida não é
linear — id ≠ ordem de negócio). **`ColumnDef` ganhou `wrap?`** (quebra de linha em vez de
truncar — usado em Fornecedor/Plano de contas) e **`minSize?`** (largura mínima por
tipo de dado, ~48–120px, respeitada no resize). `hideOn` (responsividade mobile/tablet) segue como o
mecanismo de ocultação por breakpoint.
`useIdleLogout.ts` e `useAuth` cobrem sessão (ver Autenticação).

Tipos compartilhados vêm de `@sheild/shared` (ex.: `FinancialEmail`, `EmailControl`).
Helpers em `src/lib/`: `getErrorMessage.ts` (erro em strict mode), `format.ts` (formatadores
de exibição — `fmtDate`/`fmtDateTime`/`fmtMoney`/`fmtMoneyCompact` (BRL compacto "R$ 12,3 mil" —
furo central dos donuts)/`fmtCnpj`/`fmtCpf`/`fmtCostCenter`/`fmtChartAccount`/
`fmtBytes` (tamanho de arquivo B/KB/MB, base 1024 — usado pela lista de anexos) —
**mais `isoDaysFromToday(dias)` e `todayISO`** (data **LOCAL**, `YYYY-MM-DD`, não UTC: à noite o
UTC já está no dia seguinte e a data "voltaria um dia"). O `todayISO` **morava dentro do
`ContaForm`** e foi promovido a `format.ts` quando o update otimista de `/consulta` passou a
precisar dele — exportá-lo do arquivo do componente dispararia
`react-refresh/only-export-components`, e duplicá-lo violaria a fonte única. Consumidores:
`ContaForm` (default de emissão/vencimento na inclusão) e `Consulta.applyStatusId` (espelho de
`payment_date`); **fonte única** consumida por `Consulta`/`Emails`/`Dashboard`/`useGridColumns` —
não recriar cópias locais.
> 🔴 **TODA data derivada de "hoje" passa por `isoDaysFromToday` — inclusive as JANELAS
> (2026-08-08).** `todayISO` virou `isoDaysFromToday(0)`; a base ganhou o deslocamento porque
> `getFinancialStats` e o card "A vencer em 7 dias" derivavam a janela por `toISOString()` (UTC) e
> `Date.now() + 7 * 86400000`. Em **UTC−3, das 21h à meia-noite**, o "hoje" em UTC já é o dia
> seguinte: a janela andava um dia, o que vencia hoje sumia do KPI e **o card discordava do grid**
> — divergência que só aparece à noite, ou seja, some quando se vai conferir de manhã.
> ⚠️ **REINCIDIU nos DASHBOARDS — corrigido em 2026-08-15.** `dashboardWindow` ficou de fora
> daquela varredura e seguia em `toISOString()`, então as duas telas discordavam de `/consulta`
> sobre a MESMA pergunta. O defeito era pequeno até elas passarem a **abrir** em `vencendo7`, o
> único filtro que consome a janela: aí ele virou o estado de abertura. Medido no dia: **7 das 72**
> contas da janela sumiam, e na **virada do mês** a janela caía inteira no mês seguinte — dashboard
> **vazio**. `first`/`last` do mês continuam em `Date.UTC`, de propósito (a coluna é `date`). Borda
> travada em `services/dashboard.test.ts`, com relógio fixado às 23h30 locais — teste de janela sem
> relógio fixado **não distingue** fuso, e sem caso de borda não distingue largura (os dois eixos
> foram validados por mutante). O
> deslocamento é por **`setDate`**, não por aritmética de milissegundos: `setDate` normaliza a
> virada de mês sozinho (31/08 + 7 → 07/09) e respeita horário de verão, porque opera no
> calendário local; somar `7 * 86400000` erra o dia na transição de fuso), `csv.ts` (`csvCell` — célula CSV segura: escapa aspas, remove CRLF e **neutraliza
injeção de fórmula** `= + - @` no export de `/consulta`; segurança §5 M1), `cn.ts` (merge de
classes Tailwind — `clsx` + `tailwind-merge`, base do padrão CVA), `supabaseClient.ts`
(SDK oficial, só para auth), `authStorage.ts` (storage híbrido da sessão +
`setRememberPreference`/`getRememberPreference` — preferência "Lembrar-me"; ver
seção Autenticação), `getStatusExplanation.ts` (texto pt-BR no `Alert` do card de `/emails`
explicando por que um e-mail ficou em `falha` (error), `pendente` (warning) ou `ignorado`
(info); reusa `getFailureReason.ts` para o caso `falha`), `chunkReload.ts` (recuperação de
chunk lazy obsoleto: `isChunkLoadError`/`reloadOnceForChunk`/`installPreloadErrorReload` —
ver "Build e code-splitting") e `markdownLite.ts` (parser puro do subconjunto de markdown que o
chat de IA produz → blocos; devolve ESTRUTURA, nunca HTML — ver "Chat de IA").

Em `tests/` (fora de `src/`) ficam a infra de a11y e os guardas de configuração:
`setup.ts` (matcher `toHaveNoViolations`), `axe.ts` (runner AA + `color-contrast`
desligado), `contrast.a11y.test.ts` (contraste dos tokens do projeto),
`contrast-usage.a11y.test.ts` (cores default do Tailwind em uso, com ratchet `it.fails`)
e **`vercel-config.test.ts`** (schema do `vercel.json` + as regras de deploy que não podem
regredir — ver "Deploy do frontend"). Camada de navegador em `e2e/` (Playwright + axe).
Ver regra mandatória 6.

### Guia de cores — paleta `loginGreen` (`@theme` em `apps/frontend-vite/src/index.css`)

Telas de auth usam **essencialmente** estes tokens:

| Token | Hex | Uso |
|---|---|---|
| `loginGreen-ink` | `#0c1e14` | títulos, labels, texto de input |
| `loginGreen-inkMid` | `#2a3d30` | textos secundários ("lembrar-me") |
| `loginGreen-inkMuted` | `#4a6b55` | labels sociais, divisores |
| `loginGreen-inkFaint` | `#558a6d` | ícone olho — AA ≥3:1 sobre o campo (1.4.11) |
| `loginGreen-placeholder` | `#437355` | placeholder (`placeholder:text-loginGreen-placeholder`) — AA ≥4.5:1 sobre o campo |
| `loginGreen-field` | `#eef9f3` | fundo dos campos |
| `loginGreen-fieldFocus` | `#e4f6ec` | fundo em foco |
| `loginGreen-socialBg` | `#f4fcf7` | fundo dos círculos sociais |
| `loginGreen-border` | `#94D0AE` | borda principal (frame externo) |
| `loginGreen-borderLight` | `#c6e8d3` | borda secundária |
| `loginGreen-borderField` | `#b8dfc8` | borda dos campos |
| `loginGreen-borderFocus` | `#2d8a52` | borda em foco, `accent-color` do checkbox |
| `loginGreen-accent` | `#1e7a40` | botão, links |
| `loginGreen-accentHover` | `#165c30` | hover do botão (`hover:bg-loginGreen-accentHover`) |
| `loginGreen-accentMuted` | `#6aaa85` | botão desabilitado (`disabled:bg-loginGreen-accentMuted`) |

Paleta `brand` (verde dashboard) e `auth` (azul/petróleo) são usadas nas demais páginas — não misturar com `loginGreen`.

> **Contraste AA travado:** `loginGreen-inkFaint`/`-placeholder` foram escurecidos para
> cumprir AA sobre o campo verde (≥3:1 ícone / ≥4.5:1 placeholder). Não clarear sem
> revalidar em `tests/contrast.a11y.test.ts`.

### Guia de cores — paleta semântica `status` (`@theme` em `src/index.css`)

Fonte de verdade para **feedback, badges e banners** em todo o app — usar estes tokens em
vez de cores default do Tailwind. Cada grupo tem `bg` (fundo suave), `fg` (texto/ícone) e
`border`; `error` ainda tem `solid`/`solidBorder` (badge crítico de fundo cheio). Todos
cumprem WCAG AA (verificado em `tests/contrast.a11y.test.ts`).

> **Não reintroduzir tokens semânticos não-`status-*`:** os tokens legados `--color-danger`/
> `--color-warning`/`--color-info` foram **removidos** (mortos — limpeza de CSS) por
> duplicarem `status-error-*`/`status-warning-*`/`status-info-*`. Também foram removidos do
> `index.css` os `@utility` órfãos `btn-ghost` e `table-row-hover`, o token duplicado
> `loginGreen-accentDark` (= `accentHover`) e os `@utility active`/`is-disabled` **standalone**
> (o `@utility nav-link` já cobre os estados via `&.active`/`&.is-disabled` — o uso
> `nav-link is-disabled` segue intacto), o token `loginGreen-surface` e — na varredura de
> 2026-07-21 — os tokens órfãos `sidebar-hover`, `sidebar-active` e `ink-muted` (este último
> já abandonado por reprovar AA: #94a3b8 sobre branco = 2,5:1; mantê-lo definido convidava a
> reintroduzir uma cor não-AA). O `@keyframes fadeInUp` **foi consolidado**: o bloco standalone
> (keyframe duplicado + `.animate-fade-in-up` que duplicava a utility do `@theme`) saiu, e
> `card`/`metric-card` passaram de `animation: fadeInUp` cru para `animation:
> var(--animate-fade-in-up)` — assim os três consomem a MESMA fonte e a animação não some em
> silêncio se a utility deixar de ser usada (o `@keyframes` do `@theme` só é emitido enquanto
> houver uso). Verificado no CSS BUILDADO: 6 regras de animação → 4, sem duplicata, com
> `card`/`metric-card` preservados.

| Token | fg / bg | Uso |
|---|---|---|
| `status-error-*` | `#b91c1c` / `#fef2f2` (border `#fecaca`) | erro, vencido, falha |
| `status-error-solid` | branco / `#dc2626` | badge crítico (`erro_api`) |
| `status-success-*` | `#15803d` / `#f0fdf4` | sucesso, pago, **extraído + recebido** (verde) |
| `status-warning-*` | `#b45309` / `#fffbeb` | atenção (cartório, erros de extração) |
| `status-info-*` | `#1d4ed8` / `#eff6ff` | informativo, a vencer, prorrogado, baixado |
| `status-source-*` | `#0f766e` / `#f0fdfa` | origem da extração (teal) |
| `status-neutral-*` | `#475569` / `#f8fafc` | neutro, cancelado, documento, **pendente + ignorado + duplicidade** (cinza slate-600) |
| `status-prorrogado-fg` / `status-baixado-fg` | `#7c3aed` / `#0e7490` | **só preenchimento gráfico** do donut + swatch da legenda no Dashboard (sem par bg/border; ≥3:1 sobre branco — 1.4.11). Travados em `tests/contrast.a11y.test.ts` |

Aplicação **sempre via `cva`**: `StatusBadge` (`statusBadge.variants.ts`), `Alert` (banner
de página) e `InlineMessage`. As quatro paletas — `brand` (verde dashboard), `auth`
(azul/petróleo), `loginGreen` (auth v2) e `status` (semântica) — **não se misturam**; cada
uma no seu contexto.

**Cards de KPI em `/emails` espelham o badge** (`CARD_TONE` em `Emails.tsx`): ícone + número
de cada card usam a mesma cor do `StatusBadge` do status; o card ativo (filtro) ganha anel +
fundo no tom. Esquema (decisão de UI): **Total**=preto (`text-gray-900`) · **Extraídos +
Recebidos**=verde · **Falha**=vermelho · **Pendente + Ignorados + Duplicidades**=cinza
(`neutral`). Ordem dos cards: Total · Extraídos · Recebidos · Pendente · Duplicidades ·
Ignorados · Falha. Ao mudar a cor de um status, mexer **só** no `STATUS_VARIANT`
(`statusBadge.variants.ts`) — o card herda pelo `CARD_TONE` apontando o mesmo token.

### Destaque dos cards de KPI (`KpiCard`, `kpiCard.variants.ts`) — não regredir

Os 5 cards da faixa superior dos **dois** dashboards são botões que aplicam o filtro de KPI.
O bloco era **duplicado literalmente** em `Dashboard.tsx` e `DashboardFinanceiro.tsx`; virou o
componente compartilhado `KpiCard` + `cva` — qualquer ajuste vale para as duas telas de uma vez
(há teste de paridade em `Dashboard.test.tsx`). Estados e as razões de cada escolha:

| Estado | Classes | Por quê |
|---|---|---|
| Repouso | `bg-white border-l-4` + cor do `tone` | barra lateral de 4px (era 2px) — visível sem depender de hover |
| **Hover** | `hover:bg-slate-50 hover:shadow-md hover:-translate-y-0.5` | o hover antigo (`shadow-xs`→`shadow-sm`) era imperceptível e o card não parecia clicável. `-translate-y` é **transform** — não desloca os vizinhos (engrossar a borda no hover deslocaria) |
| **Ativo** (filtro em vigor) | `ring-2 ring-brand ring-offset-1 ring-offset-white shadow-md` + selo **"filtrando"** no corpo | o selo é **exigência da WCAG 1.4.1**: sem ele o anel colorido seria o ÚNICO indicador do estado |
| **Foco** (teclado) | `focus-visible:ring-2 focus-visible:ring-brand-dark focus-visible:ring-offset-2` | **cor e halo DIFERENTES do ativo** (WCAG 2.4.7). Eram iguais (`ring-brand` nos dois) e chegar por teclado ao card já selecionado não mudava nada na tela |
| Movimento reduzido | `motion-reduce:transition-none motion-reduce:hover:translate-y-0` | respeita `prefers-reduced-motion`; o hover continua legível pelo fundo + sombra |

**Armadilhas travadas por teste** (`KpiCard.test.tsx`), não reintroduzir:

- **Nada de `hover:ring-*`** — disputaria `--tw-ring-width` com o anel do ativo e o hover
  **apagaria** o destaque do card selecionado.
- **`bg-slate-50` é o limite do hover**: é o tom mais escuro em que TODO texto do card ainda
  cumpre AA (`slate-500` = 4,55). Com `bg-slate-100` o `slate-500` cai para 4,34 e reprova.
- **Não tintar o CARD de `bg-brand-light`** (ideia descartada na revisão): derrubaria
  `slate-500` para 4,19 e `status-success-fg` para 4,42 — abaixo dos 4,5 de AA. A tintura
  ficou só no selo (`brand-dark` sobre `brand-light` = 5,46).
- `ring-offset-white` **explícito** nos dois anéis — a cor do halo depende do fundo atrás do
  card (hoje o `<main>` é branco) e o default do Tailwind não é contrato.

Todos esses pares estão no `COMPLIANT` de `tests/contrast-usage.a11y.test.ts` (o jsdom não avalia
`color-contrast`, então a asserção numérica é a única rede aqui).

**Ativo ≠ aberto filtrado:** o card só fica marcado quando `filter === kpiFilter` e o KPI não é
`total`. Desde 2026-08-15 as **DUAS** telas abrem com **"A vencer em 7 dias"** marcado (antes era
"A vencer" no financeiro e nenhum card no de vencimentos).

### Casca compartilhada dos dashboards (`useDashboardFilters` + `DashboardHeader` + `KpiRow`) — não reduplicar

As duas telas compartilham **três** peças; juntas, elas são a "casca" do dashboard. O cabeçalho
era **84 linhas duplicadas literalmente** (com 3 diferenças: título, assunto do subtítulo e o
`id`/`name` do `<select>`), e as páginas ainda duplicavam **o estado** — seis `useState`, o
`toggleFilter` e os blocos de chamada dos componentes:

| Peça | Papel |
|---|---|
| `hooks/useDashboardFilters.ts` | **Estado** mês/ano/escopo/filtro/empresa + `toggleFilter`/`clearFilter` + as opções de empresa. Parametrizado pelo filtro inicial — hoje **`'vencendo7'` nas duas telas**. 🔴 **`setMonth`/`setYear` LIMPAM o filtro de KPI** (e só quando o valor muda de fato): `vencendo7` é uma janela MÓVEL a partir de hoje, então só intersecta o mês corrente — grudado, ele devolveria "Sem contas no período." em tudo ao trocar de mês, culpando o PERÍODO por um recorte que é do FILTRO. **`setScope` NÃO limpa**, de propósito: "todas as contas" + próximos 7 dias é combinação válida |
| `DashboardHeader.tsx` | Título + "filtrando: X ✕" e a barra **empresa · escopo · mês · ano · Atualizar**. Recebe `title`/`subject`/`idPrefix` + o objeto `filters` |
| `KpiRow.tsx` | A faixa dos 5 cards (grid + `map` sobre `KpiCard`). **A regra do "ativo" mora aqui**: o KPI `total` é a AUSÊNCIA de filtro, então nunca aparece selecionado |

Com isso as páginas caíram de **301→181** e **264→140** linhas, e sobrou nelas só o que é
realmente específico: o serviço que chamam, o array `kpis` e os gráficos.

- **O hook NÃO carrega dados de propósito:** `load()`/`data`/`loading`/`error` ficam na página,
  porque cada dashboard chama um serviço distinto (`getDashboardData` ×
  `getFinancialDashboardData`) com formato de resposta próprio — puxar isso para o hook exigiria
  genéricos e um parâmetro de serviço, acoplando-o ao que cada página tem de particular.
- **O header recebe UM objeto `filters`, não 12 props soltas.** Com props soltas, as duas páginas
  repetiriam a mesma lista linha a linha na chamada — foi exatamente o que reprovou o quality gate
  do SonarCloud por **duplicação no código novo** (6,3% > 3%) na primeira tentativa desta extração.
- **Apresentacional puro:** o header não tem estado nem busca dados; só renderiza e delega.
- **`KPI_FILTER_LABEL` mora em `components/dashboard/constants.ts`** (fonte única — constante PURA, sem componente, para ser importável por páginas sem disparar `react-refresh/only-export-components`). Consumido pelo `DashboardHeader` (chip "filtrando: X") e, via **`kpiFilterSuffix(filter)`** — o helper que vive no mesmo arquivo —, pelos subtítulos de card das **DUAS** telas: o donut "Classificação Financeira" de `/dashboard_despesas` e, desde 2026-08-15, "Movimentações mês a mês" + "Contas críticas e prioritárias" de `/dashboard_vencimentos`. Formato `Julho - A vencer`; `total` devolve string vazia.
  🔴 **O sufixo é a RESSALVA de que o número exibido é um recorte, e o separador ` - ` é semântico** — ` · ` junta partes do rótulo ("Por status · Agosto"), ` - ` marca o filtro. Ele existe porque um card que afirma um escopo mais largo do que mostra faz o leitor concluir o oposto do dado: "Contas críticas e prioritárias" promete "…e vencidas" enquanto `vencendo7` exige situação "a vencer" (mutuamente exclusivos **por construção** — a lista abre sem nenhuma vencida), e "Movimentações mês a mês" declara o ANO inteiro desenhando ~1 barra, porque `fYear` também é filtrado. É a mesma família do balde parcial da migration 124. **Helper compartilhado de propósito:** com uma cópia por página, o primeiro ajuste numa delas faria as telas divergirem justamente na regra que existe para não enganar.
- **`idPrefix`** gera `id`/`name` distintos por página (`dashboard-company` ·
  `dashboard-financeiro-company`): as telas não coexistem no DOM, mas ids separados mantêm o
  autofill/histórico do Chrome sem misturar.
- **Meses no escopo `all`:** ficam esmaecidos + `pointer-events-none` + `aria-hidden` **e
  `disabled`**. O `disabled` **não é redundante** — sem ele os botões seguiam na ordem de TAB
  dentro de um contêiner `aria-hidden`, ou seja, o teclado alcançava um controle que o leitor de
  tela não anuncia (axe `aria-hidden-focus`, WCAG 4.1.2). Era um defeito **pré-existente** nas duas
  páginas, que a extração expôs; travado em `DashboardHeader.test.tsx`.
- **A faixa `h-0.5 bg-linear-to-r` acima do header NÃO entrou no componente** de propósito: ela é
  padrão de **todas** as 6 páginas (Consulta, Emails, cobrança…), não da casca do dashboard —
  embuti-la aqui deixaria 2 páginas com a faixa dentro do header e 4 com ela solta.

Testes: `DashboardHeader.test.tsx` (identidade, os 5 controles, ✕ do filtro, loading) +
`DashboardHeader.a11y.test.tsx` (axe nos dois estados que mudam a árvore acessível).

### Guia de cores — grid de dados (`DataGrid`, `dataGrid.variants.ts`)

O `DataGrid` é **chrome de tabela neutro**, não estado semântico — por isso usa as escalas
neutras default do Tailwind (exceção explícita à regra "não usar cores default" da Regra 1,
que vale só para **estados semânticos**). Dois temas via `variant`:

| Tema | Uso | Neutro | Header/célula |
|---|---|---|---|
| `default` | `/consulta` | `slate-*` | `.table-header` / `.table-cell` |
| `silver` | `/emails` | `zinc-*` | `.table-header-silver` / `.table-cell-silver` |

Linha selecionada usa o acento `brand` (`bg-brand/10 border-l-2 border-brand`); o **hover** é
cinza neutro (`hover:bg-slate-100` no tema `default`, `hover:bg-zinc-200` no `silver`) para
contrastar com o verde da selecionada. Quando há coluna **fixada à esquerda** (ex.: a de
seleção), a 1ª célula fixada opaca cobriria o `border-l` do `<tr>`, então o acento é repintado
nela via box-shadow inset brand (variante `selected` do `pinnedCell`, aplicada só à primeira
célula left-pinned da linha selecionada). O `StatusBadge` dentro das células continua na paleta
`status`. Cada slot (header, row, cell, skeleton, empty, sub-linha de detalhe) é um `cva`
próprio com a base + o neutro do tema — string literal completa.

> **Contraste AA do texto do grid (não regredir):** o "chrome neutro" vale para
> **fundos/bordas e ícones SVG** (grip, sort, skeleton) — o axe `color-contrast` checa **só
> texto**, então ícone claro não é flagado. Mas **todo TEXTO** do grid precisa cumprir AA: a
> varredura em navegador (`e2e/`) reprovava `slate/zinc-300/400` na sub-linha de detalhe e nos
> cabeçalhos. Mínimos travados: `table-header`/`-silver` = `slate-600`/`zinc-600`;
> `secondText` (sub-linha) `label`/`sep` = `*-500`, `value` = `*-600`; `emptyText` = `*-500`.
> Botão/badge com **texto branco** usa `bg-brand-dark` (não `bg-brand` sólido, que dá só
> 3,4:1) — ver `DensityButton`/`PinButton`. Foi o axe em navegador que provou que a antiga
> "exceção" cobria texto demais.

### Guia de tamanhos — tokens Tailwind em uso

Usar o token mais próximo; valor arbitrário só como exceção documentada (ver abaixo).
A login passou por compactação para centralizar melhor o card, depois por uma **redução
global de ~20%** (×0,8) e, mais tarde, por um **aumento global de ~10%** (cada valor foi
multiplicado por 1,1 e snapado ao token Tailwind mais próximo — por isso alguns tokens
sobem um passo cheio, ex.: `h-8`→`h-9`, `text-xs`→`text-sm`) — os valores abaixo são os
**atuais** (não os do design original).

> **Snap aplicado em todo o app (não só na login):** tamanhos arbitrários de fonte foram
> eliminados — `text-[9px]/[10px]/[11px]` → `text-xs`, `text-[13px]`/`body` → `text-sm`,
> `tracking-[0.15em]` → `tracking-widest`. **Não reintroduzir `text-[Npx]`**; o corpo
> (`body` em `index.css`) é `text-sm` (14px) e as classes utilitárias `.table-header*` /
> badge base usam `text-xs`. As únicas exceções arbitrárias aceitas seguem sendo as de
> layout (ver abaixo) — nunca tipografia.

**Tipografia:**

| Classe | Tamanho | Uso no projeto |
|---|---|---|
| `text-sm` | 14px | labels sociais ("fale com a gente"), rótulos dos círculos, labels/inputs/erro dos campos (`FilledTextField`) — subiram de `text-xs` no aumento de ~10% |
| `text-base` | 16px | "lembrar-me", erro inline, links, subtítulo do login + texto do botão primário (`AccentPillButton`) — subiram de `text-sm` no aumento de ~10%; também o corpo padrão do restante do app |
| `text-2xl` | 24px | h1 do login ("Login") — mantido (24×1,1=26,4 snapa de volta a `text-2xl`) |

**Espaçamento e dimensões recorrentes (login page):**

| Classe | px | Uso |
|---|---|---|
| `h-9` | 36px | altura dos campos de input (`FilledTextField`) — subiu de `h-8` no aumento de ~10% |
| `h-11` | 44px | altura do botão primário (`AccentPillButton`) — subiu de `h-10` (40×1,1=44 exato) |
| `h-48` | 192px | altura do banner da login page — subiu de `h-44` no aumento de ~10% |
| `h-1` | 4px | divisor verde entre banner e card (decorativo — não escalado) |
| `w-11 h-11` | 44px | círculos sociais — subiu de `w-10 h-10` no aumento de ~10% |
| `w-7 h-7` | 28px | ícone dentro do círculo social — subiu de `w-6 h-6` |
| `w-3.5 h-3.5` | 14px | checkbox "lembrar-me" — subiu de `w-3 h-3` |
| `border-[6px]` | 6px | frame externo + moldura interna do banner (exceção arbitrária — subiu de `border-[5px]`) |
| `border-2` | 2px | borda dos campos e círculos (mantido — 2×1,1 snapa de volta a `border-2`) |
| `ring-4` | 4px | anel interno do card (`ring-inset ring-loginGreen-border/25`) — decorativo, não escalado |
| `rounded-xl` | 12px | border-radius do card/frame |
| `rounded-md` | 6px | border-radius de campos e botão |
| `gap-2.5` | 10px | espaçamento entre seções do formulário (mantido — 10×1,1 fica entre `gap-2.5`/`gap-3`) |
| `gap-1` | 4px | label↔campo e círculo↔rótulo social |
| `gap-7` | 28px | espaçamento entre círculos sociais — subiu de `gap-6` no aumento de ~10% |
| `my-2.5` | 10px | folga vertical extra do botão Login (acima/abaixo, somada ao `gap-2.5`) |
| `px-5` | 20px | padding horizontal do card (mantido — fica entre `px-5`/`px-6`) |
| `pt-2` / `pb-2.5` | 8px / 10px | padding vertical do card (topo/base) |
| `px-3` | 12px | padding horizontal dos campos |
| `max-w-[21rem]` | 336px | largura máxima do frame (exceção arbitrária — ~10% acima de `max-w-[19rem]`) |

**Exceções de valor arbitrário aceitas (login page):**

- `max-w-[21rem]` — 336px; não há token entre `max-w-xs` (320px) e `max-w-sm` (384px), então
  o valor de layout é arbitrário para honrar o aumento de ~10% sobre o antigo `max-w-[19rem]`.
- `border-[6px]` — 6px não existe na escala (`border-2`/`-4`/`-8`); usado no frame e na
  moldura do banner por decisão visual (5×1,1≈6, após o aumento de ~10%).
- `object-[center_25%]` — enquadramento do banner sem token equivalente.
- `w-[calc(100%+2px)] max-w-none -ml-px` no `<img>` do banner — "sangra" 1px para cada
  lado, recortado pelo `overflow-hidden` do frame, para **eliminar o risco escuro** que a
  coluna de pixels da borda da imagem deixava contra a moldura verde.

**Fonte customizada:**

`font-jakarta` → `Plus Jakarta Sans` (Google Fonts, carregada em `app/index.html`).
Aplicada no div raiz de `LoginPage.tsx`; herda por cascata para todos os filhos.

## Pontos-chave que exigem ler vários arquivos

### `run_reader()` é a única fonte de verdade da leitura

`skills/email-reader/scripts/read_emails.py` — tanto o CLI quanto `server/app.py`
chamam `run_reader()`. Edite só ali — nunca duplique lógica no Flask.

`read_emails.py` carrega o `.env` da raiz (`load_dotenv(parents[3]/".env")`).
`server/app.py` insere o caminho no `sys.path` e importa o módulo.

### Robustez da leitura e da extração (não regredir)

Proteções aprendidas "na dor" — manter:

- **IMAP com timeout** (`_connect_imap`, `IMAP_TIMEOUT_SECONDS`, env `IMAP_TIMEOUT` default
  120s): sem timeout de socket, um `fetch` que estanca (mensagem grande, hiccup do servidor)
  **congela o run síncrono para sempre**. Com timeout, levanta `socket.timeout`, o e-mail é
  pulado/erra e o run segue. **Nunca** criar `IMAP4_SSL` sem `timeout`.
- **IMAP com retry/backoff** (`_connect_and_search`, `IMAP_MAX_ATTEMPTS` default 3,
  `IMAP_RETRY_BACKOFF` default 5s): connect + select + search são uma **unidade resiliente** —
  uma falha transitória (timeout de socket, `imaplib.IMAP4.abort`) refaz a sequência (nova
  conexão) com espera crescente. Erro de protocolo/login (`imaplib.IMAP4.error` puro) **não**
  repete (retry ali é inútil). Esgotadas as tentativas, levanta `RuntimeError` → o caller HTTP
  devolve `502`. `run_reader` monta o `criteria` **antes** de chamar `_connect_and_search`.
- **IMAP fechado em `try/finally`** (`run_reader`): o loop de leitura é envolto em `try` com
  `mail.logout()` no `finally` (best-effort) — uma exceção inesperada que escape do loop **não**
  deixa a conexão IMAP aberta. Os scripts manuais `reprocess_link_emails`/`reprocess_body_emails`
  seguem o mesmo padrão (logout em `finally`) e usam `_rfc822_from_fetch` (não `md[0][1]` direto).
  Teste: `tests/test_run_reader_logout.py`. **Nunca** voltar o `logout()` para fora do `finally`.
- **Reprocessadores abrem IMAP pelo helper canônico (A4-1 — não regredir):** os 3 scripts de
  reprocessamento manual (`reprocess_body_emails.py`, `reprocess_link_emails.py`,
  `reprocess_message.py`) conectam por **`R._connect_imap()`** (timeout de socket + login + select),
  não por `imaplib.IMAP4_SSL(...)` cru — um `fetch` que estanca não congela o reprocessamento.
  (`reprocess_ignored_emails.py` já usava.) **Nunca** reintroduzir `IMAP4_SSL` cru nesses scripts.
- **Claude API com timeout** (`extract_pdf.py`, `CLAUDE_API_TIMEOUT_SECONDS`, env
  `CLAUDE_API_TIMEOUT` default 90s): mesma classe de falha do IMAP. Sem `timeout` explícito o
  SDK Anthropic usa ~10 min/request; num run síncrono que processa muitos PDFs, **um request
  travado congela o pipeline inteiro**. As 3 instâncias `anthropic.Anthropic(...)`
  (`_try_barcode_vision`, `extract_with_vision`, `extract_fields_with_claude`) **sempre** passam
  `timeout=CLAUDE_API_TIMEOUT_SECONDS`. **Nunca** criar o client sem `timeout`.
- **Extração IN-PROCESS (não regredir — 2026-06-22)**: `run_extraction` chama
  `extract_pdf.extract_to_csv()` **no mesmo processo**, via import lazy — **não** mais um
  subprocesso `python extract_pdf.py`. Motivo: na busca geral de 2026-06-22, **100% das
  extrações falharam** com `rc=0xC0000142` (STATUS_DLL_INIT_FAILED) quando o spawn de
  subprocesso partia do processo do Flask — o subprocesso nem inicializava (DLLs nativas de
  pandas/Pillow não carregavam naquele contexto de *desktop heap*). O caminho do corpo
  (in-process) seguia funcionando; só o de PDF (subprocesso) caía. Chamar a função direto
  **elimina a criação de processo** → funciona idêntico no app (Flask), no CLI e no scheduler,
  e ainda evita reimportar pdfplumber/pandas/anthropic por PDF. **Nunca** voltar a
  `subprocess.run([sys.executable, extract_pdf.py])`. Ver memória `pdf-extraction-dll-init-fail`.
- **`run_extraction` resiliente**: retorna `(csv_path, motivo)`. `_run_extraction_once`
  classifica a falha — **transitória** (exceção de I/O/runtime → repete com backoff;
  `EXTRACTION_MAX_ATTEMPTS=3`/`EXTRACTION_RETRY_BACKOFF`) vs **definitiva** (extração não gerou
  registros → não repete). O `motivo` é gravado em `email_processing_errors.raw_payload`
  (`detalhe`) e fica **visível em `/erros`** — antes só ia para o console do Flask, fazendo um
  blip transitório parecer "tudo quebrado".
- **FETCH RFC822 robusto** (`_rfc822_from_fetch`): o `imaplib` pode **intercalar** respostas
  (um `FLAGS`/`UID` isolado como item `bytes`) no retorno do `fetch`. Aí `data[0]` não é a
  tupla `(meta, raw)` e `data[0][1]` indexa um `bytes`, devolvendo um **int** — e
  `email.message_from_bytes(int)` quebra com `'int' object has no attribute 'decode'`
  (crash intermitente). `process_message` usa `_rfc822_from_fetch(data)`, que varre `data`
  e pega a primeira tupla cujo 2º elemento sejam bytes. **Nunca** voltar a `data[0][1]` direto.
- **Reprocesso sem perda de dado** (`scripts/reprocess_ignored_emails.py`): a Fase A **não
  apaga** a linha de `email_control` antes de reprocessar — roda `process_message` (que
  re-registra com `ignore-duplicates` e cria a conta) e só então faz `PATCH` do status. Apagar
  antes arriscava perder o e-mail se a extração falhasse.

- 🔴 **Resposta do modelo TRUNCADA nunca vira dado — e uma LEITURA pode devolver N pagáveis**
  *(lição de 2026-08-07; 3 e-mails, 21 boletos, R$ 315.556,57 perdidos em silêncio)*. Boleto
  **escaneado** chega como um PDF de 6-8 páginas **sem texto**: `_payable_pages` depende de texto,
  devolve 0, e o arquivo inteiro vai numa única leitura Vision. O modelo lia todos os boletos e
  respondia um **ARRAY** — cortado no teto de **1200** tokens (`stop_reason='max_tokens'`). O JSON
  truncado não parseava, virava um registro **vazio**, e o e-mail era logado como **`sem_valor`**:
  a falha do EXTRATOR disfarçada de "documento sem valor". Três correções, cada uma necessária:
  1. **`VISION_MAX_TOKENS` (8000, env)** — medido ~330 tokens/boleto; 1200 cortava antes do 3º.
  2. **`_response_text` recusa `stop_reason='max_tokens'`** (`VisionTruncatedError`) — sem checar o
     stop_reason o corte é **invisível**. Ela **não** é "API indisponível": confundi-las abortaria o
     LOTE por causa de um documento grande. Aproveitar o pedaço parcial foi **descartado** — gravaria
     alguns boletos e perderia os demais calado, que é o próprio defeito.
  3. **`build_records` aceita ARRAY → N registros** (`_json_records`). Mesmo com JSON íntegro o
     array quebrava: `build_record_from_json` espera `dict`. É o que cobre o carnê **escaneado**,
     que o split por página nunca alcança.
     🔴 **N registros só no caminho VISUAL — e o `pdf_text` precisa da própria saída.** O
     `EXTRACTION_PROMPT` é **compartilhado**, então o modelo passou a devolver ARRAY também no
     texto; lá o array não pode virar N contas, porque o pós-processamento
     (`extract_linha_digitavel(raw)`, `apply_*`) é do documento INTEIRO e daria a **todas** o
     barcode da primeira — colisão na dedup, e as demais somem. Sem tratamento, o array caía no
     `except` genérico (`AttributeError: 'list' object has no attribute 'get'`) e virava **1 conta
     de regex marcada como `pdf_text` = sucesso**, com os outros pagáveis perdidos em silêncio —
     o próprio defeito que este bloco existe para matar, pela outra porta. Hoje
     `_build_records_text` detecta ≥2 itens e devolve `_failure_record`; **sem `amount`, isso cai
     no fallback tier-2**, que manda o PDF inteiro ao Vision — o caminho que aceita array — e o
     documento acaba virando as N contas com o barcode de CADA item. Travado em
     `CaminhoTextoTest` (`tests/test_vision_multi_boleto.py`).
  🔴 **Resposta não-JSON agora é `_failure_record`, não registro vazio.** É o que tira a linha do CSV
  — e sem CSV o e-mail deixa de ser `extraído` **com 0 contas** (invisível em `/emails`, o mesmo modo
  de falha do boleto T.R.T) e volta a `pendente`, reprocessável. `_parse_json_payload` ainda tolera
  prosa em volta do JSON, que antes derrubava uma resposta perfeitamente válida.
  ⚠️ **Ao contar contas de um e-mail, casar `gmail_message_id` com `LIKE '<id>#%'`** — múltiplos
  pagáveis recebem sufixo `#N`; a igualdade simples devolve 1 e simula perda que não houve.
- 🔴 **Barcode de scan que se REFUTA é DESCARTADO — código errado é pior que ausente**
  (`barcode_self_refuted`, `febraban.py`; *medido em 2026-08-07 sobre as 442 contas com barcode*).
  O OCR de boleto escaneado **desloca dígitos**: o código continua com 44 — passa no filtro de
  COMPRIMENTO, a única validação que havia — mas os campos saem deslocados uma casa, com valor
  exatamente **10×** o do documento e fator impossível (5370/5380/5420 onde o correto era 1537,
  que reproduz o vencimento real). Auditoria: **349 consistentes · 68 não-boleto · 7 em que só o
  valor diverge (preservados) · 18 corrompidos, 100% `pdf_vision`** — soma 442, e é a soma que
  torna o número conferível: enquanto a 4ª parcela ficava de fora, "19 corrompidos · 6 só-valor"
  fechava igualmente bem e sobreviveu em `febraban.py` e no teste até ser re-medida no banco em
  2026-08-08. O gate exige que **os DOIS** testes falhem — valor embutido × `amount`, e
  fator decodificável em data plausível: um `amount` mal lido ainda tem fator bom, e vice-versa;
  a conjunção é o que preserva os casos em que só um diverge.
  **Isto é proteção CONTRA DUPLICATA, não contra ela:** o barcode é a impressão digital 1 da dedup,
  a mais forte. Código corrompido **não casa o boleto real** quando ele volta pela 2ª via — a dedup
  falha e nasce conta **duplicada**. Sem barcode, a dedup cai nas impressões 2/3 (documento+valor,
  valor+vencimento), que funcionam. Os 18 já gravados foram limpos (`barcode = NULL`) com prova por
  **hash**: 784 contas antes e depois, conteúdo idêntico.
  Três detalhes que o gate errou antes de acertar, e que não devem regredir:
  1. **`ref_date` é a data LIDA DO DOCUMENTO, nunca "hoje"** — num reprocessamento histórico o
     fator legítimo fica a mais de 2 anos de hoje e o código bom seria apagado.
  2. **Fator 0 = boleto À VISTA, legítimo** — sem essa saída o gate lê "ausência de prova" como
     "prova de erro".
  3. **O descarte roda ANTES dos `apply_*`** — depois deles, `apply_barcode_amount` já teria
     gravado o valor 10× na conta quando o documento não expõe valor legível.
  ⚠️ **Releitura NÃO recupera** o código: o mesmo PDF relido devolveu barcodes de formato válido e
  ainda assim 10× errados. Tentar reconstruir dígitos é adivinhação — não fazer.
- **Assinatura de e-mail descrita pelo CONTEÚDO** (`_is_contact_block`, `read_emails.py`): o Vision
  descreve a `image001.png` do rodapé como *"Rua do Horto, 940 | CEP … | (37) 3249-4200 |
  www…"*, e não como "assinatura de e-mail" — único termo que `_SIGNATURE_DESC_RE` reconhecia. A
  assinatura virava `sem_valor`. O detector exige **≥2 sinais de contato E nenhum termo financeiro**:
  qualquer sinal de documento real (valor, vencimento, boleto, beneficiário) **desqualifica** o
  descarte. Conservador de propósito — linha a revisar em `/erros` é melhor que recibo perdido.
  Registro **sem descrição alguma** segue em `sem_valor`, visível: não há sinal seguro para pulá-lo.

Testes: `tests/test_run_extraction.py`, `tests/test_imap_timeout.py`, `tests/test_imap_retry.py`,
`tests/test_status_for_result.py`, `tests/test_rfc822_fetch.py`, `tests/test_extract_pdf_timeout.py`,
`tests/test_pdf_amount_validation.py`, `tests/test_vision_multi_boleto.py`, `tests/test_barcode_self_refuted.py`,
`tests/test_contact_block_nonpayable.py`.

### Deduplicação por `message_id`

Gravado em `email_control.message_id` (UNIQUE). `register()` usa
`Prefer: resolution=ignore-duplicates` — mensagens já processadas são ignoradas sem
atualizar o registro existente. Fallback local em CSV quando Supabase indisponível
(`SupabaseControl._available`).

### Fatura + boleto no MESMO e-mail → só o boleto vira conta (não regredir)

E-mail com **2 anexos** (uma **fatura/relatório** + um **boleto**) descreve **um único
débito**: "o boleto sempre vence". Regra (em `extract_and_store_accounts`):
- **fatura + boleto → extrai só o BOLETO** (a fatura é ignorada — geraria conta duplicada);
- **só fatura (sem boleto) → extrai a fatura** normalmente.

O sinal é o **CÓDIGO DE BARRAS** (`_is_boleto_barcode` — linha digitável 44 FEBRABAN moeda
'9' ou 48 de arrecadação) **+ o VALOR**, **NÃO** o `document_type`: o extrator rotula tanto o
boleto quanto o relatório como `boleto`, mas só o boleto tem linha digitável (o relatório traz
uma chave de 44 dígitos com moeda ≠ '9', ex.: padariabelga id 387). Por isso a decisão **não**
pode ser por `document_type`.

**GUARDA DE VALOR (não regredir — caso LMED id 519/520):** o descarte só vale para a linha
**sem** boleto próprio cujo **valor COINCIDE** com um boleto real do e-mail (a fatura/relatório
descreve o **MESMO** débito — mesmo valor). Uma linha de valor **DISTINTO** é **outra dívida** e
é **mantida mesmo sem barcode**. Isso cobre o **2º boleto ESCANEADO** (`pdf_vision`) cujo Vision
**não leu a linha digitável** — antes, bastava existir 1 boleto real para descartar QUALQUER
linha sem barcode, e o 2º boleto era **perdido silenciosamente** (e-mail "BOLETOS LMED": 2937
R$ 2.476,55 com barcode + 1748 R$ 1.166,67 sem barcode → só o 2937 virava conta). Bias
intencional: **preservar** a conta (perda silenciosa é pior que uma conta a revisar).

Implementação — `extract_and_store_accounts` roda em **DOIS PASSOS** (não regredir para o
loop anexo-a-anexo, que era cego ao resto do e-mail): **Passo 1** extrai TODOS os anexos e
coleta as linhas (`pending`); calcula `has_real_boleto = _email_has_real_boleto(pending)`
(algum anexo com boleto real) e `real_boleto_amounts = _real_boleto_amounts(pending)` (valores
dos boletos reais, normalizados por `_amount_key`). **Passo 2** grava as contas — uma linha
**sem** boleto próprio (`not _is_boleto_barcode(payload['barcode'])`) só é **ignorada** quando
`_amount_key(payload['amount']) in real_boleto_amounts` (mesmo valor de um boleto real → mesma
dívida). Skip intencional, logado, contado em `skipped_nonpayable`; **não** é `falha`. A regra
fica **acima** das validações (`sem_valor`/`sem_fornecedor`) e da dedup. Sem boleto no e-mail →
`real_boleto_amounts` vazio → nada descartado (a fatura é gravada). Casos preservados: carnê /
2 boletos reais (ambos com linha digitável → nenhum descartado); **2 boletos de valores
distintos, um sem barcode → ambos gravados**; boleto + guia com barcode de arrecadação (ambos
pagáveis). É **independente da ORDEM** dos anexos (o pré-scan do passo 1 decide antes de gravar).
Testes: `tests/test_fatura_boleto.py` (helper + fluxo completo com `run_extraction` mockado —
ordem inversa, valores distintos sem barcode, mesmo valor sem barcode ainda ignorado). **Limpeza retroativa** aplicada em 2026-07-03: hard delete de 7 faturas/relatórios
que coexistiam com o boleto do mesmo e-mail (ids 379/327/146/242/129/387/111; boletos
380/328/147/243/130/388/112 preservados) — todos os pares tinham valor idêntico.

**SEGUNDA GUARDA — EXTRATO/DEMONSTRATIVO/RELATÓRIO por NOME/DESCRIÇÃO, valor livre (id 605/606 —
não regredir):** a guarda de valor acima só pega o não-pagável cujo valor **coincide** com o
boleto. Um **extrato** descreve o mesmo débito de forma **agregada** e traz o **bruto**, que
DIFERE do **líquido** do boleto — então escapa de `real_boleto_amounts`. Falha real (Correios,
 e-mail "Sua Fatura Correios Empresas"): id **605** (`Extrato_sintetico_07.pdf`, sem barcode,
R$ 5.295,58) coexistiu com o boleto id **606** (linha digitável, R$ 5.158,34) — valores distintos
+ `sk_supplier` distintos → nenhuma das guardas casou e as **duas** contas foram criadas. Correção
(`read_emails.py`): `_is_statement_document(row)` (`_STATEMENT_DOC_RE` = `\b(extrato|extratos|
demonstrativo|relatorio)\b`, sobre `source_file` + `description` sem acento, com **separadores
normalizados** — `[\W_]+`→espaço, senão o `_` do nome de arquivo anularia o `\b`). No **Passo 2**,
`if has_real_boleto and _is_statement_document(row)` descarta a linha (`skipped_nonpayable`, não
`falha`), logo **após** a guarda de valor. **Escopo mínimo/robusto:** (a) só dispara com **boleto
real presente** no e-mail (a regra fatura+boleto); (b) o detector já retorna `False` se a linha tem
barcode; (c) **NÃO inclui `fatura`/`boleto`** nos termos — um **2º boleto ESCANEADO** cujo Vision
não leu a linha digitável (caso LMED) é uma **via de pagamento**, nunca um "extrato", então **não**
é descartado (não regride). Testes: `tests/test_fatura_boleto.py` (extrato por nome e por descrição
descartado; extrato SEM boleto no e-mail ainda extraído; 2º boleto escaneado preservado; unitário
do helper). **Limpeza retroativa** (2026-07-20): hard delete da conta **605** (o extrato); boleto
606 preservado.

### Documentos NÃO-pagáveis pulados no Passo 2 (baixa de recebível, assinatura/marketing — não regredir)

Duas guardas adicionais em `extract_and_store_accounts` **Passo 2**, no mesmo ponto e padrão
(`skipped_nonpayable`) dos skips CT-e/fatura+boleto — **acima** das validações
`sem_valor`/`sem_fornecedor`, para o e-mail virar `ignorado` (não `falha`) e **não logar erro**:

- **Baixa/cancelamento de RECEBÍVEL próprio** (`_is_receivable_notice(subject, description)`):
  e-mail sobre títulos que a **empresa EMITIU** (relatório de baixa/cancelamento, ex.: assunto
  "COBRANÇA OTIMOTEX" / "Cobranças não enviadas", ou descrição "Cancelamento (Baixa)…") — não é
  conta a pagar. Sinais: `_RECEIVABLE_SUBJECT_TERMS` (assunto) ou `_RECEIVABLE_DESC_RE` (descrição).
- **Conteúdo visual sem valor** (`_is_nonpayable_visual(row)`): imagem de **assinatura/logo de
  e-mail** (`image001.png` colada no corpo, Vision descreve "Assinatura de e-mail comercial") ou
  **apresentação/proposta de marketing** (ex.: GNW Business). **Conservador:** só dispara com
  `amount<=0` **E** sem código de barras — recibo/boleto legítimo (inclusive inline) tem valor
  e/ou linha digitável, então nunca cai aqui. Regex `_SIGNATURE_DESC_RE`/`_MARKETING_DESC_RE`
  sobre a `description`. **Limitação conhecida:** quando o Vision devolve só o contato cru (nome +
  telefone) em vez de "assinatura", a imagem não casa e cai em `sem_valor` (ex.: assinatura da
  Saito no e-mail de locação) — aceitável, vira lançamento manual.

Testes: `tests/test_nonpayable_rules.py`.

### SEGURADORA: só boleto com linha digitável válida vira conta (não regredir)

Regra de negócio (pedido do usuário, 2026-07-28): e-mail de **seguradora** só gera conta a
pagar quando traz um **boleto com linha digitável válida**; sem boleto válido o e-mail vira
**`ignorado`** (não `falha`). O pagável resultante é rotulado **`document_type='seguro'`**.

**Contexto detectado SÓ PELO ASSUNTO** (`_is_insurance_context(subject)` — `seguro`,
`seguros`, `seguradora(s)`, `apólice(s)`, palavra inteira sem acento). **Não ampliar para
`supplier_name` nem para o domínio do remetente** — "Porto Seguro" é fornecedor legítimo de
vários ramos, e o critério mais amplo DESTRUIRIA contas que existem hoje (verificado no banco):

| conta | assunto | por que sobrevive |
|---|---|---|
| **348** `BOLETO - PORTO SAÚDE` | fornecedor `PORTO SEGURO - SEGURO SAUDE S/A`, **sem barcode** | o assunto não tem o termo → o gate não a apaga |
| **58** `Rastreador - Demonstrativo fatura` | remetente `@portoseguro.com.br`, veio do **corpo**, sem barcode | idem |
| **617** `Rastreador - Demonstrativo fatura` | rastreador veicular, não é seguro | não é re-rotulado `seguro` |

**Uma única condição no Passo 2** (`extract_and_store_accounts`, acima de
`payable_attempts += 1` — é o que produz `ignorado` em vez de `falha`) cobre as duas metades:
e-mail COM boleto → o boleto grava e o **"conjunto faturamento"** que vem junto é descartado;
e-mail SEM boleto → todas as linhas caem em `skipped_nonpayable` → `nonpayable_only` →
`ignorado`. No **corpo** (`try_extract_from_body`) a mesma regra: sem sinal financeiro →
`BODY_IGNORED`; com valor mas sem linha digitável → `BODY_IGNORED`; **com** linha digitável no
corpo → a conta É criada (a guarda não é um bloqueio cego do e-mail de seguradora).
`_apply_seguro_doc_type` roda **abaixo** de utility/tributo/transporte/cartório e só re-rotula
tipos genéricos (`boleto`/`outro`/`""`) — guia de tributo cobrada por seguradora continua guia.

**Risco residual aceito:** boleto de seguradora cuja linha digitável o Vision não leia passa a
ser ignorado em vez de virar conta (classe da conta 348). Contido pela detecção por assunto.
Sem migration (`seguro` já está no enum e no CHECK 087) e sem `.env` (`seguro` já está em
`KEYWORDS_DEFAULT` e no `EMAIL_KEYWORDS` de produção — o `email_control` 1082 registrou
`keyword_matched='seguro'`). Testes: `tests/test_doc_type_seguro.py`,
`tests/test_body_seguro_ignored.py` e `SeguradoraBoletoGateTest` em `tests/test_fatura_boleto.py`.

**Caso de origem — o que estava quebrado (email_control 1082, "SEGUROS SURA VID_G_002…"):** o
e-mail **não tem anexo**; o boleto vem por **link** (tracker AWS SES → `mdi.li` → PDF no S3) e
falhava por **dois** motivos independentes: (1) o redirect ia para a **porta 7000**, barrada
pela allowlist de portas do guard anti-SSRF (ver "Boleto por link"); (2) o PDF entrega o texto
**espelhado**, então a linha digitável não saía (ver abaixo). Reprocessado em 2026-07-28 →
conta **715** (SEGUROS SURA S/A, R$ 133,94, venc. 10/08/2026, `pdf_vision`, barcode Itaú com
fator 1534 conferindo com o vencimento). O e-mail **441** (mesma origem, junho) **não é
reprocessável** — não está mais na INBOX; segue em `falha`.

### PDF com texto ESPELHADO → Claude Vision (`extract_pdf.py` — não regredir)

Alguns boletos (caso SEGUROS SURA) são PDF **digital** cujo pdfplumber entrega **cada linha com
os caracteres invertidos**: `otnemicneV`=Vencimento, `49,331 $R`=R$ 133,94, `6202/80/01`=
10/08/2026, `A/S ARUS SORUGES`=SEGUROS SURA S/A. O volume de texto (~5 000 chars) passa longe do
limiar `len(raw) < 80`, então **não havia fallback** e o Claude recebia texto ilegível. Reverter
as linhas recupera prosa/valor/data/CNPJ, mas **não a linha digitável** — ela fica fragmentada e
intercalada entre colunas, e sem ela não há `barcode` (logo, pela regra acima, nenhuma conta de
seguradora fecharia). `is_mirrored_text(raw)` detecta e `_extract_records` manda ao **Vision**,
que lê a página **renderizada** (visualmente correta) e recupera a linha digitável.

Distinto de **`fix_reversed_lines`**, que anota com `[RTL: …]` **campos isolados** (CNPJ/data/
valor/nosso número) de uma coluna RTL — aquilo é por campo, isto é a página inteira. A heurística
é **por LINHA** (conta as linhas em que um rótulo de boleto só aparece na versão invertida,
mínimo 3), não por contagem global: o PDF da SURA é **misto** (páginas normais + a do boleto
espelhada) e um placar agregado poderia empatar. PDF normal não produz essas linhas → sem
regressão nem chamada Vision extra. Testes: `tests/test_mirrored_pdf_text.py`.

### Vencimento AUTORITATIVO pelo fator do código de barras (não regredir)

A data de vencimento de um boleto é **codificada pelo emissor no FATOR DE VENCIMENTO** do
código de barras FEBRABAN (posições 6-9, `d[5:9]`) — é **determinística** e imune à **inversão
dia/mês** que o Vision/OCR pode cometer ao ler a data IMPRESSA. Falha grave de origem (id 435):
boleto OBER cujo Vision gravou `2026-08-07` (07/08) no lugar de `2026-07-08` (08/07). Por isso,
sempre que houver boleto bancário com fator válido, o **vencimento derivado do barcode é a fonte
de verdade** e sobrescreve o valor extraído.

- **`due_date_from_barcode(barcode, ref_date)`** (`extract_pdf.py`): decodifica o fator só de
  **boleto bancário** (44 dígitos, moeda `'9'`, banco ≠ `000`); retorna `None` para fator 0
  (à vista), chave NF-e/CT-e ou arrecadação de 48. Trata o **reset da NT FEBRABAN** (o fator
  chegou a 9999 em 21/02/2025 e voltou a 1000 em 22/02/2025) escolhendo, entre a **base antiga**
  (`1997-10-07`) e a **nova** (`1000` = `2025-02-22`), a candidata mais próxima de `ref_date`
  (emissão/extração). As duas ficam ~24 anos distantes, então a escolha é **inequívoca**
  (`_FATOR_MAX_DELTA_DAYS = 730`: candidata a mais de 2 anos do ref é descartada).
- **`apply_barcode_due_date(rec)`** (`extract_pdf.py`): override idempotente do `due_date`, com
  `processing_notes`. Aplicado em `build_record_from_json`, `build_record_regex` e no dispatcher
  de texto `_build_records_text` (após o barcode ser recuperado por regex/Vision).
- **Rede de segurança UNIVERSAL** — `_apply_barcode_due_date(payload)` (`read_emails.py`) roda no
  **choke point único** `register_financial` (antes de `_apply_status_id`), cobrindo TODOS os
  caminhos de gravação do pipeline Python (PDF, corpo, reprocessos). Import lazy do `extract_pdf`,
  best-effort (qualquer falha é ignorada — não derruba a gravação). Contas do **corpo** não têm
  barcode → no-op.

- **GATE de CONSISTÊNCIA do barcode (id 463 — não regredir):** o fator só é AUTORITATIVO quando o
  barcode é **confiável** — o **valor embutido nele** (`amount_from_barcode`, posições 10-19) bate
  com o `amount` extraído (tolerância 1 centavo). Um barcode **mal lido pelo OCR** (comum em boleto
  **ESCANEADO** → `pdf_vision`) tem valor divergente e **NÃO** dita o vencimento. Falha real (id 463
  CIPATEX, e-mail "BOLETOS CIPATEX" com 3 anexos escaneados): o Vision leu a data impressa **certa**
  (`2026-07-10`) e o valor certo (R$ 32.400), mas leu o **barcode embaralhado** (valor R$ 2.026.142,93,
  fator 1259) — a regra do fator sobrescreveu o vencimento correto por `2025-11-08` (impossível: <
  emissão). A blindagem centraliza tudo em **`authoritative_barcode_due_date(barcode, amount, ref,
  issue_date)`** (`extract_pdf.py`), usada pelos **dois** pontos de aplicação (`apply_barcode_due_date`
  e a rede `_apply_barcode_due_date`): devolve o vencimento **só** com barcode consistente. Preserva a correção
  original (id 435: barcode consistente → corrige a inversão) e mata o novo erro (barcode corrompido →
  mantém a data impressa). **Varredura (2026-07-10):** dos 167 boletos, 6 têm barcode inconsistente;
  só o 463 fora vítima (os outros 4 com erro de casa decimal geram fator fora de faixa → `None`, nunca
  sobrescreveram; 194 já divergia). id 463 corrigido para `2026-07-10`.
- **GATE 2 — PLAUSIBILIDADE + PRIORIDADE da data impressa (id 473/474 — não regredir):** dois reforços
  para boleto **SECURITIZADO/renegociado** cujo fator da linha digitável ficou o ORIGINAL (stale) e
  diverge do vencimento IMPRESSO (HYOSUNG via SB Crédito: fator 1051 → 2025-04-14, mas impresso
  2026-07-21). (1) `authoritative_barcode_due_date` ganhou o parâmetro `issue_date` e rejeita
  (`None`) quando `venc < emissão` (impossível — fator stale/errado), além do gate de valor. (2)
  **A data de vencimento IMPRESSA no TEXTO do PDF é a fonte PRIMÁRIA** (análise do PDF real >
  LLM > fator): `extract_due_date_from_text(raw)` ancora no rótulo "Vencimento" (ignora "Data do
  Documento"/"Data Movto") e, quando plausível (≥ emissão), **vence** o LLM e o barcode em
  `_build_records_text` (caminho `pdf_text`). O fator só volta a mandar em PDF **escaneado** (sem texto —
  onde corrige inversão do Vision, id 435). **Coerência entre as duas camadas (não regredir):** a rede
  universal de `register_financial` NÃO reestraga a data impressa que o `_build_records_text` já gravou —
  para o boleto de texto, o **gate 2 (venc < emissão) rejeita** o fator stale (`None`), então a rede é
  no-op; para o escaneado, o fator consistente corrige a inversão. As duas camadas convivem sem
  conflito (verificado em payloads frescos). Dados: 473/474 (1 conta errada cada) → reprocessados em
  **8 contas** (ids 488-495, 4 parcelas/carnê, venc. 21/07…11/08/2026).
- **Split de carnê com linha digitável QUEBRADA (id 473/474 — não regredir):** `_payable_pages` detecta
  boletos por `extract_linha_digitavel`; num carnê HYOSUNG a linha vinha **quebrada em 3 linhas**
  (`…630000 1` / `ITAU 341-7` / `10510000356008`) e os 3 regex falhavam → 0 páginas → **1 conta em vez
  de 4**. Um 4º padrão em `extract_linha_digitavel` (captura os 4 campos + o 1º bloco isolado de 14
  dígitos, `re.DOTALL`, ignorando ruído no meio) restaura a detecção → carnê dividido em 1 registro por
  boleto. ✅ **A limitação do carnê ESCANEADO foi RESOLVIDA em 2026-08-07** — não por melhorar a
  detecção de páginas (ela lê TEXTO, e o scan não tem nenhum), mas aceitando **N registros por
  leitura Vision**: o modelo devolve um ARRAY com um objeto por boleto. Ver "Resposta do modelo
  TRUNCADA nunca vira dado" em "Robustez da leitura e da extração".
- **Split multi-pagável por INSTRUMENTO DE PAGAMENTO (id 575/593 — não regredir):** o split de
  `process_pdf` (que emite 1 registro por página → 1 conta) disparava **só** por linha digitável de
  boleto (47 díg — `_boleto_pages`/`extract_linha_digitavel`). Guia **sem** linha digitável —
  **FGTS Digital** (só **PIX Copia-e-Cola** + Identificador), DARF/guia de **arrecadação de 48
  díg** — não era detectada; o PDF ia inteiro ao Claude e voltava **1 registro** (o resto sumia
  **silenciosamente**). Caso real: PDF de 10 páginas com **2 guias FGTS** (Mensal R$ 18.613,57 +
  Consignado R$ 4.313,30) → só a 1ª virava conta (id 575); a 2ª foi recuperada (id 593) ao
  reprocessar. Correção: `_boleto_pages`→**`_payable_pages`** com um detector **genérico**
  `_page_has_payable(text)` = tem **instrumento de pagamento** — `extract_linha_digitavel` (47) **ou**
  `_text_has_arrecadacao_barcode` (48, ancorado no formato + `is_boleto_barcode`) **ou**
  `_has_pix_emv` (PIX EMV: `br.gov.bcb.pix`/`00020101`). **Não é reconhecer "FGTS"** — é "a página
  tem uma forma de pagar?"; **página de detalhamento** (relação de trabalhadores/instruções) **não
  tem instrumento → não conta** (verificado no PDF real: p.1-2 têm PIX, p.3-10 não têm nada).
  Salvaguardas: **gate `>=2`** preserva "1 pagável ⇒ 1 registro" (não divide boleto único nem
  boleto+instruções); eventual superdivisão sai **sem `amount`** e é descartada a jusante
  (`sem_valor`). **`extract_linha_digitavel` NÃO foi tocada** (o detector é aditivo). Testes:
  `tests/test_payable_pages.py` (detectores + split ≥2/==1 — o split multi-registro passou a ter
  cobertura, que antes não existia).
- **Barcode gravado ERRADO causa DEDUP FALSA que perde parcela (BR Supply — correção 2026-07-17):**
  o barcode determinístico da linha digitável (`rec["barcode"] = normalize_barcode(extract_linha_digitavel(raw))`,
  prioridade sobre o LLM) **já previne** — mas dados HISTÓRICOS gravados por versão antiga podem ter o
  barcode de OUTRA parcela. Caso: NF de julho `000152737` (3 parcelas em e-mails separados) — a conta
  **539** (parcela 1) fora gravada com o **barcode E o vencimento da parcela 2**; quando a parcela 2 real
  chegou, colidiu (impressão 1 barcode + impressão 3 valor+venc) e foi **deduplicada como reemissão** →
  boleto perdido silenciosamente. **Auditoria ampla** (script `scratchpad/audit_barcode.py`, só
  diagnóstico: baixa cada PDF `pdf_text` e compara o barcode gravado com TODAS as linhas digitáveis do
  documento — determinístico, SEM Claude): das **205** contas comparáveis, **1 única** divergência real
  (539). O 2º "achado" (id 521, BRASPRESS por link) é **FALSO POSITIVO** — o `source_file` de fatura por
  link aponta para o PDF de OUTRA fatura (boleto da 525), mas o barcode gravado da 521 bate o próprio
  valor (limitação conhecida do download por link, não erro de dado). Correção: UPDATE do barcode+venc da
  539 para os valores da parcela 1 (autoritativos, re-extraídos) + `reprocess_message` do e-mail da
  parcela 2 → conta **603** criada (sem colisão após corrigir a 539). Estado final: 3 parcelas distintas
  (539 venc 14/08 · 603 venc 13/09 · 538 venc 13/10). Os demais e-mails "BR Supply" com "0 contas" são
  **reenvios legítimos** (dedup correta). **Reincidência já prevenida** pelo barcode determinístico atual
  (implantado em produção em 2026-08-07).
  ⚠️ **Aquela auditoria cobriu SÓ `pdf_text` (205 contas) — e o defeito morava no outro caminho.**
  A varredura de 2026-08-07, sobre **todas** as 442 contas com barcode, achou **18 corrompidas,
  100% `pdf_vision`**: o OCR de scan desloca dígitos e produz código de comprimento válido com
  valor 10× e fator impossível. Ao auditar um campo, varra **todas as origens** — restringir à
  origem que se suspeita confirma a suspeita e deixa o resto invisível. Ver "Barcode de scan que
  se REFUTA" em "Robustez da leitura e da extração".

Testes: `tests/test_barcode_due_date.py` (fator real do id 435 → `2026-07-08`; desambiguação do
reset; fator 0; não-boleto; correção de inversão; no-op quando já bate; **gate de consistência:
barcode corrompido do id 463 NÃO sobrescreve a data correta**). **Deploy:** mudança só
em Python — copiar `extract_pdf.py` **e** `read_emails.py` para produção (ver "Deploy manual do
Email Reader"). A trigger de banco recalcula `a vencer`/`vencido` a partir do `due_date` corrigido.

### Dedup de conteúdo + reemissão (`financial_account_control`)

**Detalhe, casos reais e medições: [docs/knowledge/pipeline-extracao.md](docs/knowledge/pipeline-extracao.md).**
Invariantes que não podem regredir:

- **4 impressões**, nesta ordem, todas escopadas por `sk_supplier` (nunca por texto de fornecedor —
  a resolução do `sk_supplier` acontece ANTES da dedup): (1) **barcode**; (1b) **nosso número**;
  (2) nº do documento (≥6) + valor; (3) **valor + vencimento**.
- 🔴 **A impressão 1b tem GUARDA DE TÍTULO (`_same_title`)** — o campo que o LLM extrai como "nosso
  número" às vezes é o **código agência/conta do cedente**, igual em todos os boletos do fornecedor;
  sem a guarda, mensalidades de meses distintos se fundiam e o pagável sumia em silêncio. Ela é
  **conservadora**: devolve "pode deduplicar" quando um dos lados não tem nº próprio.
- 🔴 **A impressão 3 NÃO exige `document_type` igual** — o tipo varia entre os documentos que
  descrevem a mesma dívida (`boleto` no PDF, `fatura` no corpo). Distinção que permanece: doc **com**
  barcode só casa candidato **sem** barcode (dois boletos com linhas digitáveis próprias são
  documentos distintos); doc **sem** barcode casa qualquer conta da mesma dívida.
- 🔴 **A impressão 2 ignora número SINTÉTICO** (`_is_synthetic_invoice_number`) — senão dois boletos
  distintos de mesmo valor colidiam e um era perdido.
- 🔴 **A consulta de dedup RE-TENTA em falha de rede.** Um hiccup faria `find_financial_duplicate`
  devolver "sem duplicata" e o pipeline **gravaria conta duplicada**. Resultado vazio não é erro.
- **Reemissão** (vencimento mais recente) atualiza `due_date` + boleto da conta existente, não cria
  outra. **Dedup que descarta tudo do PDF ⇒ status `duplicidade`** (`_pdf_only_deduplicated`), nunca
  `extraído` — é o que torna a perda auditável.


### Duas chaves Supabase, dois papéis

- **`anon`** (`VITE_SUPABASE_ANON_KEY`): frontend — leitura REST, respeita RLS `TO authenticated`.
- **`service_role`** (`SUPABASE_SERVICE_KEY`): scripts Python/Flask — escrita, ignora RLS.

### Normalização de `document_type`

**Catálogo completo dos tipos, os classificadores e os casos que originaram cada regra:
[docs/knowledge/pipeline-extracao.md](docs/knowledge/pipeline-extracao.md).** Invariantes:

- **O enum `DOCUMENT_TYPES` (`@sheild/shared`) e o CHECK do banco são espelhos**, e
  `tests/test_doc_type_domain_consistency.py` trava isso lendo a migration mais recente: todo valor
  emitido por `_DOC_TYPE_NORM`/`_BODY_DOC_KEYWORDS`/`_UTILITY_DOC_KEYWORDS`/`_SUBJECT_TAX_DOC_KEYWORDS`
  ∈ enum. Ao acrescentar tipo, rode esse teste — ele falha se as camadas divergirem.
- 🔴 **`pix` NÃO é tipo de documento** (removido na migration 075) — é só forma de pagamento.
- **`SKIP_ACCOUNT_TYPES = ['nfe','nfse']`** não gera conta. 🔴 **EXCEÇÃO: NFS-e/NF-e COMBINADA com
  boleto no mesmo PDF** — o skip só vale quando a linha **não** tem boleto real; com linha digitável
  válida ela é re-rotulada `boleto` (o pagável vence). NF-e pura sem barcode segue pulada.
- 🔴 **CT-e/transporte: só o BOLETO gera conta.** CT-e sem boleto ⇒ e-mail `ignorado`, não `falha`.
  Boleto de transporte é re-rotulado `cte`. A distinção boleto × chave de acesso é por
  `_is_boleto_barcode`, nunca por `document_type`.
- 🔴 **Fatura + boleto no mesmo e-mail ⇒ só o boleto vira conta** — decidido por **barcode + VALOR**,
  não por `document_type`. A guarda de valor preserva o 2º boleto escaneado cujo Vision não leu a
  linha digitável (valor DISTINTO ⇒ outra dívida, mantida). 2ª guarda: **extrato/demonstrativo/
  relatório** por nome/descrição é descartado mesmo com valor distinto — nunca inclui
  `fatura`/`boleto` nos termos, para não matar o 2º boleto escaneado.
- 🔴 **Seguradora só gera conta com boleto de linha digitável válida** — contexto detectado **só pelo
  ASSUNTO** (ampliar para `supplier_name`/domínio destruiria contas existentes).
- 🔴 **Guia de ARRECADAÇÃO: valor = total a recolher (do BARCODE) e vencimento = data-limite**, não o
  valor principal nem o vencimento do tributo. `amount_charged` recebe o total **direto** — aplicar a
  aritmética de boleto somaria os juros duas vezes.
- 🔴 **Vencimento do boleto é AUTORITATIVO pelo fator do código de barras**, com dois gates: o valor
  embutido tem de bater o `amount` (barcode corrompido por OCR não dita data) e `venc ≥ emissão`.
  A data IMPRESSA no texto do PDF vence o LLM e o fator no caminho `pdf_text`.
- 🔴 **Beneficiário Final vence Beneficiário/Cedente** (boleto securitizado) — **só quando há CNPJ**
  ao lado do rótulo; "Beneficiário Final" também é rótulo de COLUNA em dezenas de boletos.
  E o **CEDENTE do boleto vence o EMITENTE do CT-e** em fatura de transporte agregada (SSW).
- **Classificação contábil FORÇADA para guias tributárias** (por tipo/contexto do imposto, não pelo
  fornecedor) tem precedência máxima e faz write-back no `supplier` — exceto OTIMOTEX (sk 1),
  funcionário (trigger 070) e os `sk_supplier` de `TAX_CLASSIFICATION_EXCLUDED_SK_SUPPLIERS`.
- **Acrônimo de tributo no ASSUNTO sobrepõe a classificação do PDF/corpo** (DARE × GARE × GNRE são
  visualmente quase idênticas); `das`/`dam` só casam por frase inequívoca, para não pegar o artigo.


### Auto-resolução de fornecedor

**Ordem de busca, casos reais e as regras de override: [docs/knowledge/pipeline-extracao.md](docs/knowledge/pipeline-extracao.md).**
Invariantes:

- **Ordem da RPC `resolve_supplier_id`:** CNPJ → CPF → nome normalizado → **e-mail exato** →
  auto-insert. O e-mail é fallback **depois** do nome (migration 054) e domínio **interno**
  (`@otimotex`/`@lebianco`) nunca vira fornecedor (046).
- 🔴 **Identificador forte que não casou ⇒ fornecedor NOVO** (migration 109): com CNPJ/CPF extraído
  e sem match, faz auto-insert em vez de casar por e-mail. Sem isso, o endereço de uma **plataforma**
  (`no-reply@sswsistemas.com.br`, compartilhado por dezenas de transportadoras) atribuía a conta ao
  primeiro fornecedor que casasse — e o defeito atingia justamente a PRIMEIRA fatura de cada
  transportadora nova. `_is_platform_email` bloqueia casar, armazenar e propagar esse endereço.
- 🔴 **O CNPJ da própria empresa pagadora nunca é o fornecedor** — comparação pela **RAIZ de 8
  dígitos** (filiais do grupo compartilham a raiz), não pelo CNPJ completo.
- 🔴 **Um TIPO DE DOCUMENTO ou FORMA DE PAGAMENTO nunca vira fornecedor** (`_is_non_supplier_term`):
  "GUIA GNRE" não pode criar o fornecedor "GNRE".
- **Cadeia de fallback quando nada foi extraído:** assunto ancorado em **sigla societária**
  (LTDA/EIRELI/…) → remetente ORIGINAL de bloco encaminhado no corpo → **pagador**. A ordem importa:
  o assunto é sinal do PRÓPRIO e-mail e vence a linha `De:` de um terceiro da cadeia.
- 🔴 **Guia de imposto sem favorecido real ⇒ `OTIMOTEX_SK_SUPPLIER` (1)**, curto-circuitando assunto
  e pagador — o credor é o Fisco, que a extração não captura. Não confundir com `sk_company`: são
  tabelas diferentes e **independentes**.


### Empresa pagadora (`sk_company`) — regra por PRECEDÊNCIA (não regredir)

**TRÊS** empresas pagam contas: **OTIMOTEX TECIDOS (`1`, default — renomeada de "OTIMOTEX")**,
**LEBIANCO (`2`)** e **OTIMOTEX FARDOS (`3`)**. Regra (decisão do usuário, 2026-07-17), **a ordem
É a regra**:

| # | Sinal | → | Não regredir |
|---|---|---|---|
| 1º | **remetente `ester@otimotex.com.br`** (endereço EXATO) | **3** FARDOS | **vence tudo**: o domínio `otimotex.com.br` **e** a menção a lebianco |
| 2º | **referência a "lebianco"** (assunto/corpo/anexo/remetente/domínio) | **2** LEBIANCO | vence o CNPJ (ver abaixo) |
| 3º | nenhum dos dois | **1** TECIDOS | default |

- **`_is_fardos_sender` é o 1º `if` de `resolve_sk_company`** — movê-lo para baixo inverteria a
  regra. Casa o **endereço completo** (`(x or "").strip().lower() == FARDOS_SENDER`): outro usuário
  `@otimotex.com.br` **não** casa — é isso que faz a regra "vencer o domínio". A ester **citada no
  corpo/payer_name** (sem ser remetente) **não** classifica — só o REMETENTE conta.
- ⚠️ **`OTIMOTEX_SK_SUPPLIER` (=1) ≠ `SK_COMPANY_DEFAULT` (=1)**: o primeiro é sk de **FORNECEDOR**
  (`supplier`), o segundo de **EMPRESA** (`company`). Mesmo valor, mesmo nome, **tabelas
  diferentes** — nunca find-replace nos dois (há teste travando: `NaoConfundirEmpresaComFornecedorTest`).
- **O rename é só do NOME cadastral.** Nos e-mails/dados externos **"OTIMOTEX" continua sozinho** —
  `_RECEIVABLE_SUBJECT_TERMS` ("cobranca otimotex"), payer/CNPJ e a resolução de fornecedor ficam
  **intocados**. `_is_lebianco_sender` também é **dual-purpose** (decide o ICMS-ST `4.1.02` em
  `_resolve_tax_chart_code`) — não alterar sua semântica.
- **Cadastro manual**: o select "Empresa" nasce no default **por usuário logado**
  (`hooks/useDefaultSkCompany`: ester → FARDOS; demais → TECIDOS). Isso é um vínculo
  usuário→empresa — o mesmo conceito da tabela `user_company`, **revertida** a pedido do usuário:
  fica DELIBERADAMENTE como **constante de e-mail no código**, sem ressuscitar a tabela. Vários
  usuários no futuro → aí a tabela volta a fazer sentido.
- **Estado (migration 085, aplicada 2026-07-17):** **347** TECIDOS · **55** LEBIANCO · **37** FARDOS
  (backfill por remetente OU dono = ester; idempotente).

A parte LEBIANCO (2º nível) permanece como antes: fontes varridas (sem acento, case-insensitive,
**substring** — "lebianco" é nome próprio distintivo, então **não** se usa `_has_word`/`\b`, que
existe para termos comuns como `das`/`iss`): **remetente/domínio** (`_is_lebianco_sender`,
reusado da classificação de ICMS-ST), **assunto**, **corpo**, **anexo** e `description`/
`source_file`/`payer_name`/`email_body_excerpt`.

- **A REFERÊNCIA VENCE O CNPJ** (o cerne): a conta pode ser da LEBIANCO com o **CNPJ da OTIMOTEX
  impresso no boleto**. Logo o CNPJ **não** participa da regra — sem menção é `1` **mesmo com
  `payer_cnpj` = CNPJ da LEBIANCO** (caso real: conta **267**, que permanece em `1`). Na prática
  o Python grava `sk_company` **sempre** (1 ou 2) e o resolvedor SQL `resolve_company_sk` deixa de
  influenciar o pipeline. **As DUAS origens informam a empresa explicitamente**: o pipeline pela
  regra LEBIANCO e o CRUD manual pelo **select do `ContaForm`** (default OTIMOTEX). O
  `resolve_company_sk` virou, na prática, **fallback residual** — só atuaria num INSERT que
  omitisse `sk_company` (nenhum caminho do app faz isso hoje).
- **`sk_company` (PAGADORA) é INDEPENDENTE de `sk_supplier` (FORNECEDOR)** — "pode acontecer de
  company ser lebianco, mas fornecedor ser otimotex". Por isso **`supplier_name`/`supplier_cnpj`
  ficam FORA da varredura**: se a LEBIANCO for o FORNECEDOR, quem paga é a OTIMOTEX (`1`), e
  varrer o nome do fornecedor inverteria a conta. Reforço: `_finalize_supplier` já remove essas
  chaves do payload, e a regra roda depois dele.
- **"LE BIANCO" (com ESPAÇO) vale SÓ NO ASSUNTO** (`_subject_has_lebianco`): no assunto é
  referência deliberada ("LE BIANCO - PAGAMENTO FORNECEDOR"); no **corpo** ela aparece na
  **assinatura do grupo** ("Departamento Financeiro | Otimotex / Le Bianco") e marcaria contas que
  são da OTIMOTEX — falso positivo **comprovado** na conta **167** (assunto "COBRANÇA OTIMOTEX
  TECIDO"), que corretamente permanece em `1`.
- **Anexo**: o texto CRU do PDF não chega ao payload (o CSV só traz `description`/`source_file`),
  então **`_pdf_text(pdf_path)`** o lê no **passo 1** de `extract_and_store_accounts` (único ponto
  com o arquivo em disco) e a regra avalia `_has_lebianco_reference(texto)`. **Best-effort** —
  qualquer falha (PDF cifrado, imagem, pdfplumber) devolve `""` sem levantar; a regra nunca
  bloqueia a gravação da conta. Desde a **Onda 3** o texto tem DOIS consumidores (esta regra e o
  registro de documento fiscal), então é lido **uma vez e por inteiro**: o curto-circuito
  permanece para a FLAG, não para a leitura. O antigo `_pdf_mentions_lebianco` não existe mais.
- **Onde é aplicada** (`apply_sk_company`, respeita valor já presente — idiom de `created_by`):
  (1) `extract_and_store_accounts` passo 2 (único ponto com `body_text` + flag do anexo em
  escopo); (2) `extract_from_email_body` no payload BASE, **antes** do bloco de parcelas (os
  clones herdam via `dict(payload)`); (3) **rede de segurança UNIVERSAL** no choke point
  `register_financial` (mesmo padrão de `_apply_barcode_due_date`), cobrindo os 3 scripts de
  reprocessamento.
- **Trigger (migration 084) — não regredir:** `trg_fe_resolve_company()` só resolve
  `IF NEW.sk_company IS NULL`. Antes a atribuição era **incondicional** e tinha dois defeitos
  provados: descartava o valor do Python **e qualquer UPDATE re-resolvia a empresa** (um
  `UPDATE ... SET has_invoice = has_invoice` na conta 267 mudava `sk_company` de 1→2 — a curadoria
  de NF/BOL revertia a empresa e o backfill não grudaria). Mantém `SECURITY DEFINER` +
  `search_path` + chamada qualificada (lição da **074**).
- **Estado após o backfill (2026-07-17):** **55** contas em `sk_company=2` (19 por menção no
  texto, 46 pelo remetente `@lebianco.com.br` — 36 delas *só* pelo remetente) e **381** em `1`.
  Trade-off aceito: se alguém da Lebianco encaminhar um boleto da OTIMOTEX, a conta fica como
  Lebianco. Testes: `tests/test_sk_company_lebianco.py`.

### `extraction_source` — origem dos dados

| Valor (banco) | Origem | Rótulo exibido (badge/UI) |
|---|---|---|
| `pdf_text` | PDF digital (pdfplumber) | `pdf anexado` |
| `pdf_vision` | PDF escaneado (Claude Vision via base64 — não exige poppler) | `pdf anexado` |
| `image_vision` | Anexo de IMAGEM (jpg/png/gif/webp) lido via Claude Vision — recibo/comprovante/foto (ex.: "Valor do porte" dos Correios). Migration 061 no CHECK | `imagem anexada` |
| `docx_text` | Anexo **.docx** (Word) cujo XML traz o pagável — `zipfile` + regex, determinístico. Migration 131 | `word anexado` |
| `docx_vision` | Anexo **.docx** cuja figura EMBUTIDA foi lida via Claude Vision (boleto colado como imagem). Migration 131 | `word anexado` |
| `email_body` | Corpo do e-mail (sem PDF válido) | `corpo email` |
| `falha` | Falha na extração | `falha` |

> O rótulo amigável em pt-BR é resolvido por `badgeLabel()` (`statusBadge.variants.ts`),
> usado pelo `StatusBadge` e pelo painel de detalhe de `/consulta` — `pdf_text` e `pdf_vision`
> compartilham "pdf anexado" (para o usuário ambos são um PDF anexado; a distinção é interna);
> `docx_text`/`docx_vision` seguem a mesma regra com "word anexado".
> Valores não mapeados caem no próprio texto.

**Anexos .docx (Word) — aceitos desde 2026-08-17 (migration 131):** boleto anexado como documento
do Word era **descartado em silêncio** por `save_attachments` — o `continue` do filtro não logava
nada, o e-mail virava "sem anexo" e terminava em `falha` culpando o corpo. Caso de origem:
`email_control` 1516 ("BOLETO: 0003150-04.2023.8.26.0577"); medidos **3 e-mails** com o mesmo
padrão (1516, 1515, 1322 — guias do TJSP/FEDTJ), todos reprocessados. Invariantes:

- **Módulo `skills/pdf-contas-pagar/scripts/docx_content.py`, SÓ STDLIB** (`zipfile` + regex),
  mesmo espírito de `febraban.py`/`fiscal_key.py`/`cte_content.py` — .docx é ZIP com XML, e
  nenhuma dependência nova entrou. Importado **no topo** do `extract_pdf` (como os outros três) e
  **lazy com aviso** no `read_emails` (`_docx_content()`); a assimetria é a política do projeto.
- 🔴 **TRÊS CAMADAS, nesta ordem:** texto do `word/document.xml` → maior imagem de `word/media/`
  via Vision → falha explícita. **A camada 1 exige pagável PROVADO** (`_page_has_payable`: linha
  digitável de 47, arrecadação de 48 ou PIX EMV, todos com DV) — ao contrário do PDF, que é aceito
  por volume de texto. Um .docx não é documento financeiro por natureza (é carta, contrato,
  proposta): mandar o texto de qualquer Word ao Claude gastaria dinheiro em prosa e criaria conta
  espúria a partir dela. Afrouxar depois é fácil; o inverso não tem volta.
- ⚠️ **Medido nos 3 casos reais: os documentos têm texto ZERO** e uma figura colada de ~68 KB —
  quem responde é a **camada 2**. Se a camada 1 parecer código morto, não é: ela cobre o .docx
  gerado por sistema, que é o formato mais barato de ler.
- 🔴 **Sem parser XML, de propósito.** O texto sai por regex sobre as tags de conteúdo, o que torna
  *billion laughs*/XXE **estruturalmente impossíveis** (não há expansor de entidade) sem
  `defusedxml`. Demais defesas, porque o conteúdo vem de remetente não confiável: zip bomb em
  **dois níveis** (soma declarada **e** leitura com teto real — o `file_size` do cabeçalho é
  declarado pelo próprio arquivo e pode mentir), leitura só de entradas de nome conhecido, e o
  arquivo de destino da imagem com **nome gerado por nós** (o do ZIP nunca toca o filesystem).
- 🔴 **A concatenação dos runs é SEM separador dentro do parágrafo.** O Word parte a linha
  digitável em vários `<w:t>`; um `" ".join` a destruiria. Travado por teste — e a fixture corta
  **no meio dos dígitos**, porque cortando nos espaços o mutante `" ".join` deixava a suíte verde
  (`extract_linha_digitavel` tolera espaço a mais).
- 🔴 **`attachment_kind`/`attachment_ext` (`read_emails`) são a FONTE ÚNICA da seleção de anexo**,
  consumida por `save_attachments`, pelo `_document_parts` da varredura histórica e pelo
  `_describe_candidates` do `reprocess_message` — antes eram três cópias que só podiam concordar
  por disciplina. O ramo `.docx` vem **antes** do de PDF: `is_pdf` casa `"pdf"` em qualquer lugar
  do nome, então `boleto_pdf.docx` seria salvo como `.pdf` e morreria no pdfplumber. E o `.docx`
  **não exige `attachment`** no Content-Disposition (Outlook manda como `octet-stream`, às vezes
  sem disposition); a razão de a imagem exigir — logo/assinatura inline — não existe aqui.
- 🔴 **O descarte de anexo não suportado agora LOGA** (`Anexo ignorado (tipo não suportado)`). O
  banco não registra anexo rejeitado (`attachment_names` fica NULL), então essa linha é a única
  fonte possível de "que formatos estamos perdendo" — e vale para `.doc`/`.odt`/`.xlsx`/`.msg`,
  que **seguem fora do escopo** (`.doc` é OLE binário; a stdlib não lê).
- 🔴 **`VISION_SOURCES` (`extract_pdf`) é a fonte única das fontes cuja resposta é JSON.**
  `build_records` roteava por tupla literal `("pdf_vision","image_vision")`: sem `docx_vision` ali,
  a resposta JSON do Vision cairia no parser de TEXTO, produzindo registro vazio que o pipeline
  leria como "documento sem valor" — sem erro. ⚠️ O teste dessa guarda tem de assertar o
  **conteúdo** do registro, não só a fonte: medido, `_build_records_text` engole a falha e
  reconstrói por regex, devolvendo 1 registro que ainda carrega `extraction_source='docx_vision'`.
- 🔴 **Dois pontos declaravam `application/pdf` para sufixo desconhecido** e foram fechados:
  `_vision_source_block` (fallback silencioso) e **`_try_barcode_vision`** (bloco hardcoded,
  alcançável pelo caminho `docx_text` via `_build_records_text` quando a linha digitável não casa).
  O sintoma seria **400 remoto** depois de trafegar o base64, longe da causa; agora é recusa local
  nomeada. O guard fica na função que carrega o media_type, não no call site.
- **UI:** o `AttachmentViewer` não tenta `<iframe>` em `.docx` (o navegador não renderiza) —
  mostra estado explícito e entrega Baixar / Nova aba.
- ✅ **DEPLOY APLICADO E VERIFICADO em 2026-08-17** (paridade **32/32** + smoke de import na própria
  máquina de produção, devolvendo `ok True ('pdf_vision', 'image_vision', 'docx_vision')`).
  `docx_content.py` é arquivo **NOVO** (o manifesto foi de 31 para **32**); `DEPLOY_GLOBS` **não**
  mudou (o glob `skills/pdf-contas-pagar/scripts/*.py` já o cobre). **Ordem de cópia:
  `docx_content.py` PRIMEIRO**, depois `extract_pdf.py`, `read_emails.py` e o manifesto — o
  `extract_pdf` o importa no TOPO, então o módulo ausente derruba **toda** a extração, não só a de
  .docx. Nenhuma dependência nova (`zipfile` é stdlib). Detalhe em
  [docs/deploy/historico-deploys.md](docs/deploy/historico-deploys.md).
  ⚠️ **Paridade de hash e import são perguntas DIFERENTES.** O `check_deploy_parity` compara os
  bytes de todos os 32 arquivos — módulo esquecido aparece ali como `faltando`, então ele cobre o
  erro de cópia. O que ele **não** cobre é o ambiente: versão de Python da máquina, `__pycache__`
  antigo, dependência que existe no dev e não lá. Com import no TOPO isso é falha total da
  extração, e custa um comando distingui-la: `py -3 -c "import extract_pdf"` a partir de
  `skills/pdf-contas-pagar/scripts`.

**Anexos de IMAGEM (jpg/png/gif/webp) — lidos via Claude Vision (`image_vision`):** o
pipeline trata imagem (recibo/comprovante/foto, ex.: "Valor do porte" dos Correios) como
documento. Prioridade: **anexo PDF → anexo imagem → PDF por link → IMAGEM INLINE → corpo**.
`save_attachments` (`read_emails.py`) salva imagens **anexo explícito** (`Content-Disposition:
attachment`). Imagem **inline** (`Content-ID`, sem `attachment` — recibo colado no corpo pelo
Outlook) é tratada por `save_inline_images` como **fallback SÓ quando não houve anexo nem PDF
por link**: salva a **MAIOR** imagem inline `>= _IMAGE_INLINE_MIN_BYTES` (50 KB) — o documento é a
imagem mais proeminente; logos/assinaturas/ícones e a 2ª imagem ficam de fora, evitando chamadas
Vision desnecessárias (fora desse fallback, imagem inline nunca é processada). O caso real que
motivou: reembolso de postagem dos Correios com o recibo colado inline (`process_message` →
`save_inline_images` → Vision → conta `recibo` R$ 172,39, fornecedor ECT/Correios). No `extract_pdf.py`, `process_pdf` desvia imagens **antes** de pdfplumber/
descriptografia/carnê (que abririam o arquivo como PDF) para `_extract_image` → `extract_with_vision`,
que monta o bloco Vision conforme o tipo (`_vision_source_block`: `type:image`+media_type para
imagem → `image_vision`; `type:document`+`application/pdf` para PDF → `pdf_vision`). `build_records`
trata `image_vision` pelo mesmo caminho JSON do `pdf_vision` (inclusive o ARRAY de N pagáveis). O prompt de `amount` inclui o rótulo
"Valor do porte"/"Valor total" de recibo de postagem. `upload_attachment` grava o Storage com o
`Content-Type` por extensão (`_UPLOAD_CONTENT_TYPES`), não mais fixo em `application/pdf`. CHECK do
banco: migration **061** (domínio `email_body`/`pdf_text`/`pdf_vision`/`image_vision`/`falha`); enum
Zod `EXTRACTION_SOURCES` e o badge (`image_vision`→"imagem anexada") alinhados. Testes:
`tests/test_extract_pdf.py` (roteamento de imagem), `tests/test_save_attachments.py` (salva PDF+imagem,
ignora inline) e `StatusBadge.test.tsx`.

### Boleto por link (sem anexo) — prioridade anexo → link → corpo

A prioridade de extração vale também para **links**: e-mail **sem anexo PDF mas com link**
deve usar o link para encontrar o boleto, antes de cair no corpo. Em `process_message`,
quando `save_attachments` não traz nada, o fluxo chama `extract_pdf_links(body_text,
body_html)` e tenta `download_pdf_from_url` em cada candidato; os PDFs obtidos entram em
`saved_pdfs` e seguem o caminho normal — inclusive **upload no Storage** (todo PDF salvo
passa por `upload_attachment` dentro de `extract_and_store_accounts`, anexo ou link).

- **Reconhecimento do link** (`extract_pdf_links`): âncora/URL com termos de cobrança
  (`_LINK_TEXT_RE`/`_LINK_URL_RE`, que inclui `protocolo`) ou caminho `.pdf`.
- **Página HTML intermediária** (`download_pdf_from_url`): se o link abre uma landing/portal
  HTML, varre os `<a>` (1 nível) atrás de um link de boleto (âncora/URL de cobrança ou
  `.pdf`) e baixa o PDF. Hrefs são **desescapados** (`html.unescape`, `&amp;`→`&`) para os
  parâmetros não quebrarem.
- **SIEG — QUEBROU em 2026-06-16 (handler deferido — decisão A1):** a SIEG migrou
  `app.sieg.com/faturas` para **ASP.NET WebForms com boleto gerado por JS/ajax**
  (`financeiro.min.js`). O scan genérico (sem JS) não acha mais o PDF → loop em HTML +
  `TimeoutError` → cai no corpo (NFE) → `falha`. **Não foi regressão nossa** (caminho de link
  intocado). Mecanismo mapeado p/ o futuro handler: `POST /ajax/BillsDetails.aspx/GetDetailsBills`
  body `{bill:'<bill>',companyid:''}` → `d.Charges[0].PrintUrl` quando `PaymentMethod.Code`
  contém `bank_slip` (`bill`/`branchid` vêm da query da URL). Reprodução server-side dá HTTP 500
  (exige sessão/JS do navegador). **Adiado até entrar uma fatura SIEG em aberto** para validar o
  download de verdade (as atuais estão "Pago"). Detalhes na memória `link-boleto-pipeline`.
- **SSW (transportadoras — `sswsistemas.com.br`) → preferir o link de FATURA, descartar o DACTE
  (`_ssw_doc_kind`/`_SSW_LINK_RE` em `extract_pdf_links` — não regredir):** o e-mail "Sua fatura
  Nº… está disponível" traz VÁRIOS links `ssw.inf.br/cgi-local/ssw1188?id=<hex>`, e o **1º byte do
  `id` (hex→ASCII)** indica o tipo: **`F` = Fatura** (traz o **boleto** no rodapé — âncora "AQUI"/
  número da fatura) · **`D`/`E`/`X` = DACTE/CT-e** (documento **fiscal**, sem boleto — âncora
  "Download do arquivo"). Sem tratamento, o `extract_pdf_links` casava o DACTE (a âncora "Download"
  bate a heurística `download`) e **ignorava a fatura** (âncora "AQUI"/número não casa
  boleto/fatura/.pdf) → baixava o DACTE (sem linha digitável) e, sendo transportadora, a conta caía
  em **`ignorado`** (regra CT-e/transporte sem boleto). Correção: `_ssw_doc_kind` classifica o link
  pelo id; `extract_pdf_links` **prioriza a fatura (`F`)** (posição 0) e **descarta os DACTE
  (`D`/`E`/`X`)** — no HTML e no texto puro. Caso de origem: conta da fatura 596597 (Arlete
  Transportes, R$ 1.505,37) que virou `ignorado`; reprocessada (`reprocess_message.py`) → boleto
  extraído (cc 4 / plano 339, transporte). Testes: `tests/test_link_extraction.py`
  (`SswLinkSelectionTest`).
- **Portal BRASPRESS** (`download_pdf_from_url` + `_braspress_download_url`): caso que o scan
  genérico não cobre, pois o link do PDF é montado por JS. O link do e-mail
  (`/protocoloweb?protocolo=CHAVE`) abre uma página cujo botão chama `faturaPDF(chave)`, que
  baixa de `/fatura/download?protocolo=CHAVE&protocoloWeb=true`. Exige **cookie de sessão**
  (`JSESSIONID`) — por isso `download_pdf_from_url` usa um `http.cookiejar`/opener
  compartilhado entre a página e o download (`_fetch_url` aceita `opener`). Outros portais
  com link de PDF montado por JS seguem esse padrão (handler dedicado).
- **Lmed/mdnet (portal ScriptCase) — adiado por CAPTCHA (decisão do usuário, 2026-06-17):**
  `srv2.mdnet.com.br/lmedseg/vExternoFatura` pede os "primeiros 3 dígitos do CPF/CNPJ"
  (campo `m_veri`) **e um CAPTCHA com imagem**. O prefixo do CNPJ viria de `company.cnpj`
  (`sk_company=1`, tentar 5 e depois 3 primeiros dígitos), mas o captcha bloqueia o download
  automático → fatura fica em `falha` p/ download manual. **Regra de prefixo de CNPJ ainda
  não implementada** — fazer quando houver um portal que peça só o prefixo (sem captcha).
  Detalhes na memória `link-boleto-pipeline`.
- **Links suspeitos são ignorados** (`_is_suspicious_link`, regra Locaweb): redirecionadores/
  rastreadores ofuscados — `bing.com/ck/a?…&u=a1<base64>`, Microsoft SafeLinks, Proofpoint
  URL Defense — **nunca** viram candidatos a download (evita baixar malware de phishing).
  Esta é a **defesa primária**: detecta no corpo o próprio link que faz a Locaweb exibir o
  aviso "Tem certeza que deseja acessar este link?" (modal de webmail mostrado **após** o
  clique, logo ausente do corpo bruto). Como rede secundária, `_body_has_suspicious_warning`
  descarta todos os links se esse texto de aviso aparecer citado no corpo.
- **Guarda anti-SSRF do download (segurança §4 C-1/C-2 — não regredir):** todo `GET` de
  link passa por `_is_safe_download_url` (`_fetch_url`) — bloqueia scheme ≠ http(s), porta
  malformada/zero e host que resolve para IP **interno** (privado/loopback/link-local/
  reservado/multicast — cobre metadata cloud `169.254.169.254`, `localhost`, LAN). O
  `_SafeRedirectHandler` **revalida cada redirect** (impede bypass via 302 para alvo interno);
  os PDFs salvos são contidos em `PDF_INBOX` (`_is_within_inbox`). Conteúdo de remetente
  desconhecido controla a URL — **nunca** remover essas guardas. Os caminhos legítimos
  (BRASPRESS, página HTML intermediária) batem em hosts públicos e passam. O cookiejar do
  `http.cookiejar` só envia cookie a domínio correspondente (sem vazamento cross-domain).
- **PORTA: não há allowlist (mudança de política, 2026-07-28 — não reintroduzir):** havia
  `_ALLOWED_PORTS = {80,443}`, removida por barrar um caminho **legítimo**: o boleto das
  **seguradoras** (SEGUROS SURA) chega por link que redireciona para
  `http://mdi.li:7000/api/item/<id>` — host **público** servindo o PDF numa porta alta. O
  `_SafeRedirectHandler` recusava o 302 ("destino não permitido") e o e-mail caía em
  `falha` (diagnóstico do `email_control` 1082). A proteção REAL contra SSRF é o teste de
  **IP interno** (`_host_is_safe` + pin de IP + revalidação de cada redirect): provado que o
  destino é externo, a porta não dá acesso a serviço interno nenhum. Trade-off assumido: o
  reader passa a poder falar HTTP com qualquer porta de host **público** (o alvo ainda
  precisa devolver `%PDF` para virar conta). Uma allowlist de portas/domínios voltaria a
  quebrar o caso SURA quando a seguradora trocar de encurtador. Travado em
  `tests/test_ssrf_guard.py` (porta alta em host externo passa; IP interno segue bloqueado
  em **qualquer** porta).
- **`_PinnedHTTPSHandler` compatível com Python 3.12+/3.14 (não regredir):** o handler que
  fixa o IP validado (anti-DNS-rebinding, S4-1) NÃO pode referenciar `self._check_hostname` —
  atributo **removido do `HTTPSHandler` no Python 3.12+** (a verificação de hostname passou a
  ser carregada pelo `context`). Sob **Python 3.14** (a produção roda 3.14.5) o acesso direto
  lançava `AttributeError('_check_hostname')` e quebrava **TODO** download de link HTTPS
  (BRASPRESS, SIEG, qualquer portal) — o e-mail caía em `falha`. `https_open` passa só
  `context` (preserva a verificação de certificado/cadeia via `_context.wrap_socket` com o
  `server_hostname` original) e inclui `check_hostname` **apenas se o atributo existir**
  (Python < 3.12). A guarda anti-SSRF continua intacta. Regressão travada em
  `tests/test_ssrf_guard.py` (`PinnedHttpsHandlerPy312PlusTest`).
- **Erro de código NÃO se disfarça de "link inacessível" (robustez — lição do bug 3.14):**
  `_fetch_url` separa **falha de REDE esperada** (`urllib.error.URLError`/`OSError`/
  `http.client.HTTPException` — host/timeout/TLS/conexão → `log.info` silencioso, retorna
  `None`) de **erro INESPERADO** (bug de código, ex.: incompatibilidade de versão do Python →
  `log.exception` com **traceback**, visível, e segue sem derrubar o run). Antes, um
  `except Exception` genérico logava só "falha ao acessar link", escondendo o `AttributeError`
  do handler por dias em produção. **Não** voltar ao `except Exception` mudo.

Testes: `tests/test_link_extraction.py` (reconhecimento, unescape, filtro de suspeito, URL
BRASPRESS) e `tests/test_ssrf_guard.py` (bloqueio de IP interno/scheme/porta + redirect +
contenção em PDF_INBOX + compat Python 3.12+ do handler HTTPS).

**Reprocessar histórico**: `scripts/reprocess_link_emails.py` (com `--dry-run`) varre os
e-mails `status='falha'`, rebusca o corpo no IMAP, baixa o boleto pelo link e grava em
`financial_account_control` + atualiza `email_control` (`falha`→`extraído`); duplicatas
(original + encaminhado) deduplicam para uma conta e ambos os e-mails viram `extraído`.

### Caminho `email_body`

**Parsers, precedências e os layouts reais que os originaram:
[docs/knowledge/pipeline-extracao.md](docs/knowledge/pipeline-extracao.md).** Invariantes:

- 🔴 **O corpo é fallback SÓ quando o anexo não respondeu por nenhum pagável** — o gate é
  `attachment_account`, que é True tanto para conta NOVA quanto para boleto **deduplicado**. Usar
  `accounts_saved == 0` fazia o corpo criar conta espúria com vencimento divergente.
- 🔴 **MÚLTIPLAS PARCELAS/FATURAS no corpo ⇒ UMA conta por boleto, NUNCA somar.** Dispara só com ≥2
  linhas e vencimentos ou (doc,parcela) distintos; a linha "Total" nunca vira conta. Cada linha leva
  o barcode do SEU segmento — herdar o da primeira faria as demais colidirem na dedup e sumirem.
- 🔴 **Barcode do corpo: a FORMA vence o RÓTULO.** Primeiro `_extract_body_linha_digitavel` (valida
  os 5 campos FEBRABAN), só então o regex de rótulo — que aceita `[\d.\s]{47,60}` e, com `\s`
  cruzando quebra de linha, pode COLAR números soltos em 48 dígitos e inventar um código de
  arrecadação, envenenando a dedup.
- 🔴 **As guardas de barcode vivem na função CANÔNICA (`febraban.py`), não no leitor** — os dois
  caminhos (PDF e corpo) precisam da mesma regra. `normalize_barcode` valida por padrão;
  `normalize_barcode_allow_misread` é o opt-in explícito para dígitos de procedência confiável.
  O fallback defensivo do `read_emails` **espelha o invariante** e **avisa no log** quando degrada.
  ⚠️ **`allow_misread` NÃO é a última palavra no caminho Vision:** ele só relaxa o **DV**, e o OCR
  de scan produz código de comprimento válido com os campos DESLOCADOS, que nenhum DV pega. Desde
  2026-08-07, `barcode_self_refuted` roda depois dele em `pdf_vision`/`image_vision` e descarta o
  que o próprio código refuta (valor **e** fator). Ver "Barcode de scan que se REFUTA" acima.
- **Corpo só-HTML** é convertido (`_html_to_text`); **corpo PLACEHOLDER** ("conteúdo disponível
  somente em HTML") também — exige o padrão do aviso **E** texto curto, porque corpo curto legítimo
  é a norma aqui.
- **Conta vinda do corpo nasce `pendente`**, mesmo que o texto diga "pagamento realizado".


### Registrar TODOS os e-mails + filtro de assunto (`KEYWORDS_DEFAULT`)

**Listas de termos, ordem dos filtros e os casos reais:
[docs/knowledge/pipeline-extracao.md](docs/knowledge/pipeline-extracao.md).** Invariantes:

- **`run_reader` registra TODOS os e-mails** em `email_control` — `/emails` espelha a caixa inteira.
  A keyword decide **o que extrair**, não o que registrar; sem keyword ⇒ `ignorado`, sem baixar.
- 🔴 **`match_keyword` casa acrônimo de tributo por PALAVRA INTEIRA** (`das`, `iss`, `gru`, `dae`…):
  substring pegaria "ca**das**tro", "em**iss**ão", "**gru**po". Frases e siglas distintivas seguem
  por substring.
- **Filtros FORTES, aplicados ANTES do match de keyword** (valem mesmo com keyword/anexo):
  remetente de sistema (`postmaster`), **confirmação de pagamento** (particípio no passado — "pagamento
  A realizar" NÃO casa) e assunto com **`lembrete`**. 🔴 A forma NEGADA inverte o sentido:
  "**não** recebemos o seu pagamento" é COBRANÇA e segue a extração normal.
- **Filtro FRACO (`notification`)** só produz `ignorado` quando **não houve anexo/CSV/conta** — nunca
  esconde conta que o pipeline conseguiu extrair. Alimentam-no: assunto de aviso,
  `is_disposable_sender` (phishing que imita cobrança) e `email_sem_conteudo_extraivel`. 🔴 **Este
  último exige AUSÊNCIA de link**: com link, o download fracassou e isso continua sendo `falha`.
- 🔴 **Confirmação de pagamento ENCAMINHADA** (assunto reescrito) é barrada no caminho do CORPO, lendo
  o `Assunto:` original do bloco encaminhado. **`lembrete` encaminhado NÃO é barrado** — pode ser a
  única fonte de uma fatura; reenvios repetidos são suprimidos pela dedup, não por este guard.
- 🔴 **`status_for_result` — CONTA GRAVADA ⇒ STATUS QUE DECLARA CONTA.** Prioridade: conta do PDF
  (`extraído`) → **conta do corpo (`recebido`)** → NF-e pura → não-pagável → CSV do PDF →
  **duplicidade** → anexo sem conta (`pendente`) → notificação → `falha`. Nenhum sinal que descreve
  o **ANEXO** (`pure_nfe`, `nonpayable`, `csv_generated`) pode ser avaliado antes dos dois sinais de
  conta — nenhum deles refuta uma conta que existe no banco. **`body_created` subiu para o 2º lugar
  em 2026-08-17**: estava abaixo de `nonpayable`, e um anexo NF pulado por `SKIP_ACCOUNT_TYPES`
  mandava para `ignorado` — *"não-financeiro, nada a fazer"* — e-mail cuja conta o CORPO havia
  gravado. Medido: **13 e-mails, ~R$ 80 mil** escondidos atrás do card "Ignorados" (caso de origem
  1517 → conta 1059 de R$ 8.250,00; backfill: **migration 130**). Corrigir só o ramo `nonpayable`
  seria remendo — `pure_nfe` reproduz o mesmo bug pela outra porta. A guarda é o **invariante
  exaustivo** (2^8 combinações) em `InvarianteContaGravadaTest`, com anti-vacuidade dupla (o produto
  tem de ser completo **e** os DOIS status têm de aparecer — senão "sempre `extraído`" passaria,
  mentindo sobre a origem), mais `ProcessMessageAnexoNaoPagavelComCorpoTest`, que **executa**
  `process_message` (§2 item 6: guarda por texto prova que a chamada existe, não que funciona).
  ⚠️ **Efeito colateral deliberado:** PDF que gera CSV **sem nenhuma conta** + conta do corpo passou
  de `extraído` para `recebido` — mais preciso, porque `extraído` significa "o PDF gerou conta". A
  precedência *"o boleto sempre vence o corpo"* NÃO se perdeu: ela vive no gate
  `if not attachment_account` de `process_message`, não nesta ordem. Os **13 e-mails históricos**
  nesse estado seguem em `extraído` (não escondem conta — realinhá-los é decisão de produto).


### Frontend — rotas e serviços

| Rota | Componente | Tabela |
|---|---|---|
| `/emails` | `Emails.tsx` | `email_control` + `financial_account_control` por `message_id` (RLS por remetente p/ grupo restrito — migration 078) |
| `/consulta` | `Consulta.tsx` | `financial_account_control` (scroll infinito + virtualização, **barra de filtros em DUAS linhas** — a 1ª com a busca genérica em destaque + empresa/tipo/situação/datas, a 2ª com a classificação contábil (plano/sub grupo/grupo/centro de custo; ver "FILTROS DEDICADOS de classificação contábil") —, CSV client-side; RLS por dono p/ grupo restrito — migration 076) + `financial_account_attachment` (painel de detalhe lista os anexos; o modal de edição adiciona/remove — ver "Anexos de conta"). Painel de detalhe: **Editar conta** + **Excluir conta** (hard delete só p/ grupo Administrador — ver "CRUD de contas") |
| `/erros` | `Erros.tsx` | `email_processing_errors` (RLS por remetente p/ grupo restrito — migration 078) |
| `/contas` | `ContasNovaPage.tsx` | `financial_account_control` (lançamento manual via `ContaForm`) + `financial_account_attachment` (anexos enviados após o POST devolver o id — ver "Anexos de conta") |
| `/fornecedores` | `SuppliersPage.tsx` | `supplier` (CRUD via Next API) |
| `/tabelas/centros-de-custo` | `CostCentersPage.tsx` | `financial_cost_center` (CRUD via Next API) + grid complementar mestre-detalhe do plano de contas do centro selecionado (`financial_chart_of_account` lançável) |
| `/tabelas/bancos` | `BanksPage.tsx` | `financial_bank` (CRUD via Next API) |
| `/tabelas/contas` | `FinancialAccountsPage.tsx` | `financial_account` (CRUD via Next API) |
| `/tabelas/plano-de-contas` | `ChartAccountsPage.tsx` | `financial_chart_of_account` (CRUD via Next API) |
| `/tabelas/grupos-plano-de-contas` | `ChartAccountGroupsPage.tsx` | `financial_chart_of_account_group` (CRUD via Next API) |
| `/tabelas/subgrupos-plano-de-contas` | `ChartAccountSubgroupsPage.tsx` | `financial_chart_of_account_subgroup` (CRUD via Next API) |
| `/dashboard_vencimentos` | `Dashboard.tsx` | `financial_account_control` — KPIs/gráficos por mês ou geral (`getDashboardData`), filtro de EMPRESA aplicado nas DUAS leituras, 5 cards de KPI clicáveis (= filtro dos gráficos), 4 donuts, "Movimentações mês a mês" e "Contas críticas e prioritárias" (exclusivos desta tela). **Abre filtrado em "A vencer em 7 dias"** (2026-08-15). Detalhe: [docs/knowledge/dashboards.md](docs/knowledge/dashboards.md) |
| `/dashboard_despesas` | `DashboardFinanceiro.tsx` | `financial_account_control` **escopado a DESPESAS + CUSTO** (`getFinancialDashboardData`; grupo com `type_group_id ∈ {2,8}`, migration 094) — 5 KPIs e **6 cards numa GRADE ÚNICA 3×2** (5 donuts + o "Ranking de contas", top 12), com **drill-down** por clique na fatia/linha (`ExpenseDetailModal`). **Abre filtrado em "A vencer em 7 dias"**. O card "Ranking de centros de custo" foi REMOVIDO em 2026-08-15 (com ele saíram `costCenterRanking`, o drill `costCenter` e o embed `cost_center` da leitura). Detalhe: [docs/knowledge/dashboards.md](docs/knowledge/dashboards.md) |
| `/cobranca/envios` | `cobranca/CobrancaEnvios.tsx` | `cobranca_envios_log` (ver "Pipeline de cobrança de vencidos") |
| `/cobranca/erros` | `cobranca/CobrancaErros.tsx` | `cobranca_erros_log` |

**Invariantes dos dashboards (o porquê e as medições ficam em
[docs/knowledge/dashboards.md](docs/knowledge/dashboards.md) — leia antes de mexer):**

- 🔴 **`/dashboard_despesas` é EXCLUSIVO do escopo Despesas+Custo.** TODA métrica (5 KPIs, card de
  total, 5 donuts, o ranking) sai de `isExpenseRow` aplicado **antes de qualquer agregação**.
  Conta sem classificação, ou de outra natureza, fica FORA de tudo.
- 🔴 **Top-N de donut é por VALOR (R$), nunca por contagem de linhas** — o donut ordena por valor,
  então selecionar por contagem joga em "outros" um grupo que vale mais (bug real de 2026-07-22).
- 🔴 **Ranking agrega pela IDENTIDADE (id da FK), nunca pelo texto** — os cadastros não têm UNIQUE
  em descrição, e agregar por texto fundiria homônimos numa linha somada, em silêncio. O sentinela
  id 0 tem descrição NULL: `rankEntry` corta por `id > 0` **e** descrição não vazia.
- 🔴 **Fatia/linha só vira `<button>` quando recebe `onSelect`** — `/dashboard_vencimentos` não
  passa e segue não-interativo (travado por teste; evita S1082).
- **`diameterPx` é UM valor para os 5 donuts**, não um por donut (a versão proporcional dava ~1px
  de diferença entre totais próximos — nem igual, nem perceptivelmente proporcional).
- ⚠️ **As duas telas abrem FILTRADAS em "A vencer em 7 dias", e o filtro recorta TUDO** — inclusive
  o gráfico ANUAL "Movimentações mês a mês" (abre com ~1 barra) e as "Contas críticas e
  prioritárias", que não mostram vencidas na abertura (`vencendo7` exige situação "a vencer").
  É a semântica que o filtro sempre teve, não regressão; o ✕ (ou o clique no card) devolve a visão
  completa. Fazer o anual ignorar o filtro foi **descartado**: ele divergiria dos demais gráficos
  em QUALQUER filtro, não só no default.
- 🔴 **A grade 3×2 de `/dashboard_despesas` tem TRÊS escolhas que parecem enfeite e não são**
  (2026-08-15): os 6 cards vivem na **MESMA** grade (donut e ranking só dividem linha assim);
  o breakpoint é **`sm:grid-cols-2`**, não o `lg:` da grade antiga de rankings (o `lg:` colapsaria
  os 5 donuts numa coluna entre 640 e 1024px para proteger 1 card); e **`self-start` SÓ no
  "Despesas Variáveis"**, o único que divide a linha com um card bem mais alto — no `stretch` a
  moldura dele esticaria e deixaria ~150px de branco sob o anel. ⚠️ A ordem dos donuts **NÃO
  espelha mais o `line_order` de `analytics.demonstrativo_despesas`** (Fixas passou à frente de
  Importação, a pedido do usuário) — não "corrigir" de volta.

- `services/supabase.ts` — fetch direto REST, `Prefer: count=exact` + `Content-Range` para paginação.
  O total é parseado por `parsePaginationTotal` (resiliente): quando o PostgREST devolve a contagem
  indisponível (`*/*` ou `0-19/*`), **não zera** — estima `offset + itens + (página cheia ? pageSize : 0)`
  e marca `totalIsEstimate` em `Paginated<T>` (evita prender o usuário na página 1). `Consulta.tsx`
  trata a estimativa de forma transparente (sem mudança visual no footer).
- 🔴 **PAGINAÇÃO POR OFFSET EXIGE DESEMPATE ÚNICO — `lib/stableOrder.ts` (2026-08-03, não
  regredir):** `ORDER BY coluna` **não define ordem total** quando há empates, e a ordem efetiva
  muda com o plano de execução. Como cada página é uma consulta NOVA, uma linha empatada pode cair
  no fim da página N e reaparecer no início da N+1 (**duplicada na tela**) enquanto outra é pulada
  nas duas (**some da tela** — o sintoma pior, porque não gera erro nenhum: a conta simplesmente
  deixa de ser paga). Provado no banco: a mesma página (`offset 100, limit 50`, `due_date desc`)
  devolveu conjuntos DIFERENTES conforme o plano — 1 linha entrou, 1 saiu. **Empates são a norma:**
  ordenar por Situação empata **682 de 682** linhas (maior grupo 493); tipo de documento 677;
  vencimento 647. Todo `order` de listagem paginada passa por `stableOrder({column, dir, fallback,
  tiebreak})`, que anexa a **PK** ao final (`due_date.desc,id.desc`) — aplicado em `/consulta`,
  `/erros`, `/emails` e nos dois logs de cobrança. Na Next API o equivalente é **`applyOrder`**
  (`lib/sort.ts`), usado pelos 7 CRUDs + `contas`; a guarda `lib/sort.guard.test.ts` **lê o código**
  e reprova qualquer listagem paginada nova que chame `.order()` direto. Caso de origem: duas linhas
  idênticas no grid de `/consulta` (conta 708 exibida 2×).
- **`lib/appendUniqueById.ts` — 2ª barreira, no scroll infinito de `/consulta`:** o desempate acima
  elimina o não-determinismo do PLANO, mas não o do CONJUNTO — o reader grava contas a cada 5 min e
  o botão "Atualizar" dispara leitura sob demanda, então uma inserção entre a página N e a N+1
  desloca a janela do offset e reexibe uma linha. A dedup por `id` é o que garante o invariante que
  o usuário enxerga ("a mesma conta nunca aparece 2×"); **preserva a versão já em tela**, senão a
  curadoria NF/Boleto em voo piscaria de volta ao valor antigo. `Consulta.load()` ainda carrega uma
  **guarda de geração** (`requestSeq`): um append em voo que responde DEPOIS de um replace (troca de
  filtro/ordenação) concatenaria a página da consulta ANTIGA sobre a lista nova — o `loadingMoreRef`
  serializa appends entre si, não append × replace.
  > ⚠️ **DIAGNÓSTICO — "o grid mostra o valor ANTIGO depois de eu corrigir o dado no banco" NÃO é
  > regressão do pipeline** *(falso alarme real em 2026-08-04)*. "Preserva a versão já em tela" é
  > exatamente isso: uma linha carregada ANTES de uma correção feita por fora (SQL, outro usuário,
  > reprocessamento) continua exibindo o valor velho enquanto a aba viver — carregar mais páginas
  > **não** a atualiza, porque a dedup por `id` mantém a versão que já está na lista. O caso: a
  > conta **794** (fatura SSW) aparecia como `TRANSPORTADORA J.D.F.` na tela **um dia depois** de
  > ter sido corrigida para PANTANAL no banco, e o relato chegou como "voltou a puxar o nome
  > errado". **Antes de investigar o extrator, confira o dado no banco e mande recarregar**
  > ("Buscar"/F5). Só se a linha continuar errada APÓS o reload é que o problema está no caminho de
  > leitura (`SELECT_WITH_EMBEDS`) ou na extração.
- `services/emailReader.ts` — leitura IMAP **assíncrona com progresso** (proxy Vite → Flask):
  `startEmailRead` faz `POST /api/emails/read/start` (Flask dispara `run_reader` numa **thread**
  e responde na hora) e `getEmailReadProgress` faz `GET /api/emails/progress`. `Emails.handleRead`
  faz **poll a cada ~1,5s** mostrando um banner com fase + barra `done/total` + contadores +
  cronômetro (`elapsed`), e recarrega KPIs/tabela a cada ~5 polls. **Por que assíncrono:** o
  modelo síncrono antigo segurava um request por minutos — o proxy derrubava a conexão e o botão
  "voltava" antes do fim (parecia travado). `run_reader(on_progress=...)` é a fonte do progresso
  (callback best-effort, não derruba o run); o estado vive em `server/app.py` (dict + lock, **um
  job por vez**). O `POST /api/emails/read` síncrono permanece só para a ponte da Next API.
  **Reconexão ao job (não regredir):** o poll vive em `trackJob` (idempotente via `trackingRef`),
  reusado por `handleRead` **e** por um efeito no mount que consulta `GET /progress` e, se houver
  job **rodando**, retoma banner + poll. Sem isso, atualizar a aba no meio do processamento perdia
  o estado e o botão parecia "pronto" enquanto o backend seguia registrando (total subia a cada
  refresh). O card **"Total de e-mails"** (sub-rótulo "na caixa de entradas") = contagem de
  `email_control`, que converge para o total do INBOX **quando o job termina** (não antes).
  **`/consulta` reusa o mesmo motor:** o botão **"Atualizar"** (topo direito) dispara
  `startEmailRead({ days: 7 })` + poll de progresso (mesmo padrão: banner `info` "Buscando
  e-mails dos últimos 7 dias…", recarrega o grid ao vivo a cada ~5 polls e no `finally`, e
  suspende/retoma o logout por inatividade) — assim traz e-mails novos **sem abrir `/emails`**.
  O **label permanece "Atualizar"** (só ganha spinner + disabled enquanto processa); a guarda
  `readingRef` evita disparos concorrentes. Não há reconexão ao job aqui (escopo do `/emails`).
- **TanStack Query v5 — rollout PENDENTE para `Consulta.tsx` e `Emails.tsx`:** o padrão já está
  aplicado em `SuppliersPage` (`staleTime: 60_000`, `gcTime: 300_000`, `refetchOnWindowFocus:
  false`). As duas páginas de maior volume ainda usam `useEffect`+`fetch` direto; migrar seguindo
  o mesmo padrão de `SuppliersPage` quando houver oportunidade. **Não** adicionar `useMemo`/
  `useCallback`/`React.memo` manualmente — o React Compiler cuida da memoização.
- **Disparo de leitura IMAP é OCULTO em produção (`src/lib/featureFlags.ts` → `EMAIL_READER_ENABLED`):**
  os 3 botões que acionam o Flask — `/emails` **"Buscar novos"** + **"Busca Geral"** e `/consulta`
  **"Atualizar"** — só renderizam quando a flag está ligada. A flag é `import.meta.env.PROD ? false :
  true` por padrão (LIGADA em dev, DESLIGADA no build do Vercel, onde **não há Flask**); override
  `VITE_EMAIL_READER_ENABLED='true'` reativa (quando o Flask for exposto numa VM). O efeito de
  **reconexão ao job** em `/emails` (poll de `GET /progress` no mount) também é pulado quando a flag
  está desligada (não tenta falar com um backend inexistente). Os botões **"Buscar"** (filtro) e
  os **"Atualizar"** que só recarregam do Supabase (`/emails`, `/erros`, `/fornecedores`) **não** são
  afetados — funcionam no domínio. Ver memória [[vercel-deploy]].
- **Busca textual com debounce (form vs. aplicado) — padrão em `/consulta` e `/emails`:** o input de
  busca escreve num estado de **formulário** (`f.supplier` / `senderInput`), separado do valor
  **aplicado** que dispara o fetch (`applied.supplier` / `filters.sender`). Um `useEffect` com debounce
  de **350ms** e `cleanup` (`clearTimeout`) commita form→aplicado — **fonte única, sem `ref`** — com
  guarda `if (form === aplicado) return` (cobre o mount). Enter/Buscar commitam na hora; o `cleanup`
  cancela o timeout pendente quando o aplicado muda por outra via (Enter, card, limpar), eliminando a
  corrida em que um debounce antigo sobrescreveria o valor recém-aplicado. Isso evita o refetch a cada
  tecla (antes `/emails` recarregava por caractere porque `load` dependia de `filters` inteiro).
- **Fornecedor + classificação vêm de JOIN/embeds (migrations 040/041/042 + 047):**
  `financial_account_control` não guarda nome/CNPJ/CPF — só a FK `sk_supplier`.
  `getFinancialAccountControl` e `getAccountsByMessageId` usam o `SELECT_WITH_EMBEDS`:
  `*,supplier(trade_name,legal_name,cnpj,cpf),cost_center:financial_cost_center(cost_center_code,cost_center_description),chart_account:financial_chart_of_account(account_code,account_description,group:financial_chart_of_account_group(group_code,group_description),subgroup:financial_chart_of_account_subgroup(subgroup_code,subgroup_description))`.
  O embed de `chart_account` traz a **hierarquia aninhada** (grupo/subgrupo) para a **célula
  enriquecida "Plano de contas"** do grid (plano + grupo + subgrupo + centro de custo concatenados —
  ver seção do `useGridColumns`). O grid exibe o fornecedor por **`fmtSupplierName`** — fantasia +
  razão social **quando divergem** (ver a nota na seção do `useGridColumns`) — e **Plano de contas**
  (concatenado); a coluna **CNPJ/CPF** e a **coluna "Centro de custo"** foram **removidas do grid** (a
  primeira segue no detalhe; o centro de custo agora aparece dentro da célula de plano de contas).
  Lookups da Next API em `services/lookups.ts`. No **card de detalhe**
  de `/consulta`, o campo **Fornecedor** exibe `sk_supplier - nome` (helper `fmtSupplier`, que
  delega o nome a `fmtSupplierName`; fallback só o id quando o JOIN não traz nome) — o cabeçalho do painel, a coluna do grid e o CSV seguem só
  com o nome.
  A coluna **"Fornecedor" É ordenável** server-side por `supplier(trade_name)` (embed do PostgREST);
  ver a nota das colunas de embed acima. A **busca por fornecedor** resolve antes os `sk_supplier` que casam o termo
  na tabela `supplier` (nome/CNPJ/CPF + 4 e-mails, via `findSupplierIdsByTerm`) e filtra
  `sk_supplier=in.(...)` — o `applyFinancialFilters` casa ainda `invoice_number`/`subject`/
  `sender_email`, que são colunas próprias da conta.
- **Busca inclui a CLASSIFICAÇÃO CONTÁBIL (mesmo campo livre):** como
  `financial_account_control` só guarda as FKs `cost_center_id`/`chart_account_id` (grupo/subgrupo
  vêm por hierarquia a partir do plano), o termo resolve antes os ids nos cadastros e filtra por
  `cost_center_id=in.(...)`/`chart_account_id=in.(...)` — mesmo padrão do fornecedor. Resolvers em
  `services/supabase.ts` (espelham `findSupplierIdsByTerm`): `findCostCenterIdsByTerm` (casa
  `cost_center_code`/`cost_center_description`) e `findChartAccountIdsByTerm` (casa `account_code`/
  `account_description` do plano **OU** o grupo/subgrupo — resolve `chart_account_group_id`/
  `chart_account_subgroup_id` primeiro, via as FKs diretas migration 058, e entra como `.in.(...)` no
  `or` do plano). O helper `resolveSearchIds(term)` resolve fornecedor + centro + plano em **paralelo**
  (`Promise.all`) e alimenta os 3 call sites (grid/valor total/contagem). Ambos os cadastros **excluem
  o sentinela id 0** ("não informado" — `id=gt.0`). Busca por valor (`R$ …`) continua exata, pulando
  os resolvers. `applyFinancialFilters` acrescenta as duas cláusulas ao `or(...)` só quando o array
  não é vazio (evita `in.()` inválido). Testado em `services/supabase.test.ts` (composição pura do
  `or`); o placeholder/`aria-label` do input de `/consulta` citam a classificação.
  > **Não confundir com os FILTROS DEDICADOS da 2ª linha** (bullet abaixo): aqui é o campo
  > de busca LIVRE, que resolve ids por texto e os joga num `or(...)` **junto** de
  > fornecedor/nº doc/assunto — casa qualquer um deles. O filtro dedicado é escalar,
  > determinístico e combina com E. Os dois convivem: o `or=` continua sendo do termo livre.
- **Busca também por VALOR do documento + valores de `ilike` CITADOS (`services/supabase.ts`):**
  quando o termo da busca é um valor monetário (formato BR ou simples — `463,21`, `44.406,08`,
  `391`, `463.21`), `parseBrlAmount` o converte e adiciona `amount.eq.<valor>` ao `or(...)`
  (correspondência **exata**); termos não-numéricos seguem só na busca textual. Os valores dos
  `ilike` passam por `ilikeContains` (entre **aspas duplas**: `"*termo*"`) — sem isso, um termo com
  **vírgula** (ex.: `463,21`) quebrava o `or(...)` inteiro do PostgREST (a vírgula é delimitador de
  cláusula → erro `PGRST100 failed to parse logic tree`). Aplicado tanto em `applyFinancialFilters`
  (conta) quanto em `findSupplierIdsByTerm` (fornecedor). Índices de performance da busca em
  `financial_account_control` (migration **060**): GIN trigram em `invoice_number`/`subject`/
  `sender_email` (para `ilike '%termo%'`), btree em `amount` e em `created_at DESC`.
- **BARRA DE FILTROS de `/consulta` — GRADE ÚNICA de 8 colunas (2026-08-05):** as duas
  linhas (busca/selects e classificação contábil) vivem num **único `grid`** com o template
  declarado uma vez (`grid-cols-[minmax(25rem,1fr)_16.5rem_11rem_10rem_10rem_8.5rem_8.5rem_8.5rem]`),
  para as colunas se alinharem: **Empresa↔plano de contas · Tipo Documento↔Sub grupo · Tipo
  Pagamento↔Grupo · Situação↔Centro de custo · data final↔Buscar · seletor da coluna de
  data↔Limpar**. A coluna 2 é a mais larga depois da busca (**16,5rem**, pedido do dono do
  produto em 2026-08-05) porque Empresa e plano de contas carregam os textos mais longos; as
  colunas **6, 7 e 8 são iguais (8,5rem)** para que os campos De/Até, o seletor de data e os
  dois botões casem entre si — é o que mantém "Buscar" com a largura de "data final" e
  "Limpar" com a de "Vencimento". A linha de mês/ano fica **fora** da grade, intocada.
  - 🔴 **A sobra da direita é absorvida pela BUSCA — `w-full min-w-max` + `minmax(25rem,1fr)`
    na coluna 1** (2026-08-05). Com `w-max` puro a grade tinha a largura exata dos tracks e
    deixava espaço em branco à direita em qualquer tela maior; agora ela ocupa o contêiner, o
    `1fr` come a folga e todo o resto encosta à direita. O **par é obrigatório**: sem
    `min-w-max` o `w-full` deixaria a grade encolher abaixo dos tracks em tela estreita, em vez
    de rolar no `overflow-x-auto`. É o caso previsto na regra do `1fr` logo abaixo — mínimo
    explícito, nunca `1fr` cru.
  - 🔴 **Piso das colunas 3 e 4 = 11rem/10rem.** Uma tentativa de encolher as duas para 9rem
    (2026-08-05) **cortou os placeholders** "Tipo Documento" e "Tipo Pagamento" no estado
    vazio — que é justamente quando o rótulo é a única pista do que o campo faz. A estimativa
    de 9rem ≈ o texto a `text-sm` ficou curta na medida real do navegador; não repetir sem
    conferir em tela.

  Disposição (2026-08-06): **1ª linha** = busca · Empresa · Tipo Documento · Tipo Pagamento ·
  Situação · data inicial · data final · **seletor da coluna de data**; **2ª linha** =
  **controles do grid** · plano · sub grupo · grupo · centro de custo · _(vazia)_ ·
  **Buscar** · **Limpar**. Os dois botões ficam lado a lado, no fim da 2ª linha.
  - 🔴 **Os controles da toolbar do grid (densidade · colunas · restaurar) ocupam a coluna 1
    da 2ª linha, sob a busca — e chegam lá por PORTAL** (`toolbarControlsTarget` no
    `DataGrid` → `controlsPortalTarget` no `GridToolbar`, 2026-08-06). Portal e não elevação
    de estado: o layout do grid vive no `useGridPreferences` do próprio `DataGrid`, e subi-lo
    para a página tocaria **todas** as telas com grid para atender só a `/consulta`. A prop
    tem **três** valores com semânticas distintas — **ausente** = inline acima do grid (o que
    as demais telas continuam fazendo), **elemento** = portal, e **`null`** = portal pedido
    com o nó ainda não montado, que **não renderiza nada naquele quadro**; sem esse terceiro
    caso os botões apareceriam acima do grid no 1º render e pulariam para o slot no seguinte,
    porque o callback ref do destino só resolve depois do primeiro render da página.
    O slot é `<div>` **vazio**, logo **sem `aria-hidden`** (o conteúdo que chega nele é
    interativo).
  - 🔴 **A barra de SELEÇÃO (N selecionadas · situação em lote · exportar · limpar) mora no
    CABEÇALHO DA PÁGINA, por um SEGUNDO portal** (`toolbarSelectionTarget` no `DataGrid` →
    `selectionPortalTarget` no `GridToolbar`, 2026-08-07) — mesmo contrato de três valores.
    **Com esse portal a faixa acima do grid NÃO é emitida**, e é daí que vêm os 48px extras
    de linhas de dado.
    **O histórico é o que impede reverter por engano.** A barra ficava numa faixa logo acima
    do cabeçalho do grid, e essa faixa precisava reservar **48px (`min-h-12`) mesmo VAZIA**:
    emiti-la só quando havia seleção fazia o grid inteiro **descer ~48px ao marcar a primeira
    linha**, e selecionar várias contas em sequência (baixa em lote) é o uso normal — o
    conteúdo saltando sob o ponteiro faz o clique seguinte cair na linha errada. Ou seja,
    pagava-se altura de grid em **toda sessão** para proteger **um** clique.
    O cabeçalho resolve os dois lados porque **já tem altura própria**: o bloco do título mede
    38px (`text-sm` 20 + `text-xs` 16 + `mt-0.5`), e é por isso que a barra leva **`py-0.5` no
    modo portal** (34px do `.btn` + 4 = **exatos 38px**) em vez do `py-1.5` do modo inline —
    com o padding inline ela mediria 46px e o cabeçalho **cresceria 8px** ao marcar a primeira
    conta, reintroduzindo em miniatura o salto que a mudança existe para eliminar. **De
    brinde:** o cabeçalho está FORA do `overflow-y-auto`, então as ações em lote continuam
    alcançáveis com o grid rolado — o que a faixa antiga não dava.
    🔴 **A altura só fica estável porque NADA naquela linha pode quebrar** *(achado do code
    review de 2026-08-07)*. O `py-0.5` resolve a barra em isolamento; sob pressão
    **horizontal**, porém, o texto quebra e o cabeçalho cresce assim mesmo. Medido por
    aritmética de classes (**não em navegador**): num notebook 1366×768 com a sidebar aberta
    são ~1.110px úteis, contra ~1.170px de título (~190) + barra (~580) + botões (~330) +
    gaps/padding. Por isso o título leva **`truncate` no `<h1>` E no `<p>`** e o rótulo
    "N selecionadas" leva **`whitespace-nowrap`**: o bloco encolhe com reticências em vez de
    virar duas linhas. ⚠️ O `min-w-0` do bloco do título é **necessário e insuficiente** —
    sozinho ele só remove o piso `min-content` e deixa o texto quebrar mais cedo; é o par
    `min-w-0` + `truncate` que dá "encolhe sem crescer". Travado em `Consulta.test.tsx`
    ("o título do cabeçalho encolhe sem quebrar linha").
    Travado também em `GridToolbar.test.tsx` (barra no slot **e** ausência do `min-h-12`; o
    padding compacto) e em `Consulta.test.tsx` (POSIÇÃO: dentro do cabeçalho, fora da área
    rolável) — todos validados por mutante, com o mutante **sutil**: manter o portal E
    continuar emitindo a faixa. Esse é o defeito a temer, porque a barra apareceria no lugar
    certo com os 48px ainda perdidos, e o único sintoma seria o espaço em branco na tela.
    ⚠️ **`getByText('N selecionadas')` NÃO é guarda suficiente** — com portal ele acha a barra
    em qualquer lugar do DOM. O que precisa ser observado é a posição, como já valia para os
    controles.
    ⚠️ **O estado COM seleção precisa de varredura a11y própria** — ele só existe depois de um
    clique, então os casos de página em repouso não o alcançam: cinco controles entraram numa
    linha que antes tinha só título + 2 botões. `Consulta.a11y.test.tsx` marca uma linha e roda
    o axe; validado pelo mutante que remove o `aria-label` do ✕ (→ `button-name`). Mesmo
    princípio de `DashboardHeader.a11y.test.tsx`, que varre os dois estados que mudam a árvore
    acessível.
    ⚠️ **Uma barra flutuante (`fixed`) foi considerada e DESCARTADA:** o rodapé de `/consulta`
    ("N de M registros · Carregar mais") fica logo abaixo do card, em fluxo, e uma barra presa
    ao rodapé da viewport o cobriria — trocaria um defeito por outro.
  - 🔴 **A coluna 1 subiu de 22,5rem para 25rem por causa desses botões** — Confortável ·
    Compacto · Colunas · Restaurar somam **~24,5rem** (estimativa da soma das classes, **não
    medida em tela** — conferir no navegador antes de tratar como fato), e em 22,5rem
    invadiriam a coluna 2 na largura mínima da grade. O bloco de controles leva `flex-wrap`
    como rede: se faltar espaço (fonte maior, zoom), ele quebra a linha em vez de sobrepor a
    vizinha.
  - 🔴 **O painel do `ColumnVisibilityMenu` também saiu por PORTAL** (`createPortal` no body +
    `position: fixed` medido do botão, 2026-08-06) — **pelo mesmo motivo do menu do
    `ChartAccountSelect`, e descoberto porque a mudança acima o recolocou dentro do
    `overflow-x-auto`**. Era `absolute right-0`: ancorado num botão da 2ª (e última) linha da
    grade, nascia clipado e a gestão de colunas ficava inutilizável na tela, sem erro nenhum.
    **A regra é do MECANISMO, não do componente:** todo popover/menu que passar a viver dentro
    daquele contêiner precisa de portal. **CINCO** detalhes que o portal obriga e que já
    morderam:
    (1) o **clique-fora passa a olhar DOIS nós** (wrapper + painel) — com o painel fora da
    subárvore, o `!contains` do wrapper fecharia o menu no primeiro checkbox marcado;
    (2) o menu **fecha ao rolar/redimensionar** (um `fixed` descolaria do botão), mas o
    listener usa `capture` e por isso **precisa ignorar a rolagem da própria lista**
    (`max-h-72 overflow-y-auto`, que é o uso normal com ~14 colunas) — sem essa guarda o
    painel se fechava no meio da rolagem; (3) a posição é medida do **botão**
    (`e.currentTarget`), não do wrapper `div.relative`, que é block-level e, fora de um flex,
    esticaria e jogaria o alinhamento pela direita para a borda do contêiner;
    (4) 🔴 **o clamp precisa ser dos DOIS eixos — a assimetria era o defeito** *(achado do
    code review de 2026-08-07)*. Só `left` era contido contra `window.innerWidth`; `top` era
    `r.bottom + 4` puro. Num viewport de 768px (≈678 de `innerHeight`) o painel de ~332px
    aberto a partir de `bottom ≈ 350` terminava em ~686 e **perdia os últimos itens sem
    nenhuma indicação** — e, sendo `fixed`, rolar a página não os traz (pior: a rolagem fecha o
    menu, pelo item 2). Hoje `measure()` devolve também `maxHeight`, abre **acima** do botão
    quando embaixo não cabe e em cima cabe mais, e o painel é `flex flex-col overflow-hidden`
    com a lista em `flex-1`, para o limite virar rolagem interna em vez de conteúdo cortado;
    (5) 🔴 **a LARGURA sai do `style`, a partir da mesma constante que alinha o painel**
    (`PANEL_WIDTH`), e **não** de uma classe `w-*`. Com a largura numa classe e o alinhamento
    numa constante, trocar `w-72` por `w-80` desalinharia o painel em 32px **sem erro e sem
    teste vermelho**, porque o cálculo continuaria subtraindo 288 — dois lugares para um número
    só. O guarda observa a amarração, não o valor: `left + width === r.right` do botão, mais a
    proibição de `w-\d` na classe.
    Os cinco estão travados em `ColumnVisibilityMenu.test.tsx` + o guarda estrutural em
    `Consulta.test.tsx` (o painel não pode ter ancestral `.overflow-x-auto`), todos validados
    por mutante.
  - 🔴 **QUATRO âncoras explícitas, e nenhuma é estilo:** `col-start-8` (seletor de data,
    fechando a 1ª linha), `col-start-2` (plano, abrindo a 2ª), `col-start-7` (Buscar) e
    `col-start-8` (Limpar). O cursor do auto-placement **nunca anda para trás**, então cada
    posição depende da anterior — e mexer numa desloca as seguintes em silêncio. Já aconteceu
    duas vezes: quando o seletor de data deixou de ocupar duas colunas, o "Limpar" caiu na 7;
    quando o seletor subiu para a 1ª linha, os dois botões escorregaram para a 6. As quatro
    estão travadas no mesmo teste, junto do template — validadas por mutante.
  - 🔴 **Os FILTROS CONTÁBEIS começam na COLUNA 2** (`col-start-2` no wrapper do plano —
    pedido do dono do produto, 2026-08-05): cada um herda a largura do controle acima. Desde
    2026-08-06 o slot da toolbar ocupa a coluna 1 e já deixaria o cursor na 2, mas a âncora
    fica **explícita** — remover ou mover o slot puxaria os quatro filtros uma coluna à
    esquerda em silêncio. **Só o primeiro item é posicionado à mão**; sub grupo,
    grupo e centro de custo caem em 3, 4 e 5 pelo auto-placement, que nunca anda para trás.
    Consequência aceita: o plano passou de 22,5rem para **11rem**, então descrição longa
    ("Mercadorias para Revenda") trunca com reticências — é o preço de casar as larguras.
    Travado em `Consulta.test.tsx` (template de tracks **+** ancoragem em `col-start-2`;
    validado por mutante) — sem as duas asserções, mexer numa das pontas quebra o alinhamento
    com o teste verde.
  - 🔴 **Os controles NÃO levam `w-*`** — o `w-full` do `@utility input` preenche a célula e
    os `.btn` são esticados pelo grid. "Mesma largura" é **estrutural** (uma declaração de
    tracks), não dois `w-*` mantidos à mão em pontos distantes do arquivo.
  - 🔴 **Tracks em comprimento explícito, NUNCA `1fr` cru:** `fr` tem mínimo `min-content`, e
    o `min-content` de um `<select>` é a opção mais longa — as descrições de centro de custo
    estourariam a coluna. Se precisar de `fr`, tem de ser `minmax(0, 1fr)`.
  - 🔴 **O `overflow-x-auto` + `w-max` do wrapper não é cosmético:** grid não quebra,
    transborda. Confinar o overflow ali faz as duas linhas rolarem JUNTAS (o alinhamento
    sobrevive em tela estreita, ao contrário do `flex-wrap` anterior, que o destruía) e
    impede que o scroll lateral vaze para a página — o container externo é `overflow-y-auto`,
    cujo `overflow-x` computa para `auto`, e arrastar o `DataGrid` junto quebraria as colunas
    fixadas (`position: sticky`). **Medido:** a grade pede no MÍNIMO **1672 px** (98rem de
    tracks + 3,5rem de gaps + o `px-6` da página) — ou **~1880 px de viewport** com a sidebar
    de 208 px; abaixo disso ela rola, acima ela preenche. As colunas 1 (busca/toolbar) e 2
    (Empresa/plano) somam **42% da barra** e é nelas que está a folga, se um dia for preciso
    caber em tela menor.
  - **A célula vazia da coluna 6 da 2ª linha (sob "data inicial") NÃO tem spacer** — o
    posicionamento é explícito pelas quatro âncoras acima. Spacer decorativo exigiria
    `aria-hidden`, que vira violação `aria-hidden-focus` se um dia envolver algo focável.
    (A da coluna 1 deixou de existir: é onde vivem os controles do grid.)
- **FILTROS DEDICADOS de classificação contábil — 2ª linha da barra de `/consulta`
  (2026-08-04):** Plano de contas (por **descrição**, busca digitável), Sub grupo, Grupo e
  Centro de custo. **Independentes** (combinados por AND, sem cascata). Entram em
  `ConsultaFilters` **e em `BASE_FILTERS`** — é isso que faz "Limpar" e os cards de KPI
  zerá-los sem código dedicado. A busca genérica segue sendo o 1º e mais largo controle.
  - **Centro de custo é FK DIRETA** da fato (`cost_center_id=eq.N`, sem join). **Plano,
    grupo e subgrupo NÃO são colunas de `financial_account_control`** — vivem em
    `financial_chart_of_account`, e o filtro é em **recurso EMBUTIDO** do PostgREST
    (`chart_account.chart_account_group_id=eq.N`).
  - 🔴 **O `!inner` é OBRIGATÓRIO e a falha sem ele é SILENCIOSA.** Medido contra o banco
    real: embed simples + `chart_account.chart_account_group_id=eq.24` devolve **706** (a
    tabela INTEIRA), com **HTTP 200** — o filtro não descarta nada e a tela mostraria a base
    completa como se estivesse filtrada; com `!inner`, **198**, que é o que o SQL dá. Por
    isso `applyFinancialFilters` promove o `select` via **`withChartAccountJoin`**, e só
    quando há filtro de plano/grupo/subgrupo — sem eles a URL de abertura da página fica
    **idêntica** à de antes (travado por teste). Com `select` vazio o helper cai em
    **`*,<embed>`**, nunca só no embed: devolver apenas o recurso embutido produziria um
    `select` sem nenhuma coluna de topo — 200 com linhas vazias e grid em branco, sem erro.
    O contrato "o chamador já setou o `select`" vale para as 3 rotas de hoje, mas contrato
    escrito só em comentário não protege a 4ª.
  - 🔴 **O valor de `eq.` vai CRU — NUNCA entre aspas.** É o oposto do `ilikeContains`, e a
    tentação de "reusar o padrão" quebraria todo o filtro: medido, `eq."Serviços Gerais"`
    devolve **0** linhas (as aspas entram no valor comparado) e `eq.Serviços Gerais` devolve
    as 2 corretas — inclusive para descrição com **vírgula** ou **parênteses**, que existem
    (9 planos). O PostgREST só interpreta aspas **dentro de lista** (`or=`, `in.()`), que é
    o caso do `ilikeContains`, não em parâmetro isolado. Travado por teste + mutante.
  - **O join é loss-free**: `chart_account_id` é `NOT NULL DEFAULT 0` e a linha sentinela id 0
    EXISTE (migration 048) — medido 706 contas → 706 após o join. Sendo **to-one**, também não
    duplica linha, o que quebraria a paginação por offset do scroll infinito.
  - **`getFinancialAccountControl` deixou de re-listar os filtros**: recebe o objeto inteiro e
    o repassa, como os dois de KPI já faziam. Antes ele destrinchava 14 campos e remontava um
    literal — campo novo que entrasse só na interface era descartado ali **em silêncio**, com
    os KPIs respeitando o filtro e o grid não.
  - **Opções**: `useClassificationFilterOptions` (3 lookups em **paralelo**, `allSettled` para
    que uma lista que falha não zere as outras, cache de módulo, falha silenciosa). O **plano
    de contas fica FORA dele** — é `ChartAccountSelect variant="filter"`, que **não carrega
    nada na montagem** (só no 1º clique que abre o menu). Virar `defaultOptions` de `false`
    para `true` **não** funcionaria: no react-select 5.10.2 o efeito de carga tem deps `[]`
    ("designed to only run when the component mounts"); o que ele reavalia é o
    `defaultOptions` quando é **array** — por isso a lista é buscada no `onMenuOpen` e
    entregue como array. 🔴 **Só o SUCESSO é memoizado** (`if (opts.length > 0)`):
    `loadOptions` engole a exceção e devolve `[]`, então gravar esse `[]` marcaria "já
    carregado" e a guarda bloquearia toda abertura seguinte — a Next API piscando no
    instante da 1ª abertura deixava o menu vazio pelo resto do mount. Lista legitimamente
    vazia custa uma requisição por abertura; é o preço de não fossilizar uma falha.
  - **Limitação conhecida:** o sentinela id 0 ("não informado") **não é filtrável** — os três
    lookups o excluem. O código já o suporta (`!= null`, não truthy), então oferecê-lo é só
    mudar os lookups.
  - 🔴 **O menu do `ChartAccountSelect` (variante filtro) sai por PORTAL** (`menuPortalTarget=
    document.body`, 2026-08-05). A grade única acima vive num `overflow-x-auto`, e pelo CSS
    `overflow-x: auto` com `overflow-y: visible` faz o **Y computar para `auto` também** — o
    contêiner corta na vertical. O react-select renderiza o menu **inline**, logo abaixo do
    controle, então ele nascia CLIPADO: nenhuma opção aparecia. Digitar o texto exato
    "funcionava" apenas porque a opção invisível ficava focada e o Enter a escolhia — daí o
    relato "só acha com o texto inteiro, e o grid não filtra". ⚠️ **Portal SÓ na variante
    `filter`**: no `form` o select vive dentro de um `<dialog>` aberto por `showModal()`, que
    pinta na **top layer** — portal para o body ficaria ATRÁS do modal, trocando um sumiço por
    outro. **Nenhum teste de dado pega isto** (jsdom não faz layout); o guarda em
    `Consulta.test.tsx` é ESTRUTURAL — a opção renderizada não pode ter ancestral
    `.overflow-x-auto` —, com asserção de sanidade de que o contêiner existe na tela.
  - 🔴 **O FILTRO oferece só os planos EM USO; o FORMULÁRIO, o cadastro inteiro**
    (2026-08-05). São **fontes distintas por variante**, e não unificar é o ponto:
    `variant='filter'` chama `listUsedChartAccountDescriptions` (`services/supabase.ts`) e
    `variant='form'` segue em `listPlanoDescriptions` (Next API) — restringir o formulário ao
    que já foi usado impediria justamente a PRIMEIRA conta de um plano novo. Medido: **611
    planos cadastrados × 84 descrições distintas de fato em uso**; oferecer os outros 527 era
    o que produzia grid vazio ao escolher um plano sem conta nenhuma.
    - **A consulta é pelo lado do CADASTRO, com embed reverso `!inner`**
      (`financial_chart_of_account?select=account_description,financial_account_control!inner(id)`),
      nunca pelo lado do fato. O grão decide o volume: **85 linhas** (teto estrutural = as 611
      do cadastro) contra **724** pelo caminho direto, que cresce a cada conta lançada.
      `financial_account_control.limit=1` corta o array de filhos, que não é usado — 7,6 KB.
    - 🔴 **Sem o `!inner` o embed vira LEFT JOIN e a consulta devolve o cadastro INTEIRO com
      HTTP 200** — o filtro volta a oferecer plano sem conta e nada acusa. Mesma armadilha
      silenciosa do filtro de classificação; travada por teste + mutante.
    - 🔴 **Vive em `services/supabase.ts` (Supabase REST com o token do usuário), NÃO na Next
      API:** lá a leitura é `service_role`, que ignora RLS — um usuário de grupo restrito
      (`sees_only_own_accounts`) receberia opções que o grid dele não consegue mostrar. Com a
      RLS valendo dentro do embed, o `!inner` recorta sozinho.
    - **Busca GERAL, independente dos filtros em tela** (requisito): a consulta não leva
      período nem situação, então a lista é a mesma em qualquer estado da barra. É paginada
      (página de 1000, teto de 5) — o corte por "Max rows" volta 200 e sumiria opção sem erro.
    - O sentinela id 0 continua fora (`account_description=not.is.null`), coerente com os
      outros três filtros contábeis.
  - 🔴 **A DIGITAÇÃO no `ChartAccountSelect` filtra em MEMÓRIA, não no servidor** (2026-08-05).
    O catálogo inteiro (~610 linhas postáveis) vem numa requisição só, guardada num
    `catalogRef` **por instância** (ref, não estado: a atribuição imediata faz duas chamadas
    concorrentes — abrir o menu e já digitar — compartilharem a MESMA promessa). Antes cada
    tecla disparava `?search=<termo>`: medido no dev server contra o cadastro real, **420 a
    1160 ms por requisição, uma por caractere, com respostas fora de ordem** — e o react-select
    descarta todas menos a da última emitida, então a lista só assentava quando o usuário
    **parava** de digitar. Era o sintoma "o filtro não oferece os planos conforme digito; só
    achando o texto inteiro". Ganho de brinde: o filtro local **ignora acento** (`\p{Diacritic}`),
    o que o `ilike` do PostgreSQL não faz — "servicos" passa a achar "Serviços". **Trade-off
    deliberado:** a busca por **código** do plano deixou de existir (o `or` do servidor casava
    `account_code`); o código não é exibido na opção, então casar por ele devolvia uma
    descrição que o usuário não tinha como conferir. A falha do carregamento **não** é
    memoizada (mesma lição do `filterDefaults`). Guardas em `ChartAccountSelect.test.tsx`
    travam a CONTAGEM (1 requisição, sem argumento) — `toHaveBeenCalled()` continuaria verde
    com o defeito.
  - 🔴 **O grid vazio NOMEIA o período em vigor** (`emptyGridMessage`). A mensagem antiga
    ("ajuste os filtros e clique em Buscar") passou a mentir duas vezes com a aplicação
    automática: o filtro **já** foi aplicado, e "Buscar" agora **alarga** o período. Como o
    filtro auto-aplicado RESTRINGE dentro do mês em tela, um plano que existe no cadastro mas
    não tem conta naquele mês devolve zero linhas — e sem nomear o período isso é
    indistinguível de filtro quebrado. Medido: "Mercadorias para Revenda" tem **192** contas no
    total e **60** em agosto/2026; "Cursos Profissionalizantes" existe no cadastro e **não tem
    conta alguma**.
- **DOIS seletores de data INDEPENDENTES em `/consulta` (2026-08-05):** `dateField` (linha
  dos meses, 2 opções) governa **só** os botões de mês/ano; **`rangeDateField`** (seletor
  próprio na grade, 3 opções — Emissão/Vencimento/**Pagamento**, default vencimento) governa
  **só** o intervalo De/Até. Antes havia UMA variável servindo aos dois.
  - 🔴 **`applyFinancialFilters` tem `rangeCol` e `periodCol` separados — não colapsar num
    `rangeDateField ?? dateField`.** É o mutante que preserva todas as referências, passa em
    typecheck e lint, e só se manifesta quando os dois divergem: a consulta responde **200
    filtrando pela coluna errada** e a tela mostra um conjunto plausível. Travado pelo par de
    testes de mão dupla em `supabase.test.ts` ("coluna de data do intervalo × do período") —
    um teste de mão única continuaria verde.
  - 🔴 **O `else if` mantém os dois ramos MUTUAMENTE EXCLUSIVOS** (intervalo tem precedência
    sobre mês/ano). Virar `if` filtraria as duas colunas por AND, devolvendo quase sempre
    vazio, sem erro.
  - 🔴 **Com intervalo preenchido o seletor do PERÍODO fica SUSPENSO — e NÃO se desabilita
    por isso** *(decidido no code review de 2026-08-07)*. Pela precedência acima, trocar
    `dateField` com De/Até preenchidos não muda a consulta na hora, o que parece controle
    quebrado. Desabilitá-lo foi a correção **considerada e rejeitada**: os botões de mês
    **limpam `dateFrom`/`dateTo`** ao serem clicados, então `dateField` não é inútil, é
    **diferido** — é a coluna que passa a valer no MESMO clique que limpa o intervalo, e
    bloquear o seletor obrigaria a apagar as datas antes de poder escolher a coluna. A saída
    foi de LEGIBILIDADE: nome acessível "Tipo de data **do período**" +
    `aria-describedby` (`PERIOD_DATE_FIELD_HINT`) explicando a suspensão, mesmo padrão do
    seletor do intervalo. Antes de "consertar" um controle que parece inerte nesta tela,
    verifique se ele é inútil ou apenas diferido.
  - 🔴 **`rangeDateField` mora em `BASE_FILTERS`**, não só em `initialFilters()` — é o que
    mantém o card "A vencer em 7 dias" sobre **vencimento** mesmo com "Pagamento" escolhido
    antes do clique (o spread de `allPeriodFilters()` reseta primeiro).
  - 🔴 **O `aria-label`/`title` dos campos De/Até deriva de `rangeDateField`**, via
    `RANGE_DATE_FIELD_LABEL` (um `Record`, não ternário: com 3 valores, um ternário rotularia
    `payment_date` como "Emissão"). Derivá-lo de `dateField` faria o leitor de tela anunciar
    "Vencimento — data inicial" com a consulta usando `payment_date` — erro mudo que nenhuma
    asserção de dado pega.
  - **Ressalvas de DADO expostas ao usuário:** `payment_date` é NULL em toda conta não paga (o
    intervalo por pagamento descarta o que está em aberto — combinado com Situação "a vencer" dá
    **0 linhas sem erro**), e nas contas pagas antes da migration 096 o backfill gravou o
    VENCIMENTO. Não há dado real alternativo no banco.
    - 🔴 **A ressalva vive em `aria-describedby` + `<span class="sr-only">`, não só no `title`**
      (2026-08-05). `title` não aparece no toque, não é focável e, com `aria-label` presente,
      não é anunciado de forma confiável — a informação que explica as 0 linhas ficava invisível
      para teclado e leitor de tela. ⚠️ **`toHaveAccessibleDescription` NÃO trava isso**: sem
      `aria-describedby`, o próprio `title` vira a descrição acessível computada, e a asserção
      segue **verde com a ligação removida** (medido por mutante). O guarda tem de ler o
      ATRIBUTO, resolver o id e conferir o texto do elemento apontado — é o que
      `Consulta.a11y.test.tsx` faz.
  - **Sem De/Até preenchidos o seletor é um no-op** — consequência inerente de o intervalo só
    existir quando há datas. É deliberado, não defeito.
- **BUSCA AUTOMÁTICA: portão único de aplicação em `/consulta` (2026-08-05).** Todo filtro
  aplica sozinho, sem clicar em "Buscar" — via `queueApply(patch)`, que escreve em `f` na hora
  e acumula o patch num **estado** `pendingApply`, descarregado em `applied` por um efeito com
  janela de **300 ms**.
  - 🔴 **Aplicar direto no `onChange` de cada controle é a regressão a evitar:** um apply
    dispara 2 requisições (grid + KPIs — eram 3 até 2026-08-08, quando "Valor total" e
    contagem viraram uma consulta só), então compor um filtro de 7
    controles daria ~14; e `<select>` nativo no Firefox/Windows emite `change` a **cada opção
    percorrida com as setas**, multiplicando por opção. Travado por
    `toHaveBeenCalledTimes(1)` para 3 mudanças rápidas (validado por mutante: sem a janela,
    3 consultas). O guarda usa **`fireEvent`, não `userEvent`**: `selectOptions` custa ~90 ms
    e a janela é de 300 ms, então com `userEvent` o teste dependia de vencer uma corrida
    contra tempo real — vermelho espúrio sob carga, medindo velocidade em vez de coalescência.
  - **Trocar `rangeDateField` com De/Até vazios refaz as requisições para o mesmo conjunto —
    e isso fica assim DE PROPÓSITO.** Evitar exigiria não agendar o apply e deixar
    `applied.rangeDateField` **atrasado** em relação a `f.rangeDateField`, caindo em sincronia
    só quando o intervalo fosse preenchido. É inobservável hoje (com o intervalo vazio a coluna
    nunca é lida), mas cria um invariante de estado defasado que morde o primeiro consumidor
    futuro de `applied.rangeDateField` — rótulo de cabeçalho, coluna de CSV. Duas requisições
    num controle pouco tocado não pagam esse risco.
  - 🔴 **O pendente é ESTADO, não ref** — com refs, a leitura dentro dos handlers entrava na
    cadeia `cards → onCardClick` construída no render e caía em `react-hooks/refs`. O timer é
    propriedade do efeito, cujo cleanup o cancela no desmonte **e** quando um caminho síncrono
    (Buscar/Limpar/card/período) zera o pendente.
  - **Auto-aplicar RESTRINGE dentro do período em tela**; só o "Buscar" alarga — um botão
    "Buscar" que troca "Junho" por "todas as datas" sem avisar seria surpreendente. O rótulo
    visível segue **"Buscar"** (copy de produto) e o **nome acessível o CONTÉM**, como exige a
    **WCAG 2.5.3 (Label in Name)**; só o `title` deixava a mudança de escopo invisível para
    teclado e leitor de tela. O Enter foi **removido dos campos de data**, onde passaria a
    significar "alargar o período"; segue só na busca textual.
    - 🔴 **O nome acessível é DINÂMICO (`searchButtonName`), porque o efeito é** *(achado do
      code review de 2026-08-07)*. Sem intervalo → **"Buscar em todos os meses e anos"** (o
      clique zera mês/ano). **Com** intervalo De/Até preenchido → **"Buscar mantendo o
      intervalo de datas"**: o período já está global (defini-lo zera mês/ano) e o intervalo é
      **preservado**, então a frase antiga — "em todos os períodos" — era **falsa** justamente
      nesse estado, com a consulta seguindo restrita às datas digitadas. Limpar o intervalo no
      clique foi a alternativa **descartada**: seria perda silenciosa de entrada do usuário, e
      quem digitou datas e clica em "Buscar" por hábito perderia o recorte. O guarda a11y cobre
      **os dois estados** — um caso só deixaria a metade não exercitada livre para mentir.
  - 🔴 **Instrução na tela e nome acessível do botão citam a MESMA ação, e há guarda cruzada.**
    A mensagem do grid vazio manda "usar Buscar para procurar em todos os meses e anos", que é
    o nome acessível do botão sem o verbo — se os dois divergirem, a instrução aponta para um
    botão que "diz" outra coisa a quem usa leitor de tela. O teste do grid vazio **compara a
    mensagem com o `aria-label` do próprio botão** em vez de repetir a frase.
    ⚠️ **Foi aqui que um teste verde escondeu a divergência** *(lição de 2026-08-07)*: o caso
    se chamava "nomeia o mês em vigor **e aponta o caminho de alargar**" e asseverava só a
    primeira metade — reescrever a segunda frase da mensagem passava com a suíte inteira verde.
    É exatamente o defeito da Regra 2; a pergunta que o encontra continua sendo *"o que
    aconteceria se eu quebrasse isto de propósito?"*.
  - **Definir De/Até limpa mês/ano** (a precedência do serviço os ignoraria, e o mês aceso
    mentiria); **apagar as duas datas DESFAZ isso**, devolvendo o período que estava
    selecionado — sem esse caminho de volta o usuário fica preso em escopo global, com toda a
    base e nenhum mês em destaque.
    - 🔴 **O caminho de volta guarda o VALOR anterior (`periodBeforeRange`), não um booleano
      nem um default fixo** (2026-08-05). Duas coisas dependem disso, e as duas foram defeito
      real durante a implementação: (1) restaurar `nowRef` mandava para o mês CORRENTE quem
      navegava em Março — o desfazer tem de devolver o que havia; (2) condicionar o restauro ao
      **estado** do período (`month == null`) e não ao **fato** de o intervalo o ter zerado fazia
      quem chegou ao escopo global de propósito (card de KPI, "Buscar") ter a consulta
      **estreitada em silêncio ao mês corrente, com o card ainda aceso** — bastava digitar e
      apagar uma data. `periodBeforeRange` nulo = "não fui eu que zerei" e é o que impede o
      restauro; `resetFilterGate` o zera nos quatro caminhos síncronos. Travado por dois testes
      em `Consulta.test.tsx` (mês distinto do corrente por deslocamento; card ativo), ambos
      validados por mutante.
  - **`activeCard`** é preservado quando o filtro apenas restringe e limpo quando o usuário
    mexe no campo que o card possui (`statusId`; e o intervalo quando o card é `avencer7`).
  - **`refreshStats` VOLTOU ao efeito de `applied` em 2026-08-08** — a otimização anterior
    ("KPI global não depende de filtro, então não refaz a cada apply") caiu junto com a
    premissa: hoje os 5 cards refletem o filtro, então **têm** de ser refeitos a cada apply.
    O que a preserva em espírito é a **janela de 300 ms**, que já coalesce os applies. Os
    pontos que MUDAM dado (curadoria, situação, exclusão, leitura de e-mails) seguem
    chamando `refreshStats()` sob demanda, agora com o filtro corrente.
  > ⚠️ **Teste de "não consulta" com `flush()` (0 ms) é falso guarda** — foi o que aconteceu
  > aqui: o caso "escolher o filtro NÃO consulta antes do Buscar" continuou **VERDE** depois
  > de a aplicação automática entrar, porque `flush()` não alcança a janela de 300 ms; ele
  > media "ainda não consultou NESTE instante". Guarda de ausência com debounce no meio exige
  > avançar o tempo, não um tick.
- **KPIs de `/consulta` seguem o FILTRO — fonte ÚNICA (2026-08-08, decisão do dono do produto).**
  Os **5 cards e o rodapé** saem de uma só chamada, `getFinancialStats(applied)`; as funções
  `getFinancialAccountTotalValue` e `getFinancialAccountCount` foram **REMOVIDAS**.
  - 🔴 **O defeito era a DIVISÃO, não o número.** O card "Total de registros" tirava o **valor**
    da consulta filtrada e a **contagem** dos KPIs globais: com "Ago/2026" a tela dizia
    `R$ 3.766.725,46 / 742 conta(s)` — o R$ certo (agosto tem 211 contas somando exatamente
    isso) sobre a contagem da base inteira (742 = 784 − 42 canceladas), fazendo a média por
    conta sair ~3,5× menor que a real. A mesma página exibia **dois números diferentes sob o
    mesmo nome** (o rodapé filtrado, o card global). Três consultas por apply para valores que
    precisam concordar é o antipadrão; unificar é o que impede a divergência de voltar.
    ⚠️ O relato original incluía "'Todas' e '2026' dão o mesmo valor", que **não** era defeito:
    as 742 não-canceladas vencem todas em 2026, então filtrar o ano é de fato equivalente a não
    filtrar. Confira o dado antes de perseguir o filtro.
  - 🔴 **A varredura dos KPIs PAGINA — e não paginar seria falha SILENCIOSA e datada.** Ela
    conta e soma no cliente, e o PostgREST corta no **"Max rows" (1.000) devolvendo HTTP 200**:
    medido por HTTP nesta instalação contra `email_control` (1.303 linhas), `limit=1000`, `5000`
    e `10000` devolvem **1.000, sempre 200**, sem erro e sem sinal — ou seja, o `limit: 10000`
    da versão antiga dava falsa sensação de folga. Com **742** não-canceladas e ritmo medido de
    **~22 contas/dia**, os cinco cards passariam a subnotificar em **~12 dias**. É a MESMA lição
    da Onda 3 ("consulta REST cujo resultado vira dado precisa paginar"), que estava registrada
    só para os scripts Python enquanto o frontend repetia o padrão. `STATS_PAGE_SIZE = 1000` +
    **`order=id.asc`** (offset sem ordem determinística PULA linha — ver `stableOrder.ts`) +
    **`STATS_MAX_PAGES = 200`**, que **levanta** em vez de girar para sempre se o servidor
    ignorar o `offset`.
  - 🔴 **O card "A vencer em 7 dias" precisa FILTRAR o mesmo predicado que CONTOU** — o número
    vem de `status_id = a vencer` **E** vencimento na janela, mas o clique aplicava só o
    intervalo, e com `BASE_FILTERS.statusId = undefined` o grid voltava com qualquer situação
    não-cancelada: medido, o card dizia **68** e o clique trazia **69** (uma conta já paga
    vencendo na janela). `next7DaysRange()` passou a devolver também `statusId`. A divergência
    **cresce com a operação normal** — é a contagem de pagas dentro da janela.
  - **`getFinancialStats` recebe o objeto de filtros INTEIRO** e o repassa a
    `applyFinancialFilters`, como `getFinancialAccountControl` já fazia — destrinchar campo a
    campo faria um filtro novo ser descartado aqui **em silêncio** enquanto o grid o respeitasse,
    e o sintoma ("os KPIs estão errados") apareceria longe da causa.
  - **`fetchStats` NUNCA rejeita:** é chamada em ~8 pontos com `void` e o KPI é acessório —
    falha devolve `null`, os cards mantêm o último valor bom e o erro vai ao `console.error`
    (não silenciar sem log). A guarda de resposta obsoleta é o **`cancelled` do efeito**, não um
    ref de geração: um ref lido ali entraria na cadeia `handleStatusChange → getConsultaColumns`
    montada no render e cairia em `react-hooks/refs` (mesma razão de `pendingApply` ser estado).
    A guarda importa porque a varredura pagina, então é a chamada mais lenta da página e a
    resposta ANTIGA pode chegar depois da nova.
  - **O ajuste LOCAL de totais no hard delete foi REMOVIDO:** decrementar só "Valor total" e
    "Total de registros" deixaria o painel **meio atualizado** (o total cairia, mas
    "Pagos"/"Vencidas" seguiriam contando a conta removida) até o refresh responder.
    `refreshStats()` corrige os cinco de uma vez, a partir do servidor.
  - **Agregação no servidor (`sum()` do PostgREST) não é alternativa aqui:**
    `db-aggregates-enabled` vem **desligado** no Supabase — a mesma constatação da decisão 2 da
    Fase 0 do chat de IA. Por isso a soma é no cliente, e por isso ela precisa paginar.
- **`/consulta` — `cancelado` aparece no GRID, mas NÃO nos KPIs (mudança 2026-06-25):** a regra
  antiga ocultava cancelado em tudo; agora o **grid mostra canceladas** por padrão e os **KPIs as
  excluem** (para o "Valor total"/"Total de registros" não somar cancelado e gerar confusão). Como
  isso é implementado: `applyFinancialFilters` recebe `includeCancelled` (default **false** = exclui)
  — o **grid** (`getFinancialAccountControl`) passa `true`; os **KPIs** (`getFinancialStats`, que
  desde 2026-08-08 alimenta os 5 cards **e** o rodapé) usam o default e portanto excluem cancelado.
  Filtro explícito de situação (`status_id=eq.<id>`) sobrescreve tudo nos dois caminhos. **Consequência aceita:** o rodapé do grid ("N de M") conta
  canceladas e o KPI "Total de registros" não — divergência **intencional** (cancelado é visível,
  mas fora dos totais). Linha cancelada é pintada de vermelho (`bg-status-error-solid/15`, via
  `DataGrid rowClassName`), tom distinto do badge "vencido".
- **Grid compartilhado sobre TanStack Table v8** (`organisms/DataGrid.tsx`): `/consulta` (tema
  `default`) e `/emails` (tema `silver`) usam o mesmo grid, com as colunas de `useGridColumns.ts`
  (`getConsultaColumns` / `getEmailColumns`). O TanStack é **headless**: fornece row model (core),
  header groups e os estados de layout. A interface pública `DataGridProps<T>` é retrocompatível —
  features novas são **opt-in** via props.
  - **Sort e filtro seguem SERVER-SIDE** (Supabase): `manualSorting` ligado, sort via
    `onSort`/`sortCol`/`sortDir`, filtros nas páginas. **Nunca** ligar
    `getSortedRowModel`/`getFilteredRowModel`/`getPaginationRowModel`: o grid recebe linhas já
    filtradas/ordenadas pelo servidor, então esses modelos client-side agiriam sobre um subconjunto = bug.
  - **Virtualização de LINHAS + scroll infinito (opt-in `enableRowVirtualization`, usado em `/consulta`)** —
    `@tanstack/react-virtual`. `/consulta` deixou de paginar em botões e passou a **scroll infinito**
    (`Consulta.tsx`: `PAGE_SIZE=50`, acumula linhas, `loadMore` por `onLoadMore` do grid + botão
    "Carregar mais"; rodapé "{carregadas} de {total}"). Técnica **spacer-rows** (linhas em fluxo normal
    entre dois `<tr>` espaçadores — **preserva `table-fixed`, larguras, fixação sticky e o `<thead>`
    fixo**, sem posicionamento absoluto); cada `<tr>` real leva `data-index` + `ref={measureElement}`
    para **altura dinâmica** (cobre word-wrap, sub-linha, rodapé e o detalhe expandido). `buildRenderItems`
    (`dataGrid.rows.ts`) achata as linhas em itens `row/second/footer/detail` (1 item = 1 `<tr>`). **Fallback
    sem layout (jsdom/testes):** altura do viewport `0` → renderiza tudo (não virtualiza), mantendo os
    testes verdes. `/emails` **não** liga virtualização.
  - **Rodapé de registro sempre-visível (opt-in `renderRowFooter`, usado em `/consulta`)**: prop
    `renderRowFooter?: (row) => ReactNode` — quando retorna nó não-nulo, o grid emite um `<tr>`
    full-width (`colSpan`, slot `footerCell`) **abaixo das células daquele registro**, sempre visível
    (sem clique), distinto do `detail` (clique/seleção) e do `second` (breakpoint). Ordem dos itens:
    `row → second → footer → detail`. `/consulta` usa para exibir a **informação adicional**
    (`additional_info`) só nos registros que a têm — ver "CRUD de contas". Virtualização preservada
    (o footer é um `RenderItem` próprio com `data-index`/`measureElement`; `estimateSize` ~30px).
    - **Auto-recuperação do scrollRect (não regredir):** o `react-virtual` cacheia a altura do viewport
      (`scrollRect`) via `ResizeObserver`; trocas de aba/inatividade (ou um "ResizeObserver loop") fazem
      o navegador **descartar notificações de resize** → o `scrollRect` fica defasado (pequeno), a janela
      virtual encolhe e o grid renderiza só ~4 linhas com o corpo em branco. Duas defesas: (1)
      `useAnimationFrameWithResizeObserver: true` no virtualizer (reduz notificações perdidas por loop);
      (2) um efeito que, ao reganhar `visibilitychange`/`focus`/`pageshow`/`resize`, re-mede o viewport
      real e — **só se divergir** do cache — reinjeta em `rowVirtualizer.scrollRect` + `measure()`
      (guardado contra altura 0). Cobre o caso "aba em background → volta com o grid em branco".
  - **Camadas responsivas** (própria, não do TanStack): (1) breakpoint pela largura **real do
    container** (`useContainerBreakpoint`/`ResizeObserver`) oculta `hideOn` e desce `secondLine`
    para a sub-linha; (2) truncagem (`truncate`) com `title`; (3) rolagem horizontal no viewport.
    **Visibilidade efetiva = (usuário não ocultou via menu) E (breakpoint não escondeu).**
    `getVisibleLeafColumns()` já exclui as ocultas pelo usuário; o filtro de breakpoint vem por cima.
  - **Gestão de colunas (opt-in `enableColumnManagement` + `gridId`)**: `GridToolbar` expõe
    mostrar/ocultar e **fixar** colunas (`ColumnVisibilityMenu`), **densidade** (confortável/compacto),
    **restaurar layout**; **redimensionar** (resize handle) e **reordenar por arraste** (@dnd-kit nos
    cabeçalhos — grip separado do clique de ordenação e da alça de resize). Layout persiste em
    `localStorage` por `gridId` (`useGridPreferences`). Nesse modo a `<table>` vira `table-fixed` com
    larguras de `column.getSize()` (default 160 ou `ColumnDef.size`, respeitando `minSize`) e
    `width = getTotalSize()` — daí o **cabeçalho fixo** (`maxBodyHeight` cria viewport rolável) e a
    **fixação** (sticky + offset via `column.getStart/ getAfter`, com sombra na borda) funcionarem; sem
    gestão, mantém o layout `w-full` antigo. **Defaults por grid (props `defaultPinning`/`defaultDensity`,
    semeados em `useGridPreferences` e no `reset()`; prefs salvas do usuário prevalecem):** `/consulta`
    abre **compacto** (`defaultDensity="compact"` — padding `px-2 py-1` + `text-xs`) e com **Nº Documento,
    Emissão e Fornecedor fixados à esquerda** (`defaultPinning`). `columnResizeMode: 'onChange'`.
  - **`ColumnDef.size`/`minSize` são IGNORADOS sem `enableColumnManagement` (não regredir):**
    `cellStyle()` (`DataGrid.tsx`) só aplica `width: column.getSize()` quando `managed` é `true`
    (`enableColumnManagement` ligado) — sem essa prop, a `<table>` fica `w-full` (não `table-fixed`)
    e o navegador distribui a largura pelo layout automático, **quebrando o texto por padrão**
    quando falta espaço, mesmo com `size` definido no `ColumnDef`. Achado real no `DataGrid` do
    `ExpenseDetailModal` (drill-down de `/dashboard_despesas`, que não liga `enableColumnManagement`):
    a coluna "Situação" (badge curto, sem `wrap`) quebrava em duas linhas apesar de `size: 130` —
    aumentar o `size` não tinha efeito nenhum. Fix correto num grid **não-gerenciável**: `className:
    'whitespace-nowrap'` no `ColumnDef` (o campo já existe e é mesclado no `<td>` via `m.className`,
    `DataGrid.tsx` ~L361/676) — o navegador então dá à coluna a largura que ela precisa, encolhendo
    as colunas com `wrap: true` em vez de quebrar o conteúdo sem wrap. **Cuidado com conflito de
    classe:** se a mesma coluna também tiver `wrap: true` (→ `whitespace-normal`), o `tailwind-merge`
    resolve pela última classe do `cn(...)` — `className` do `ColumnDef` vem depois e vence, mas não
    combine as duas coisas na mesma coluna de propósito (são exclusivas: ou quebra, ou não quebra).
  - **Seleção múltipla (opt-in `enableSelection`)**: coluna de checkbox (`SelectCheckbox`, sempre 1ª e
    fixada à esquerda) + barra de ações com **"Exportar selecionadas"** (`onExportSelected` — em
    `/consulta` reusa o `exportCsv`) e **alteração de situação em lote** (`bulkStatusOptions` +
    `onBulkStatusChange` → select de situação + botão **"Aplicar"**; em `/consulta` chama
    `setFinancialAccountStatusBulk` (PATCH com filtro `id=in.(…)`, uma requisição) + update otimista
    das linhas e `refreshStats()` dos KPIs). A coluna de seleção (`__select__`) é injetada na
    ordem/fixação efetivas mas **nunca** gravada nas preferências (que ficam data-only) — evita
    duplicar o id. `/emails` **não** liga seleção (sem ação em lote de e-mail).
  - **Render das células sem `flexRender`**: o renderer do `cell` é chamado direto (helper
    `cellValue`) para preservar o **valor cru** (string) que o `title` da truncagem exige — `flexRender`
    o envolveria num componente. Não regredir.
  A **sidebar** (`Layout.tsx`) colapsa em drawer com hambúrguer abaixo de `lg`; em `lg+` é estática.
  Dependências do grid: `@tanstack/react-table`, `@tanstack/react-virtual`, `@dnd-kit/core|sortable|modifiers`.

### Build e code-splitting (`frontend-vite`)

- **Rotas lazy** (`App.tsx`): só `LoginPage` entra no bundle inicial; as demais páginas
  (`Emails`/`Consulta`/`Erros`, os CRUDs do grupo Tabelas, `Dashboard`, cobrança, fluxos de
  auth secundários `Forgot`/`Reset`) são `React.lazy` + `Suspense` (fallback "Carregando…";
  um `Suspense` interno mantém o `Layout`/sidebar visível enquanto a página carrega). **Toda
  rota/página nova segue esse padrão** `lazy(() => import(...))`.
- **Recuperação de chunk lazy obsoleto + Error Boundary (não regredir — corrige "tela
  branca"):** um deploy novo no Vercel invalida os hashes dos assets referenciados pelo
  `index.html` já aberto na aba; ao navegar para uma rota lazy ainda não baixada (cenário
  típico: logout por inatividade → login → entrar), o `import()` 404/serve HTML → o React
  lança no render. Como `Suspense` **não captura erro** (só loading), sem rede de segurança
  a árvore inteira sumia (tela branca; só um refresh resolvia). Camadas (`main.tsx`):
  - **`components/ErrorBoundary.tsx`** (boundary raiz, envolve o `App`): erro de **chunk** →
    **auto-reload** uma vez ("Atualizando…", trava anti-loop de 2/sessão em `sessionStorage`);
    erro de **runtime** → fallback com botão **"Recarregar"** (sem mais tela branca).
  - **`lib/chunkReload.ts`**: `isChunkLoadError` (heurística por mensagem), `reloadOnceForChunk`
    (anti-loop), `installPreloadErrorReload` (handler `vite:preloadError` — recarrega antes do
    React tentar renderizar o erro) e `clearChunkReloadCount` (zera o contador no mount do `App`,
    sinal de bundle OK). Testes: `chunkReload.test.ts`, `ErrorBoundary.test.tsx` (+ a11y).
  - **`AuthContext.init()` endurecido**: `try/catch/finally` garante que `loading` **sempre**
    resolva (sem ficar preso em "Carregando…" se o SDK/storage lançar) — vai ao login em vez
    de travar.
- **`manualChunks`** (`vite.config.ts`): `react-vendor` (react/-dom/router) e `supabase`
  (SDK) em chunks próprios — melhora cache e download paralelo e elimina o aviso `>500 kB`
  do Vite. O código de cada rota lazy vira um chunk à parte automaticamente. **No Vite 8
  (Rolldown) o `manualChunks` é uma FUNÇÃO** (o objeto não é mais aceito) — um regex casa os
  pacotes exatos por segmento de `node_modules` (não pega `react-hook-form`/`lucide-react`/
  `@tanstack/react-table`). O `vite.config.ts` também tem `resolve.dedupe: ['react','react-dom']`
  para garantir uma única cópia do React (hoje **defensivo** — `npm ls react` confirma o
  monorepo unificado em react@19.2.7; mantido contra um futuro transitivo react@18).
- **Resolução de `paths` do tsconfig é NATIVA do Vite 8** (`resolve.tsconfigPaths: true`) — o
  plugin `vite-tsconfig-paths` foi **removido** (era redundante e pesava no build, alerta
  `PLUGIN_TIMINGS` do Rolldown; o build caiu ~3.1s→1.3s). Os aliases `@/` e `@shared/` saem do
  `tsconfig.json`. **Não reintroduzir** o plugin.
- **`skipLibCheck: true` é obrigatório** nos 4 `tsconfig.json`: sem ele o `typecheck` quebra
  com erros de tipos de **terceiros** não acionáveis — `@supabase/auth-js` (`webauthn.dom.d.ts`),
  `@tanstack/table-core` (`ColumnMeta`) e os `.next/types/*` gerados pelo Next. Testado na
  auditoria pós-upgrade (2026-06-19); **não remover**.

### Deploy do frontend (Vercel)

Deploy automático pelo GitHub (push em `main` → **production**; `Features`/PR → **preview**).
Topologia (team **`sheild`** = `team_z1BPf9qevCGsfohGRhm52iBn`):

| Projeto Vercel | Papel | Domínio |
|---|---|---|
| `pagamentos-web` | Frontend (Vite SPA) | **pag.otimotex.com.br** (alias de produção) |
| `pagamentos-api-backend` | Next API de dados | `pagamentos-alpha-six.vercel.app` (rewrite `/data-api` em `apps/frontend-vite/vercel.json`) |

**Cache dos assets + `vercel.json` (não regredir):** `apps/frontend-vite/vercel.json` marca
`/assets/(.*)` como `public, max-age=31536000, immutable` — seguro porque TODO arquivo do build
carrega hash de conteúdo no nome (`index-CLNzY0MZ.js`), então um deploy novo gera nomes novos.
O **`/index.html` NÃO casa essa `source`** e segue no default do Vercel (`max-age=0,
must-revalidate`): é ele que aponta para os nomes novos, e cacheá-lo prenderia o usuário na
versão antiga. **Medição antes da mudança:** o HTML já revalidava certo; quem estava fora do
ideal eram os assets, que refaziam um 304 por chunk a cada carga (com muitas rotas lazy, só
latência). **ARMADILHA REAL — o Vercel valida o `vercel.json` ANTES do build:** um erro de
schema não aparece nos logs de build, o deploy vai a `ERROR` e o alias de produção **fica preso
no deploy anterior** (aconteceu: a chave `"//"` usada como comentário derrubou o deploy de
produção — *"headers[1] should NOT have additional property `//`"*). **JSON não tem comentário**:
documente aqui, nunca dentro do arquivo. Guarda em `apps/frontend-vite/tests/vercel-config.test.ts`
(propriedades extras em raiz/headers/rewrites + as regras que não podem regredir).

**O repo NÃO tem `.vercel/project.json`** — para inspecionar deploys (estado/commit), descubra o
team/projeto via Vercel MCP (`list_teams` → `list_projects` → `list_deployments`). O deploy de
produção correto é o `state=READY` + `target=production` cujo `githubCommitSha` casa o merge em
`main`; um `CANCELED` logo após, com `githubCommitRef=Features` e o mesmo SHA, é só o preview
redundante (normal, sem impacto). Flask/IMAP **não** vão para o Vercel — a leitura de e-mails fica
local/agendada (ver flag `EMAIL_READER_ENABLED` acima e memória [[vercel-deploy]]).

## Banco de dados (Supabase)

Migrations em `supabase/migrations/`, aplicadas **manualmente no SQL Editor** (ou via Supabase
MCP/`psql` — ver a nota de cada uma) em ordem numérica (`001` → `131`). **Próxima migration =
`132`** (verificar sempre antes de criar nova).

**A `131` acrescenta `docx_text`/`docx_vision` ao domínio de `extraction_source`** (aplicada via
psql em 2026-08-17; idempotente, reexecução verificada como no-op). Regra e invariantes do .docx em
"`extraction_source` — origem dos dados". Três lições que a aplicação cobrou:
🔴 **A migration abre transação EXPLÍCITA (`BEGIN`/`COMMIT`)** — o `psql` roda em autocommit, e a
primeira tentativa deixou o banco em estado **parcial** (CHECK novo aplicado, coluna gerada ainda
antiga) quando o `DROP VIEW` falhou; além disso, `CREATE TEMP TABLE … ON COMMIT DROP` fora de
transação é destruída no commit implícito do próprio CREATE, e as sondas não achariam o baseline.
🔴 **São DUAS views a dropar e recriar, não uma** — `analytics.vw_payables` (que lê
`extraction_confidence`, coluna GERADA cuja regra só muda com DROP+ADD) **e**
`analytics.vw_aging_vencidos`, que depende da primeira. A consulta que fiz em `pg_depend`
perguntava quem depende da **COLUNA**, e a resposta ("só vw_payables") estava certa para a pergunta
errada. Ao dropar view, pergunte pela VIEW — ou leia o erro do primeiro DROP, que nomeia a
dependente. **Nunca `CASCADE`**: ele derrubaria a dependente em silêncio e o chat ficaria sem as
tools que a leem. Os `GRANT` não sobrevivem ao DROP e são reemitidos.
🔴 **Sonda não usa número mágico** — a P4 compara o conjunto de colunas das duas views com um
baseline capturado ANTES do DROP, nos dois sentidos. A primeira versão escrevia "41 colunas" à mão,
e o número **estava errado** (são 40): número mágico numa guarda testa a memória de quem o digitou,
não o que o banco tinha.

**A `130` desfaz o dano do bug de precedência de `status_for_result`** (backfill de dado, sem DDL;
aplicada via Supabase MCP em 2026-08-17): **13 e-mails** em `ignorado` cujas contas vieram TODAS do
corpo passaram a `recebido` — `recebido` 171 → **184**, e os e-mails com conta em `ignorado` caíram
de 14 para **1**. Regra e caso de origem em "`status_for_result`" acima. Duas decisões que não
devem ser desfeitas: 🔴 **o conjunto é CONGELADO por id numa TEMP TABLE antes do UPDATE** — o
predicado inclui `status = 'ignorado'`, que o próprio UPDATE altera, então reavaliá-lo depois
devolveria zero linhas e as sondas passariam **sem provar nada**; e 🔴 **o sufixo `#N` de múltiplos
pagáveis casa por `starts_with`, NUNCA por `LIKE message_id || '#%'`** — Message-ID contém `_`, que
é **curinga no LIKE**, e um e-mail casaria a conta de outro, mudando o status errado em silêncio
(medido: **62 dos 1.462** Message-IDs têm `_`). As 4 sondas abortam a migration em divergência,
incluindo um **controle negativo** (a população com conta de PDF/imagem tem de ficar intacta) e a
reavaliação do predicado do zero, que a TEMP TABLE congelada não poderia dar. **Deliberadamente
FORA:** o e-mail 1292 (conta criada por reprocessamento manual, `pdf_text` — outra causa) e os 13
e-mails em `extraído` cuja única conta veio do corpo (imprecisos, mas não escondem conta).
Reexecução verificada como **no-op**.

**A `129` registra QUAL MODELO serviu cada turno do chat** (`analytics.ai_chat_log.model TEXT`,
aplicada via psql em 2026-08-15; aditiva, idempotente, nullable, **sem backfill**). O log tinha
latência, os quatro campos de token, `truncated` e `iterations` — tudo menos quem produziu a linha,
e a base **já misturava dois modelos** (Opus 5 até 10/08, Sonnet 5 a partir de 14/08). A única
separação possível era por DATA: inferência que morre assim que alguém troca `ANTHROPIC_MODEL` sem
anotar, que não separa dois modelos ativos no mesmo dia, e que produz resposta confiante e
não-falsificável. Mesma classe da 101 (tokens de cache) e da 102 (`truncated`/`iterations`) — número
que já existia no processo e não era persistido, cuja ausência não gera erro, só análise errada.
- 🔴 **É o modelo SERVIDO (`response.model`), não o pedido.** O pedido é um alias que a API resolve,
  e com `fallbacks` server-side um turno recusado é reexecutado em OUTRO modelo e responde 200 —
  gravar o pedido registraria justamente quem NÃO respondeu.
- 🔴 **A coluna nunca sai vazia: sem nenhuma resposta, cai para `CONFIGURED_MODEL`.** É isso que dá
  a `model IS NULL` um sentido ÚNICO — "linha anterior à 129" — em vez de confundir-se com "não
  sei". Travado por caso próprio em `route.test.ts` porque o TypeScript **não** protege: um
  `?? ''` compila igual e reintroduz a ambiguidade.
- **Sem backfill** por data: reproduziria no banco a mesma inferência que a migration elimina, com o
  agravante de virar dado de aparência autoritativa. Mesma decisão da 102.
- ⚠️ **Verificado pelo caminho REAL de gravação** (PostgREST + `service_role`), não só por SQL: o
  PostgREST mantém cache de schema e poderia rejeitar a coluna nova com `PGRST204` — que
  `logInteraction` engoliria, matando a auditoria em silêncio. Sonda gravou e leu de volta; a linha
  foi removida em seguida (42 linhas, 0 com modelo, estado idêntico ao anterior).

**A `128` torna `analytics.demonstrativo_despesas` DINÂMICA** (aplicada via `psql`/
`SUPABASE_DB_URL` em 2026-08-14 — MCP do Supabase indisponível na sessão; `CREATE OR REPLACE`,
assinatura idêntica). A 127 tinha corrigido o caso do tipo 9 **acrescentando-o ao `CASE`** — o
que garantia que o PRÓXIMO tipo novo (10, 11...) reproduziria o mesmo bug, porque a lista de
linhas continuava decorada em código. A 128 fecha essa classe de bug: duas colunas novas em
`public.financial_type_group` — **`demonstrativo_line_order`** (SMALLINT, nullable — NULL = "este
tipo não vira linha própria", preservando Receitas/Despesas-genérico/Ativo/Custo-genérico/
sentinela 0 em "Não classificado") e **`demonstrativo_line_label`** (override do rótulo; NULL usa
`type_group_description` do próprio catálogo) — com **UNIQUE parcial** (`WHERE ... IS NOT NULL`)
e **CHECK** reservando os sentinelas 900 ("Não classificado") e 999 ("Total de saídas"). A função
passou de um `CASE` hardcoded para dois `LEFT JOIN` (subgrupo vence grupo na precedência, mesma
regra da 104/127) filtrados por `demonstrativo_line_order IS NOT NULL` — um tipo novo cadastrado
no catálogo (só via SQL/`service_role`, sem CRUD) passa a aparecer como linha nova **sem migration
nenhuma**. 🔴 **Decisão de arquitetura deliberada: NADA de "dinamismo cego"** — só um tipo com
`demonstrativo_line_order` preenchido vira linha; sem esse opt-in explícito, qualquer
`type_group_id` presente nos dados (inclusive Receitas/Ativo, por erro de cadastro) vazaria como
linha num relatório que é só de saídas. **8 sondas no `DO $$` (P0-P7)**: seed exato nos 5 tipos
esperados (P0); **oráculo de regressão** — a saída nova bate, linha a linha, com uma réplica
inline do `CASE` antigo da 127, sobre toda a base histórica (P1, zero divergências); soma das
linhas fecha com o total (P2, invariante de origem da 104); **prova de dinamismo** — muda o rótulo
de um tipo JÁ existente (id 6) sem tocar na função, mede a linha nova, restaura explicitamente e
CONFIRMA a restauração antes de prosseguir (P3, no padrão "mutar/medir/restaurar/confirmar" da
Regra 2); UNIQUE e CHECK disparam para duplicata/sentinela, via `BEGIN...EXCEPTION` (savepoint
implícito, P4/P5); grants intactos (P6). 🔴 **P7 — guarda de ESCOPO por `applies_to`** (achado R1
do `/meu-code-review` light de 2026-08-14, corrigido ANTES do primeiro merge — não uma migration
129 à parte): os dois `LEFT JOIN` não validavam se o tipo casado pertencia ao lado GRUPO ou
SUBGRUPO do catálogo — sem `AND sg_tg.applies_to IN ('subgroup','both')` /
`AND g_tg.applies_to IN ('group','both')`, um subgrupo cadastrado por engano com o
`type_group_id` de um tipo GROUP-only (ex.: id 4/Passivo) casaria pelo `LEFT JOIN` do subgrupo
mesmo assim, classificando contas de forma cruzada; a sonda prova a guarda contra o catálogo
(id 4 não casa via subgrupo, id 7 não casa via grupo) — no dado de hoje o oráculo P1 já provava
que a lacuna era NO-OP (nenhum subgrupo real referencia um tipo `group`-only), então o achado era
latente, não um bug ativo. Resultado no mesmo período medido na 127: **idêntico, centavo a
centavo** (196 contas, R$ 5.097.447,64, as mesmas 6 linhas com os mesmos valores) — só o
mecanismo mudou. `apps/api-backend/lib/ai-chat/tools.ts` deixou de prometer uma lista fechada de
linhas ("a lista é dinâmica, pode ganhar categoria nova sem aviso"). **Fix irmão no mesmo commit**
(achado ao mapear consumidores, mesma classe de bug do lado TypeScript): o dashboard
`/dashboard_despesas` (`apps/frontend-vite/src/services/supabase.ts`) também decorava os ids
5/6/7 na partição dos donuts e não reconhecia o tipo 9 — as contas contavam certo no TOTAL
(`isExpenseRow` olha a NATUREZA do grupo, não o tipo do subgrupo) mas não apareciam em nenhum dos
3 donuts de tipo. Ganharam um **4º donut** "Custos de Importação" (`TYPE_GROUP_ID_CUSTO_IMPORTACAO
= 9` em `packages/shared`), na mesma ordem do `line_order` da SQL — escopo **deliberadamente
contido** (paridade com o que a SQL já mostra; não virou N-donuts dinâmico, que seria redesenho
de UI fora do pedido). Testado com o padrão da Regra 2 item 6 (teste de WIRING via clique na
tela, não só a função pura `filterExpenseDetailRows`).

**A `127` ensina `analytics.demonstrativo_despesas` sobre o tipo 9 do catálogo
`financial_type_group`** ("Custos de Importações", aplicada via Supabase MCP em 2026-08-14,
`CREATE OR REPLACE` — assinatura idêntica, sem DROP, grants preservados e verificados). O tipo 9
foi criado direto no banco às 18:03 do mesmo dia (não há CRUD para `financial_type_group`) e a
função, escrita em 31/07, não o reconhecia: contas do grupo "Despesas com Importação e Aquisição"
(natureza Custos) caíam em "Não classificado" e as de natureza Passivo eram contadas como
"Tributos" — achado pelo próprio assistente de IA numa resposta ao usuário, que sinalizou a fatia
de "Não classificado" como incomum. Nova linha "Custos de Importação" com precedência sobre o
teste de natureza=4 (mesma lógica dos tipos 7/5/6). **4 sondas no `DO $$`**, todas por oráculo
diferencial (função × consulta de controle independente): a linha nova bate com
`chart_subgroup_type_id=9 OR chart_group_nature_id=9` (>= 29 contas — o caso de origem); a linha
Tributos recalculada bate com a MESMA exclusão; a soma das 6 linhas fecha com o Total de saídas
(invariante de origem, 104); grants intactos. Medido no período do achado (01–14/08): "Não
classificado" 24→1 conta, "Tributos" 15→9 contas, "Custos de Importação" nasce com 29 contas/
R$ 2.534.248,29, total inalterado (R$ 5.097.447,64). `gasto_por_classificacao` com
`group_by='tipo'` **nunca teve o problema** (lê o catálogo dinamicamente, sem `CASE` fechado) —
só a tool `demonstrativo_despesas` e o texto do `SYSTEM_PROMPT`/descrição da tool (que enumeravam
as linhas) precisaram de ajuste. A decisão registrada aqui ("tornar a função dinâmica ficou como
plano futuro") **foi implementada na migration 128**, no mesmo dia — ver a entrada dela acima.

**A `126` corrige a classificação contábil de 48 contas da usuária `ester@otimotex.com.br`**
(aplicada via Supabase MCP em 2026-08-14, idempotente, sem DDL). Contas gravadas em **72.1.06 —
Estamparia** (chart_account_id 528/cc 10 — 15 contas) ou **21.1.01 — Mercadorias para Revenda**
(chart_account_id 152/cc 19 — 33 contas) passaram para **83.1.01 — Acordos de Terceiros**
(chart_account_id 631/cc 12), par validado contra `financial_chart_of_account.cost_center_id` —
a mesma regra de `checkClassificationPair`. Escopo restrito a `created_by = ester` (WHERE
casando o par ANTIGO, idempotente); contas de outros usuários para os mesmos fornecedores
(792/611, também classificados nesses dois códigos) **não foram tocadas** — verificado antes e
depois (8+13 contas de 792/152 e 2 de 611/528 permanecem intactas). O default de classificação
dos 4 fornecedores envolvidos (`sk_supplier` 611, 792, 883, 1317 — Modart, Hyosung SC, Grife
Têxtil, Singular) foi atualizado para 631/12, por decisão do usuário, para que contas NOVAS
desses fornecedores não voltem a nascer na classificação antiga — decisão deliberada mesmo para
792/611, cujo default também alimentava contas de outros usuários (efeito é só no
pré-preenchimento futuro). `ator_via = 'servico'` na trilha de auditoria (Onda 7) — correção
administrativa via SQL direto, não uma ação executada pela ester (o mesmo princípio do
`OLD.updated_by` não ser fonte de ator: atribuir a um humano uma mudança que ele não fez é
"acusação falsa, pior que ausência de dado").

**A `125` estende o balde parcial a `pontualidade_pagamento` com `group_by='mes'`** (aplicada via
psql em 2026-08-13, idempotente, ensaiada antes em `BEGIN … ROLLBACK`) — invariante e medições em
"Chat de IA". Mesmo `DROP`+`CREATE`/42P13 e mesma reemissão de grants da 124. ⚠️ **A guarda da
Onda 9 obrigou a 125 a RE-PROVAR os invariantes da 123** (oráculo diferencial, anti-vacuidade e a
sonda do piso alto do achado B1): `test_onda9_pontualidade.py` ancora na definição **vigente**, e
foi ela que reprovou a primeira versão da 125 por não trazer as sondas. É o comportamento
desejado — quem reescreve o corpo herda o ônus de provar de novo o que aquele corpo garantia.

**A `124` faz `analytics.gasto_por_periodo` DECLARAR o balde incompleto** (aplicada via psql em
2026-08-13, idempotente, ensaiada antes em `BEGIN … ROLLBACK`). Acrescenta `bucket_end`,
`days_covered`, `days_total` e `is_partial`; o invariante e o porquê estão em "Chat de IA".
🔴 **Exigiu `DROP` + `CREATE`** — coluna nova no `RETURNS TABLE` muda o tipo de retorno e o
PostgreSQL recusa `CREATE OR REPLACE` com **42P13** —, **e o DROP apaga os grants**: a ACL medida
antes (`{postgres=X, authenticated=X}`) é reemitida ao fim do arquivo. É a lição da 116 pela
terceira vez. De carona, fecha o **domínio** de `p_granularity` e `p_date_field`, que caíam em
`ELSE 'month'`/`ELSE due_date` — granularidade inválida virava mês e campo inválido virava
vencimento, **em silêncio**, contrariando o invariante da própria camada. A sonda que mais importa
é o **oráculo diferencial**: os 7 agregados da série de exemplo saíram idênticos aos de antes, o
que é o contrato desta migration — ela acrescenta ressalva, não mexe em número.

**A `123` corrige DOIS achados do code review da Onda 9**
([docs/review/2026-08-13-Features-light-onda9.md](docs/review/2026-08-13-Features-light-onda9.md))
— aplicada via psql em 2026-08-13, idempotente. (1) **B1**, bloqueante:
o ramo do aviso da `pontualidade_pagamento` testava `agrupado` em vez de `confiaveis`, então um
`p_min_contas` alto fazia a tool **afirmar** que não há dado confiável no período — medido, 118
contas reais numa janela de 7 dias com `min_contas=10`. É `CREATE OR REPLACE` (assinatura e
`RETURNS TABLE` idênticos ⇒ **sem DROP e os grants sobrevivem**, o inverso da armadilha da 116).
(2) **R1**: a sonda P4b da 122 comparava o `measured_at` contra um marco anterior aos **dois**
INSERTs, e por isso passava com ou sem a trigger de touch; a sonda corrigida (aqui, porque a 122 é
artefato aplicado) compara o 2º carimbo **contra o 1º**. A migration reprova a si mesma nas duas
frentes e refaz a prova sob o papel `authenticated`, porque o **corpo da função mudou**.
✅ **Verificado em produção no mesmo dia:** os cenários que devolviam a linha de aviso falsa (7 dias
+ `min_contas=10` sobre **118 contas reais**) passaram a devolver **vazio**, o aviso legítimo do
período fora da cobertura continua saindo, e uma reexecução do medidor provou o `touch` da 122 no
mundo real — 7 linhas, 7 gatilhos distintos (não duplicou) e `measured_at` avançando de 14:16 para
17:48. A tool também foi exercitada **pelo PostgREST** pela primeira vez: `42501` com a anon key,
não `PGRST202` — o que prova, de uma vez, que o cache de schema a enxerga e que `anon` está barrado.

**A `122` cria `analytics.roadmap_trigger_snapshot`** — a série histórica dos 7 gatilhos
condicionais da Onda 9 (aplicada via psql em 2026-08-13, idempotente), alimentada pela skill
**`roadmap-gatilhos`**. 🔴 **A UNIQUE `(trigger_key, measured_on)` é a característica central, não
um detalhe**: a gravação é UPSERT por dia, então remedir CORRIGE o ponto em vez de duplicar — sem
ela, qualquer média ou gráfico sobre a série passaria a mentir depois da primeira reexecução, que
acontece o tempo todo (teste manual, retomada após falha). O CHECK fecha o domínio das chaves para
que um typo no script não crie série órfã (a série certa pararia de crescer em silêncio), e
`criterion` guarda a régua aplicada **naquela** medição — sem ela, um `fired = false` de hoje fica
inauditável quando o limiar mudar. Ela também concede a `service_role` o `EXECUTE` de
`payment_date_confiavel_desde()`: sem isso o medidor teria de **fixar a data de corte por conta
própria**, criando a 2ª fonte de verdade que a 121 existe para impedir.
🔴 **`measured_at` usa `clock_timestamp()` e é mantido por TRIGGER, não por DEFAULT** *(achado da
autorrevisão adversarial, reproduzido antes de corrigir)*. `DEFAULT` só vale no INSERT, e o UPSERT
do PostgREST atualiza apenas as colunas **enviadas** — o script não manda o horário de propósito,
para o relógio ser sempre o do banco. Resultado: na 2ª medição do dia, `metrics` mudava e o
carimbo ficava congelado no horário da **primeira**, ou seja, a coluna cuja única função é dizer
*quando se mediu* passava a informar outra hora, em silêncio. E o `clock_timestamp()` não é
estilo: com `now()` (que é o instante em que a **transação** começou) o valor do UPDATE seria
idêntico ao do INSERT, tornando o invariante **improvável por construção** — a sonda não teria como
distinguir "a trigger funcionou" de "a trigger não existe".

**A `121` é a Onda 9 — pontualidade de pagamento** (aplicada via psql em 2026-08-13, idempotente).
Cria `analytics.payment_date_confiavel_desde()` (a data de corte do backfill, **fonte única**) e a
12ª tool `analytics.pontualidade_pagamento(...)`. 🔴 **Ela mede só o que tem carimbo real da
trigger da 096** — as 441 contas do backfill têm `days_late = 0` por construção, e agregá-las junto
devolve "atraso médio zero", que foi o motivo de o item ficar adiado por meses. A tool **exclui e
CONTA** (`fora_da_cobertura`, `excluidas_venc_alterado`): número que esconde a própria cobertura
não é auditável. Invariantes e as duas armadilhas do dado em "O que a Onda 9 entregou".
⚠️ Antes de aplicar, a migration inteira foi **ensaiada dentro de `BEGIN … ROLLBACK`** — as 8
sondas rodaram e nada persistiu; é o jeito barato de testar DDL numa base compartilhada dev+prod.

**A `120` é a Onda 8 (item 8.3) — o gate do chat de IA por grupo** (aplicada via Supabase MCP em
2026-08-12, idempotente). Acrescenta a `public.user_group` três colunas — `ai_chat_enabled`
(`NOT NULL DEFAULT false`, opt-in) e `ai_chat_limit_per_hour`/`_per_day` (NULL = teto do `.env`) —
mais o CHECK `chk_user_group_ai_chat_limits`, e libera na semente os grupos **1 Administrador, 2
Diretor e 7 Financeiro**. 🔴 **Não cria função helper de RLS, e isso é decisão:** RLS responde
"quais linhas este papel lê", o gate responde "este usuário pode chamar o endpoint" — e quem lê é
o `gate.ts` com `service_role`, para quem um `SECURITY DEFINER` baseado em `auth.uid()` seria
**inalcançável** — e `get_advisors` após aplicar mediu **0 achados novos**, confirmando que a
decisão evitou engordar aquela lista (os ERROR/WARN que aparecem são todos pré-existentes e já
triados). 🔴 A semente é `SET ... = true WHERE group_id IN (...)`, **nunca**
`SET ... = (group_id IN (...))`: a segunda forma também é "idempotente" e **revogaria em silêncio**
todo grupo liberado à mão depois. O `DO $$` tem 6 sondas e aborta em qualquer uma; a mais valiosa é
a **P1**, que cruza `analytics.ai_chat_log` com a semente e falha se algum usuário que **já usou** o
chat ficasse sem acesso — pegando uma semente errada na aplicação, não em produção no dia seguinte.
⚠️ A sonda P2 avança a sequence IDENTITY de forma permanente (sequence não é transacional);
inócuo, mas registrado para não ser lido como vazamento.

**A `119` é a Onda 5 (item 5.3)** — conteúdo do CT-e em `fiscal_document` (rota, peso, NF
transportada, destinatário, frete) + `analytics.documentos_fiscais` devolvendo esses campos com
filtro `p_rota`. Aplicada via psql em 2026-08-12, idempotente (**exige os DOIS `DROP FUNCTION`**,
6 e 7 parâmetros — ver os invariantes da Onda 5) e com sonda `DO $$` que grava, consulta pela
tool, testa o filtro de rota nas duas pontas, verifica o CHECK e **aborta** em qualquer
divergência. 🔴 Ela é a migration que **acrescenta valor monetário** a `fiscal_document`, o que
substitui a barreira estrutural da Onda 3 por uma declarada + travada em teste.

**As `117`/`118` são a Onda 7 — a trilha de auditoria** (aplicadas via Supabase MCP em 2026-08-11,
idempotentes). A **117** popula `public.audit_log` por trigger em `financial_account_control` e
`supplier`, e antes disso **fecha o vazamento da própria tabela** (policy `TO public` + `GRANT
SELECT TO anon`, herdados de ela ter sido criada pelo dashboard) e corrige `registro_id` de **uuid**
para **bigint** — a PK da fato é bigint, então não havia onde gravar o id da conta. A **118** entrega
a 10ª e a 11ª tools (`analytics.auditoria_eventos`, `analytics.auditoria_resumo`). Invariantes,
achados e medições em "O que a Onda 7 entregou".

**A `116` faz as duas funções de `analytics` DECLARAREM a truncagem** (aplicada via Supabase MCP em
2026-08-10, idempotente) — correção do achado B1 do code review da Onda 6. `fornecedores_recorrentes`
devolvia **50 de 63** fornecedores com HTTP 200 e nenhum sinal do corte. Acrescenta
`total_encontrado`, fecha o `ORDER BY` na chave do agrupamento (sem ordem total, o recorte do
`LIMIT` varia com o plano) e protege o `LIMIT` contra negativo. 🔴 **Exige `DROP`+`CREATE`** (mudar
o `RETURNS TABLE` é mudar o tipo de retorno) e **reemite os `GRANT`/`REVOKE`**, que o `DROP` apaga.
Traz `DO $$` que **aborta** comparando o total declarado com o real. Detalhe em
[docs/review/2026-08-10-Features-light-onda6.md](docs/review/2026-08-10-Features-light-onda6.md).

> 🔴 **`financeiro@otimotex.com.br` é conta TÉCNICA do backend, não uma pessoa** *(decisão do dono
> do produto, 2026-08-13)*. Ela existe para ser o sentinela de autoria e **nunca terá acesso pelo
> app** — nunca logou (`last_sign_in_at` nulo desde a criação, em 07/08).
> **Está no grupo 7 (Financeiro) desde 2026-08-13, DE PROPÓSITO** — antes estava no 0, e foi movida
> a pedido, para que nenhum usuário fique no grupo sentinela. ⚠️ Isso lhe dá `ai_chat_enabled =
> true`: **risco conhecido e ACEITO**, porque a conta não é usada por ninguém. **Não "corrigir" de
> volta para o grupo 0** ao encontrá-la no Financeiro — não é engano.
> ⚠️ **A LINHA `user_group.group_id = 0` continua existindo e não pode ser removida**, mesmo sem
> nenhum usuário: `handle_new_user` insere `group_id = 0` **hardcoded** e a coluna é `NOT NULL
> DEFAULT 0` com FK. Removê-la faz a criação de QUALQUER usuário novo falhar por violação de chave
> estrangeira. Consequência a lembrar: todo usuário novo **nasce no grupo 0** e depende de um passo
> manual de designação — enquanto estiver lá, não vê nada e o chat responde 403, em silêncio.

**A `110` troca a IDENTIDADE do SENTINELA de autoria** — `teste@otimotex.com.br` →
`financeiro@otimotex.com.br` (aplicada via Supabase MCP em 2026-08-07, idempotente). Ver
"Substituição do sentinela de autoria" abaixo. Reescreve os **4 DEFAULT** (`created_by`,
`updated_by`, `status_changed_by` e `financial_account_attachment.uploaded_by`) e o **fallback
embutido em `resolve_user_for_account()`**. 🔴 **Os quatro DEFAULT e a RPC são independentes:
trocar só um deixa o sistema meio-migrado sem nenhum erro.** A RPC é a mais perigosa — ela
devolve o UUID do sentinela quando o remetente não casa usuário, e o reader grava esse retorno
em `created_by`; com o usuário antigo apagado e a RPC intocada, **todo INSERT de conta de
remetente desconhecido violaria a FK** e o pipeline pararia de gravar, com o sintoma longe da
causa.

> **Substituição do sentinela de autoria (2026-08-07) — o mapa completo.** A identidade aparece
> em **cinco** camadas independentes; migrar uma e esquecer outra não gera erro:
>
> | # | Onde | Como foi tratado |
> |---|---|---|
> | 1 | 3 DEFAULT em `financial_account_control` | migration 110 |
> | 2 | DEFAULT de `financial_account_attachment.uploaded_by` | migration 110 — **é o que quase passou batido**: o inventário inicial contou 3 defaults, não 4 |
> | 3 | fallback de `resolve_user_for_account()` | migration 110 |
> | 4 | `SENTINEL_AUTHOR_ID`/`_EMAIL` no frontend | `src/lib/sentinelAuthor.ts` (extraído de `Consulta.tsx`, que exporta componente e dispararia `react-refresh/only-export-components`) |
> | 5 | os DADOS já gravados | UPDATE à parte, fora da migration |
>
> 🔴 **O guarda que impede a 4 divergir da 1/2/3 é `src/lib/sentinelAuthor.test.ts`** — ele lê a
> **migration mais recente** que define o DEFAULT (não uma constante repetida) e compara com a
> do bundle, mais os 4 DEFAULT entre si e o fallback da RPC. Divergir não quebra nada: a tela
> só deixa de reconhecer o sentinela e passa a exibir "Última edição por: &lt;e-mail&gt;" em
> centenas de contas que ninguém editou — erro de dado plausível e silencioso. Validado por
> mutante (constante de volta ao UUID antigo → 3 vermelhos).
>
> 🔴 **Migração de DADOS de autoria roda com as triggers CONTIDAS e prova por HASH.** Um
> `UPDATE` comum dispara `trg_fe_updated_at`, que grava `updated_at = NOW()`
> **incondicionalmente** — 293 contas apareceriam como editadas naquele dia. O procedimento:
> `ALTER TABLE … DISABLE TRIGGER USER` → UPDATE → `ENABLE` → comparar `md5` do conteúdo (todas
> as colunas **menos** a que se migra), tudo num `DO` block **atômico** que levanta exceção se
> os hashes diferirem (rollback devolve as triggers). Congele o conjunto por **id** quando o
> predicado de destino não reproduzir as mesmas linhas depois do UPDATE. As outras 4 triggers
> foram medidas como no-op para o conjunto (`status_id`, `sk_company`, `payment_date`), mas
> desligar todas remove a dependência de a medição seguir válida no instante da escrita.
>
> ✅ **CONCLUÍDO em 2026-08-07: o `teste@otimotex.com.br` foi APAGADO.** A ordem foi o que
> tornou isso seguro, e ela vale como receita para o próximo caso:
>
> 1. **A dependência não-óbvia era o CI.** O secret `A11Y_TEST_EMAIL` logava com esse usuário
>    a cada PR — correlação medida: login em 2026-08-05 09:13 UTC, 8 min antes do merge do PR
>    #217. Apagar antes de trocar o secret derrubaria o `a11y.yml` em todo PR seguinte.
>    ⚠️ **O `financeiro@` NÃO servia de substituto no CI**: tinha `password_changed = null`, e o
>    1º login cairia em `/auth/change-password` — teria trocado uma quebra por outra. Foi criado
>    o usuário dedicado `teste-a11y@sheild.app.br` (ver o bloco do workflow a11y acima).
> 2. **Exclusão pela Admin API** (`DELETE /auth/v1/admin/users/{id}`), nunca `DELETE` em
>    `auth.users`: é o caminho suportado e o que mantém `auth.identities`/`sessions`
>    consistentes — mesma razão da regra de troca de e-mail. Verificado depois: 0 identities e
>    0 sessions órfãs; a linha em `user_profile` sumiu sozinha (`ON DELETE CASCADE`).
> 3. 🔴 **A prova que vale é FUNCIONAL, não a contagem de referências.** Zerar os `count(*)`
>    não demonstra que o pipeline continua gravando. O teste decisivo foi abrir transação,
>    inserir uma conta com `created_by = resolve_user_for_account('<remetente desconhecido>')`
>    — exatamente o caminho que cai no sentinela e que violaria a FK se a RPC ainda apontasse
>    para o usuário apagado — e desfazer com `ROLLBACK`. **Repita esse ensaio** antes de dar
>    por concluída qualquer remoção de usuário referenciado por DEFAULT ou por função.

**A `109` impede o E-MAIL de SEQUESTRAR o fornecedor** (aplicada via Supabase MCP em 2026-08-03,
idempotente) — ver "E-mail de PLATAFORMA não identifica fornecedor" em "Auto-resolução de
fornecedor". Cria `_is_platform_email`, faz o Passo 4 (e-mail) ser pulado quando há CNPJ/CPF
extraído que não casou, bloqueia o e-mail de plataforma no auto-insert e em `_add_supplier_email`,
e limpa os 4 cadastros que já o haviam capturado.

**As `107`/`108` são a Onda 3** (aplicadas via psql em 2026-08-01, idempotentes). A **107** cria
`public.fiscal_document` — o documento fiscal eletrônico pela chave de acesso de 44 dígitos, tabela
de proveniência **append-only** (sem valor monetário: documento fiscal NUNCA soma em relatório
financeiro), com RLS reusando o recorte por REMETENTE da 078 e `REVOKE` de escrita do papel
`authenticated`. A **108** entrega a **9ª tool** `analytics.documentos_fiscais`, `SECURITY INVOKER`
+ `GRANT`/`REVOKE` explícitos, devolvendo `total_encontrado` (`count(*) OVER ()`) para o modelo não
contar linhas truncadas. Ver "O que a Onda 3 entregou".

**As `103`–`106` são as Ondas 1 e 2** (colunas da `vw_payables` + `demonstrativo_despesas`;
`body_full`/`body_search` + `buscar_emails`) — ver o roadmap de enriquecimento.

**A `102` acrescenta `truncated`/`iterations` a `analytics.ai_chat_log`** (aplicada via psql em
2026-07-30, idempotente, aditiva e sem backfill). Achado da **primeira execução real** (§20.9): uma
interação registrou 6 chamadas à mesma tool — e o teto do loop é 6 —, ou seja, pode ter devolvido
resposta incompleta **sem que o log dissesse**. `truncated` já existia no `ChatResult` e não era
persistido; o nº de iterações não existia. Isso cega justamente a análise que o §11 apoia no log
("quais tools faltam"): a pergunta que estoura o teto é a mais cara E a mais informativa. Consulta
que a coluna habilita: `SELECT question, iterations FROM analytics.ai_chat_log WHERE truncated`.
Sem GRANT novo — coluna de tabela existente herda o privilégio de tabela concedido pela 101.
**Cadeia verificada EM PRODUÇÃO** (interação de 30/07 13:44): `truncated = false`, `iterations = 2`,
`error` nulo — as colunas são escritas por código real, não só por teste com mock. A verificação
importava porque `logInteraction` **nunca lança**: um erro no caminho de gravação apareceria apenas
como coluna eternamente `NULL`, sem erro e sem teste vermelho.

**A `101` conserta o GRANT que faltava ao `service_role` em `analytics.ai_chat_log` e acrescenta
as colunas de token de cache** (aplicada via Supabase MCP em 2026-07-29, idempotente). O GRANT é
correção de **bug**: a 098 concedeu tudo a `authenticated` e nada ao `service_role`, que é quem
grava a trilha do chat — e como `logInteraction` **nunca lança**, a auditoria ficaria morta em
produção sem sintoma. Concede `USAGE` no schema + `SELECT, INSERT` **só no log**; **nada** nas 6
funções nem nas views (o caminho de dados precisa do JWT do usuário para a RLS decidir). As colunas
`cache_read_input_tokens`/`cache_creation_input_tokens` existem porque `usage.input_tokens` é
**apenas o resto não-cacheado** — sem elas não há como estimar custo nem notar um invalidador
silencioso do cache. Ver "Chat de IA" e §19 do doc de arquitetura.

**A `100` restaura o DML do `service_role` no DEFAULT de tabelas novas** (aplicada via Supabase MCP
em 2026-07-29, idempotente), sem devolver nada a `anon`/`authenticated`. É a correção do efeito
colateral de desligar o toggle "Automatically expose new tables" — ver o bloco da `097` abaixo.
**Estado final verificado com uma tabela-sonda real** (CREATE TABLE + `has_table_privilege` +
ROLLBACK): tabela nova nasce com `service_role` = SELECT/INSERT/UPDATE/DELETE e **`anon` e
`authenticated` sem nada, nem SELECT** — melhor que o estado anterior ao toggle, em que os dois
nasciam com SELECT. Cobre os schemas `public` e `analytics`.

**A `099` fecha DUAS RPCs que CONTORNAVAM a RLS, executáveis por `anon` (sem login)** — aplicada
via Supabase MCP em 2026-07-29, idempotente. Achadas pelos advisors do Supabase durante a Fase 1 do
chat de IA. A RLS **não** estava falhando (acesso direto às tabelas como `anon` já devolvia 0
linhas); o problema eram dois `SECURITY DEFINER` de owner `postgres` e uma view
`security_invoker = false` — três caminhos que **passam por fora** dela:

- **`fn_delete_all_emails()`** (`RETURNS text`, logo chamável em `/rest/v1/rpc/`) fazia `DELETE` em
  `financial_account_control` + `email_control` + `email_processing_errors` e reiniciava as
  sequences: **qualquer um na internet apagava a base inteira com um POST**, porque a anon key é
  pública por design (vai no bundle do browser). A função foi **PRESERVADA (só `REVOKE`)** — é a
  ferramenta de "Limpeza / reset de dados" usada pelo SQL Editor, que roda como `postgres`.
- **`search_text(p_table, p_column, p_termo)`** — `EXECUTE format('SELECT * FROM %I ...')`. O `%I`
  barra SQL injection, e é por isso que ela "parecia" segura; o problema é rodar como `postgres` e
  **ignorar a RLS**, devolvendo 50 linhas de QUALQUER tabela escolhida pelo cliente. **Exploração
  confirmada como `anon`:** 50 contas com `amount`/`created_by` e 50 fornecedores — toda a
  visibilidade por dono (076/078/080/081) contornada por uma função. Pós-fix, o mesmo POST HTTP com
  a anon key devolve `42501 permission denied`.
- **View `app_user`** — `REVOKE SELECT FROM anon` (lia os 12 e-mails de todos os usuários **sem
  login** — lista pronta para phishing dirigido). **`authenticated` MANTÉM o SELECT**: sem ele o
  "Criado por" desaparece do painel de detalhe de `/consulta`. A **081** já fechara a ESCRITA nessa
  view (escalada de privilégio via view auto-atualizável); a LEITURA por `anon` passou batido.
- `DROP TABLE public.supplier_tmp` (staging residual de 464 linhas; 0 FKs, 0 views dependentes).

> **NÃO REGREDIR — `auth_group_sees_only_own()` NÃO pode ter o EXECUTE revogado**, embora os
> advisors a apontem: ela é chamada DENTRO das policies 076/078, avaliadas com o papel
> `authenticated`; sem EXECUTE, todo SELECT de contas levaria `42501` e a RLS inteira quebraria. É
> exatamente a regressão que a **074** teve de consertar após a 072. As 6 funções `RETURNS trigger`
> (`handle_new_user`, `fn_set_payment_date`, …) que os advisors listam são **ruído**: o PostgreSQL
> recusa chamada direta a função de trigger.
>
> **Lição que generaliza (a 3ª repetição do mesmo padrão — 072, 081, 099):** neste projeto o
> perímetro do PostgREST **não é só a policy**. Toda função `SECURITY DEFINER` e toda view
> `security_invoker = false` é um furo em potencial na RLS, e o default do PostgreSQL/Supabase é
> **permissivo** (`EXECUTE` a `PUBLIC` em função nova; escrita a `authenticated` em objeto novo).
> Ao criar qualquer um dos dois, o `REVOKE` explícito faz parte da migration — e rodar
> `get_advisors` depois de DDL é barato.

**A `098` cria o schema `analytics`** — a camada semântica read-only do chat de IA (Fase 1;
aplicada via Supabase MCP em 2026-07-29, idempotente). Views `vw_payables`/`vw_aging_vencidos`
(`security_invoker = true`), as 6 funções de tool calling (`SECURITY INVOKER` + `STABLE`),
`ai_chat_log` com RLS e os GRANT/REVOKE. **É o único schema fora do `public`** neste banco, e o
único cujo `ALTER DEFAULT PRIVILEGES` já nasce corrigido. Detalhes, invariantes e o passo de
dashboard pendente (expor `analytics` no PostgREST): ver "Chat de IA" acima.

**A `097` faz a HIGIENE dos grants default de escrita** de `anon`/`authenticated` no schema
`public` **e corrige a causa raiz** (aplicada via Supabase MCP em 2026-07-28). Três passos:
(1) `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN` de **`anon`** em
todas as tabelas — ele mantém só `SELECT`; (2) `REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN`
de **`authenticated`** — **sem `UPDATE` na lista**; (3) `ALTER DEFAULT PRIVILEGES FOR ROLE
postgres IN SCHEMA public` revogando a escrita dos dois papéis, para tabela nova **nascer sem
escrita**.

> ⚠️ **A assimetria entre o passo 2 e o passo 3 é LOAD-BEARING — não "unificar" (não regredir):**
> nos objetos **existentes**, `authenticated` não tem `UPDATE` de tabela e sim **GRANTs POR
> COLUNA** (030/033/068: `has_invoice`/`has_bank_slip`/`status_id` + `reviewed_at`). Como um
> `REVOKE UPDATE ON <tabela>` derruba **também** os privilégios por coluna do mesmo tipo, incluir
> `UPDATE` no passo 2 quebraria a curadoria inline de `/consulta` e o "revisado" de `/emails` —
> foi por isso que a 081 revogou só `INSERT, DELETE` ali. Já no passo 3 revogar `UPDATE` é seguro
> **porque default privileges valem apenas para objetos criados DEPOIS**, sem tocar em grant por
> coluna existente.
>
> **O que a 097 deliberadamente NÃO faz:** não revoga `SELECT` de `anon` (hoje inócuo — nenhuma
> policy o contempla, então ele lê 0 linhas; revogar trocaria "conjunto vazio" por "permission
> denied", diferença observável sem ganho real); não mexe em SEQUENCES/FUNCTIONS; e **não altera
> os default privileges do papel `supabase_admin`** (exigiria superuser). Como as tabelas deste
> projeto são criadas por `postgres`, o passo 3 cobre o caso real — mas objeto criado por
> `supabase_admin` ainda precisaria de `REVOKE` explícito.
>
> **MEDIDO em 2026-07-29 (a lacuna do `supabase_admin` é REAL, não teórica):** consultando
> `pg_default_acl`, o ACL default de TABELAS no schema `public` é
> `anon=r` / `authenticated=r` quando o criador é **`postgres`** (só leitura — o efeito da 097),
> mas **`anon=arwdDxtm` / `authenticated=arwdDxtm`** quando o criador é **`supabase_admin`** —
> isto é, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER e MAINTAIN. Na prática: **toda
> tabela criada pelo Table Editor do dashboard nasce gravável por `anon`**, e a 097 não a alcança.
>
> **O toggle "Automatically expose new tables" foi DESLIGADO em 2026-07-29 — e NÃO fechou essa
> lacuna (não regredir a conclusão errada):** medido depois de desligar, o default do
> **`supabase_admin` permaneceu `anon=arwdDxtm` / `authenticated=arwdDxtm`**. O toggle só mexeu no
> default do papel **`postgres`**. Como `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin` exige
> superuser (o papel do MCP/psql é `postgres`, que **não é superuser nem membro de
> `supabase_admin`**), **não há correção por SQL**. → A mitigação é de **PROCESSO: criar tabela
> sempre por migration, nunca pelo Table Editor do dashboard.** Tabela criada pela UI nasce
> gravável e truncável por `anon` e precisa de REVOKE explícito no mesmo dia.
>
> **Efeito colateral do toggle, corrigido pela `100`:** desligá-lo também removeu o DML do
> **`service_role`** (o default do `postgres` virou `service_role=Dxtm` — sem INSERT/SELECT/UPDATE/
> DELETE), e é com esse papel que o pipeline Python e a Next API escrevem. Não quebrou nada na hora
> (default privileges só valem para objeto NOVO; as 19 tabelas existentes seguiram intactas), mas
> a próxima migration que criasse tabela geraria um `permission denied` no pipeline, longe da causa.
> Ver a **migration 100**.
>
> **Estado verificado após aplicar:** 0 privilégios de escrita de tabela sobrando para
> `anon`/`authenticated`; os **4** grants por coluna da curadoria **intactos**
> (`has_column_privilege` = `true` nos três de `/consulta` e no `reviewed_at`); `SELECT`
> preservado nas 21 relações; `service_role` inalterado; e o default ACL do `public` reduzido a
> `anon=r, authenticated=r`. Requer **PostgreSQL 17+** (privilégio `MAINTAIN`).

**A `096` cria `financial_account_control.payment_date`** — a **data em que a conta foi paga**,
que até então não existia no banco (coluna `DATE` nullable + índice parcial `ix_fac_payment_date`
+ backfill + trigger `trg_fac_payment_date`; aplicada via Supabase MCP em 2026-07-28).
`status_changed_at` **não serve de proxy**: o valor mínimo dele em toda a tabela é `2026-07-10` —
a data em que a própria 077 criou a coluna —, inclusive para contas vencidas em abril. A trigger
(BEFORE INSERT OR UPDATE, `fn_set_payment_date`) **preenche** com a data corrente
(`America/Sao_Paulo`, mesmo fuso da 095) quando `status_id` passa a **8** e `payment_date` está
NULL — respeitando data retroativa informada no MESMO comando — e **limpa** quando a conta deixa
de estar paga (`8 → outro`), para que uma baixa corrigida não deixe data órfã. O backfill
(`payment_date := due_date` nas contas já pagas) roda **antes de a trigger existir** e é
idempotente (`WHERE payment_date IS NULL`), então não há conflito entre ele e o carimbo
automático. `payment_date` **não** entra no grant de coluna de `authenticated` (que segue com
`has_invoice`/`has_bank_slip`/`status_id`) — quem a preenche é a trigger, não o cliente;
verificado que isso **não** impede a curadoria inline de `/consulta` (privilégio de coluna é
checado contra a lista `SET` do comando, não contra o que um trigger BEFORE altera).

> **`payment_date` é a DATA DE PAGAMENTO da conta — decisão do dono do produto (2026-07-28): usar
> como tal, sem ressalva, em dashboard e na camada analítica.** Auditoria estrutural da coluna
> (feita na Fase 0 do chat de IA), para quem precisar conferir número ou mexer no caminho de escrita:
>
> - **Quem escreve: só a trigger `trg_fac_payment_date`.** `payment_date` **não** está no grant de
>   coluna de `authenticated` (que segue exatamente com `has_invoice`/`has_bank_slip`/`status_id` —
>   conferido em `information_schema.column_privileges`) **e** está omitida do
>   `financialAccountControlInputSchema` de `@sheild/shared`, então o Zod a descarta (strip) no
>   POST/PATCH da Next API. Nenhum caminho do app a envia; o pipeline Python tampouco. Gravar data
>   explícita hoje exige SQL direto com `service_role` — o ramo "data informada no mesmo comando" da
>   096 existe, mas é **inalcançável pela aplicação**.
> - **A ordem das triggers BEFORE foi verificada no catálogo** (o Postgres dispara em ordem
>   alfabética): `trg_fac_authorship` → **`trg_fac_payment_date`** → `trg_fe_sk_company` →
>   `trg_fe_status_vencimento` → `trg_fe_updated_at`. A única que reescreve `status_id` é
>   `fn_set_status_from_due_date`, e **só** quando a conta está em aberto (`{1,2,3}`) — ela nunca
>   produz nem destrói o `8`. Por isso o resultado é **independente da ordem**: o preenchimento testa
>   `NEW.status_id = 8` e a limpeza testa a transição a partir de `OLD.status_id = 8`, e nenhuma das
>   duas condições é alterada pelas triggers vizinhas.
> - **Invariante conferida no dado:** `payment_date IS NULL` ⇔ `status_id <> 8`, com **0 linhas
>   fora**. Nenhuma data de pagamento no futuro; nenhuma conta paga com vencimento futuro.
> - **O único limite real, e ele é do HISTÓRICO, não da coluna:** as **443** contas pagas existentes
>   em 2026-07-28 têm `payment_date = due_date` **sem exceção** — vieram do backfill da 096, que
>   adotou o vencimento. Daí para frente, um carimbo da trigger só se distingue do backfill quando
>   `payment_date <> due_date`; pagamento feito **no** vencimento gera valores idênticos, então **não
>   há discriminador perfeito** entre backfill e carimbo — a coluna de origem foi deliberadamente
>   **não** criada. Na prática: série por `payment_date` até 2026-07-28 segue a curva de
>   **vencimento**; a partir daí é a data em que a baixa foi registrada.

**A `095` corrige um BUG DE FUNDAÇÃO da trigger `fn_set_status_from_due_date`** (idempotente,
`CREATE OR REPLACE FUNCTION`; aplicada via Supabase MCP em 2026-07-23) — ver "Trigger de situação
por vencimento usa a data de HOJE, não `extracted_at`" na seção "Pipeline de baixa automática"
abaixo para o relato completo do bug e da correção.

A **094** adiciona `financial_type_group.applies_to` (`'group'`/`'subgroup'`/`'both'` + CHECK) — o
discriminador de ESCOPO que separa as duas taxonomias do catálogo (Natureza do grupo × Tipo Fixa/
Variável do subgrupo) e escopa os lookups + a validação; ver "Escopo do `financial_type_group`".
Idempotente (`ADD COLUMN IF NOT EXISTS` + UPDATE guardado); aplicada via Supabase MCP em 2026-07-20
(Supabase compartilhada dev+prod → sem passo extra). As **091/092/093** são higiene/classificação de
dados dos cadastros contábeis: **091** corrige `financial_chart_of_account_group` (`group_type` NULL→'D'
nos códigos 26/63, sentinela id 0 `' '`→NULL, hard delete dos grupos órfãos 15/44); **092** classifica
`financial_chart_of_account_subgroup.type_group_id` em Fixa/Variável herdando o grupo em bloco; **093**
refina essa classificação POR SUBGRUPO (119 Fixa / 28 Variável / 8 não-despesa). Todas idempotentes,
aplicadas via Supabase MCP em 2026-07-20. A **087** estende o CHECK de `financial_account_control.document_type` com **`comprovante`**
(comprovante/recibo como DOCUMENTO da conta — ver "Normalização de `document_type`"); idempotente
(DROP+recria), **sem backfill**. Mesmo padrão da 086: o array espelha 1:1 o enum `DOCUMENT_TYPES`
(NÃO inclui `pix`, removido pela 075). **Aplicada via psql em 2026-07-18** (verificado: `comprovante`
aceito, `pix` ausente); Supabase compartilhada dev+prod → **sem passo de banco em produção**.
A **086** estende o CHECK de `financial_account_control.document_type` com **`cheque`** (o cheque
como DOCUMENTO da conta — ver "Normalização de `document_type`"); idempotente (DROP+recria), **sem
backfill**. **Não regredir:** o array do CHECK espelha 1:1 o enum `DOCUMENT_TYPES` e **NÃO inclui
`pix`** (removido pela 075) — copiar do enum, nunca de uma versão pré-075. **Aplicada via psql em
2026-07-17** (verificado: `cheque` aceito, `pix` rejeitado); a Supabase é compartilhada dev+prod,
então já vale para os dois — **sem passo de banco em produção**.
A **085** é o **backfill da 3ª empresa** (OTIMOTEX FARDOS): as contas cujo remetente/dono é a
ester (`ester@otimotex.com.br`) passam a `sk_company=3` — **37 linhas**. **Sem DDL** (a linha 3 já
existia em `company`) e idempotente; gruda porque o trigger da 084 não re-resolve no UPDATE. Ver
"Empresa pagadora (`sk_company`) — regra por PRECEDÊNCIA". Aplicada via psql em 2026-07-17.
Não há migration automática. A **084** implanta a **regra LEBIANCO** da empresa pagadora (ver
"Empresa pagadora (`sk_company`) — regra LEBIANCO"): (1) o trigger `trg_fe_resolve_company()`
passa a **respeitar `sk_company` explícito** (`IF NEW.sk_company IS NULL THEN resolve…`) — sem
isso o valor gravado pelo Python era descartado **e qualquer UPDATE re-resolvia a empresa**; e
(2) **backfill** das contas já extraídas (55 de 436 → `sk_company=2`). Aplicada via psql em
2026-07-17; **idempotente** (re-run = 0 linhas). A **083** introduz a **surrogate key snowflake `sk_company`**:
`sk_company` (BIGINT `GENERATED ALWAYS AS IDENTITY`) vira a **PK** de `company` e a **chave única
de relacionamento** do app; `company_id` passa a **campo de origem** (NOT NULL UNIQUE, do sistema
maior). `financial_account_control.company_id` é **substituída** por `sk_company` (backfill via
JOIN + FK `fk_fac_company` + índice `idx_fac_sk_company`; a coluna `company_id` é DROPADA). O
trigger de resolução (`trg_fe_resolve_company()`, SECURITY DEFINER — lição da 074) passa a gravar
`NEW.sk_company` via a nova função **`resolve_company_sk(payer_cnpj, payer_name)`** (REVOKE EXECUTE
de anon/authenticated + GRANT service_role, mirror 072; fallback = sk da empresa `company_id=1`); a
antiga `resolve_company_id` é DROPADA e o trigger foi renomeado `trg_fe_company_id`→
`trg_fe_sk_company`. Espelha a 042 (supplier). **One-time — não re-executável** (troca de PK/
IDENTITY, como 042/050/051). **Aplicada via psql em 2026-07-17** (`SUPABASE_DB_URL` +
`:5432/postgres`); a coluna `sk_company` criada pelo usuário tinha `DEFAULT 0` (sentinela) — a
migration o **dropa antes** do `ADD GENERATED ALWAYS AS IDENTITY` (não coexistem). As guardas de
string em `resolve_company_sk` usam `length(trim(x)) > 0` (não `trim(x) <> ''`) para evitar um
**falso positivo do SonarCloud** (analisador PL/SQL com semântica Oracle, onde `'' = NULL`);
comportamento idêntico em PostgreSQL. **NÃO reaplicar.** A **082** adiciona as colunas de CONTATO em `supplier`
(telefone/WhatsApp/chave PIX, 2 slots cada — ver "Contato do fornecedor"); aplicada **via psql**
(`SUPABASE_DB_URL` + `:5432/postgres`, com o Supabase MCP indisponível na sessão), idempotente
(`ADD COLUMN IF NOT EXISTS` + REVOKE de escrita do papel `authenticated`). (As `059`/`060`/`061`/`063`/`064`/`066`/`067`/
`068`/`069`/`070`/`071`/**`072`**/**`073`**/**`074`**/**`075`**/**`076`**/**`077`**/**`078`**/**`079`**/**`080`**/**`081`** foram aplicadas **direto via Supabase MCP** nesta
máquina — o arquivo numerado serve
de histórico; **não reaplicar** no SQL Editor (todas idempotentes, mas evite re-run). A **081**
(**fecha a ESCRITA por `authenticated` no caminho REST direto** — ver "Escrita direta por
`authenticated`" e "ESCALADA DE PRIVILÉGIO pela view `app_user`"): (a) **CRÍTICO** — `REVOKE
INSERT/UPDATE/DELETE` na view `app_user`, que era auto-atualizável e rodava como owner: qualquer
usuário logado alterava `auth.users` (trocar o e-mail do Administrador → tomar a conta pelo "esqueci
minha senha"); (b) as policies de UPDATE de `financial_account_control` e `email_control` eram
`USING (true)` → passam a usar o MESMO predicado do SELECT (076/078), preservando a curadoria por
clique (ester: 36 próprias × 0 alheias; barbara: 412); (c) `REVOKE` dos grants default residuais em
6 tabelas + `INSERT, DELETE` (nunca `UPDATE` — quebraria os grants por coluna) nas duas da
curadoria. A **080**
(**a leitura do BUCKET herda a visibilidade da conta** — ver "Visibilidade do Storage por dono"):
a policy da 021 era `USING (bucket_id='attachments')` **sem filtro de dono** — o grupo restrito via
36 contas pela tela mas alcançava os **565 objetos** do bucket pela API do Storage (a chave é
obtível: `GET /api/contas/:id` devolve `source_file` e `/attachments` o `storage_key`, ambos via
service_role). Agora o objeto só é liberado se existir uma linha **visível para o próprio usuário**
(`EXISTS` em `financial_account_attachment.storage_key` OU `financial_account_control.source_file`)
— as subconsultas rodam como `authenticated`, então a RLS da 076/079 se aplica dentro delas e a
policy **herda a regra sozinha**. Verificado: Comercial 565→**20** objetos (0 alheios), Financeiro
565→**233** (não perdeu nenhum). + índice `ix_fac_source_file`. A **079**
(**anexos MÚLTIPLOS por conta** — ver "Anexos de conta"): cria
`financial_account_attachment` (1:N → `financial_account_control`, `origin` manual/pipeline, soft
delete `deleted_at`/`deleted_by`, UNIQUE `(account_id, storage_key)`), RLS SELECT que **herda a
visibilidade da conta pai** via `EXISTS` (sem duplicar o predicado da 076 — verificado com o papel
`authenticated` real: Comercial vê 36 contas/26 anexos, Financeiro vê tudo) + **`REVOKE INSERT,
UPDATE, DELETE` do papel `authenticated`** (o Supabase concede esses grants por DEFAULT em toda
tabela nova; a RLS já bloqueava, mas o REVOKE é a mesma defesa em profundidade das 056/057 —
sem ele a tabela ficaria assimétrica com `supplier`/`status`) + backfill dos `source_file` existentes
como `origin='pipeline'` (na aplicação: 249 linhas / 228 objetos — há menos objetos que contas porque
um PDF com N boletos gera N contas). `source_file` **permanece** na conta (dedup/auditoria do
pipeline). A **078**
(**Etapa 1 estendida a `/emails` e `/erros`** — ver "Visibilidade de contas por dono"): reescreve as
policies SELECT de `email_control` e `email_processing_errors` (papel `authenticated`) para
`NOT public.auth_group_sees_only_own() OR lower(sender_email) = lower(auth.email())` — reusa o helper
e a flag `user_group.sees_only_own_accounts` da 076, mas casando o **remetente do e-mail** com o e-mail
do usuário logado (não o `created_by`/UUID). Grupo restrito (Comercial=6) vê só os e-mails/erros de que
é remetente; demais grupos veem tudo (preservado); `service_role` mantém bypass. A **077**
(**Etapa 2 — auditoria de autor** — ver "Visibilidade de contas por dono"): adiciona
`updated_by`/`status_changed_by`/`status_changed_at` (NOT NULL DEFAULT sentinela + FK) + backfill; a
trigger `trg_fac_authorship` (`fn_stamp_account_authorship`, SECURITY DEFINER — roda ANTES dos
`trg_fe_*` para ver o `status_id` do humano, não o recálculo) carimba o editor via
`coalesce(auth.uid(), explícito)`; e a view `public.app_user (id,email)` (grant `authenticated`) para
exibir o autor. A **076**
(**Etapa 1 — visibilidade de contas por DONO, por grupo** — ver "Visibilidade de contas por dono"):
adiciona `financial_account_control.created_by` (UUID → `auth.users`, NOT NULL DEFAULT sentinela
— `teste@otimotex.com.br` à época; **hoje `financeiro@otimotex.com.br`, ver migration 110** —,
FK `ON DELETE SET DEFAULT`) + backfill via `sender_email`; flag
`user_group.sees_only_own_accounts` (Comercial=6 → true); RPC `resolve_user_for_account(p_email)`
(service_role); helper `auth_group_sees_only_own()`; e troca a policy SELECT de
`financial_account_control` para `NOT auth_group_sees_only_own() OR created_by = auth.uid()`
(grupo sem flag vê tudo; Comercial vê só as próprias; service_role/admin com bypass). A **075**
remove **`pix`** do CHECK de `financial_account_control.document_type` (pix é só forma de pagamento)
+ backfill dos 39 registros `pix`→`outro` — ver "Normalização de `document_type`". A **074**
(correção de REGRESSÃO da 072 — não regredir): a 072 revogou `EXECUTE` de `resolve_company_id` de
`authenticated`, mas o trigger `BEFORE INSERT/UPDATE trg_fe_company_id` → `trg_fe_resolve_company()`
era **SECURITY INVOKER**, então passou a rodar como `authenticated` (sem EXECUTE) e **quebrou TODO
UPDATE do frontend** em `financial_account_control` — marcar NF/BOL e trocar situação em `/consulta`
davam `403 permission denied for function resolve_company_id`. Fix: a função do trigger vira
**`SECURITY DEFINER`** (owner `postgres`, que mantém EXECUTE) + `search_path` fixo + chamada
qualificada `public.resolve_company_id`. Comportamento inalterado (o `company_id` já era resolvido em
todo write); o vetor S2-1 segue FECHADO (RPC direta por `anon`/`authenticated` continua `42501`).
Verificado no banco: `prosecdef=true`, UPDATE de curadoria como `authenticated` não levanta 42501, e
`anon`→42501 na RPC. **Lição:** ao revogar EXECUTE de uma função chamada por TRIGGER, garantir que a
função do trigger seja SECURITY DEFINER (owner com EXECUTE) — senão todo write pelo papel restrito
quebra. A **073**
(higiene da auditoria de segurança 2026-07-08, idempotente): (1) **A5-2** — seed do grupo 1
"Administrador" em `user_group` (a 065 faz `UPDATE user_profile SET group_id=1`, mas a 063 só semeava
o sentinela 0 — em aplicação LIMPA a FK abortaria); (2) **S2-2** — policy **RESTRICTIVE**
`attachments_no_delete_authenticated` em `storage.objects`, bloqueio EXPLÍCITO de DELETE por
`authenticated` no bucket `attachments` (antes só o default-deny da RLS protegia; `service_role`
ignora RLS). A **072** (segurança **S2-1**, BLOQUEADOR de go-live — não regredir): `REVOKE EXECUTE`
de PUBLIC/anon/authenticated nas 6 RPCs `SECURITY DEFINER` de fornecedor (`resolve_supplier_id`,
`resolve_supplier_for_account`, `resolve_company_id`, `_enrich_supplier`, `_enrich_supplier_name`,
`_add_supplier_email`) + `GRANT` a `service_role` — fecha o vetor de escrita em `supplier` via
`/rest/v1/rpc` com a anon key (`SECURITY DEFINER` ignora RLS); verificado por `anon`→`42501`. A **071** adiciona
**`débito automático`** ao CHECK de `financial_account_control.payment_method` (débito direto em conta,
distinto do `débito` cartão) + re-mapeia as contas Sabesp de água (171/189/190) `débito`→`débito
automático` — ver "Forma de pagamento DECLARADA no corpo". A **070** cria a
trigger `trg_supplier_no_funcionario_classification` (fornecedor de FUNCIONÁRIO não carrega
classificação default — força `supplier.cost_center_id`/`chart_account_id`=0; ver "Classificação
default do fornecedor") + backfill. As **067/068/069**
são a migração faseada de **`status_id` como fonte única** da situação (remoção do `status` texto —
ver a nota da migração faseada em "Banco de dados"): **067** `status_id` NOT NULL DEFAULT 3; **068**
trigger id-primária + `GRANT UPDATE(status_id) TO authenticated`; **069** trigger só-id + DROP do CHECK
e da coluna `status`. A `066` amplia o CHECK de
`financial_account_control.document_type` com **`cartório`** (pagamento de/em cartório) + backfill dos
genéricos com contexto de cartório no assunto (id 400) — ver "Normalização de `document_type`"; ocupou
o nº que o roadmap de RBAC estimava (066–068), que desloca para 067+ quando for implementado. A `065`
cria **`public.user_profile`** (vínculo usuário→grupo por FK — ver "Grupos de usuário"). A `064` adiciona
`financial_account_control.additional_info` TEXT (nullable) — texto livre do usuário no cadastro
de contas, exibido no card de detalhe de `/consulta`; ver "CRUD de contas". A `063` cria o catálogo
**`public.user_group`** (fundação de permissões por grupo — id 0 sentinela + RLS read
`authenticated`/write `service_role`) + backfill `app_metadata.group_id=0` nos usuários; ver
"Grupos de usuário" na seção de papéis e o blueprint `docs/design/permissoes-por-grupo.md`.
(Há um `062` **duplicado** no diretório — `062_chart_account_default_level_3` e
`062_doc_type_multa_dare`; a numeração seguiu para 063.) A `061` adiciona
**`image_vision`** ao CHECK de `financial_account_control.extraction_source` — anexos de IMAGEM
lidos via Claude Vision; ver "extraction_source — origem dos dados". A `060` cria **índices de
performance** da pesquisa em `/consulta` (GIN trigram em `invoice_number`/`subject`/`sender_email`
para `ilike '%termo%'`, btree em `amount` e em `created_at DESC`). A `059` é o **backfill ÚNICO**
da classificação contábil das contas a partir do fornecedor (contas com `cost_center_id=0` E
`chart_account_id=0` herdam a classificação do supplier; fora do fluxo diário de extração).
A `058` adiciona a **FK direta**
`financial_chart_of_account.chart_account_group_id` → `financial_chart_of_account_group`
(+ índice parcial) — a coluna já existia (DEFAULT 0 = "não informado"), mas sem FK o PostgREST
não resolvia o embed `group` do grid/form de Plano de contas; sem valores órfãos, a constraint
não falha. A `057` é de **segurança**
(idempotente, defesa em profundidade): `REVOKE INSERT/UPDATE/DELETE` do papel `authenticated`
em `supplier`/`status` — o RLS já bloqueava (ambas só têm política de SELECT), isto remove o
grant default residual para simetria com a `056`; escrita segue só `service_role`. **O REVOKE do
grant default é um PADRÃO recorrente deste projeto, não um evento isolado** — o Supabase concede
INSERT/UPDATE/DELETE ao papel `authenticated` em toda tabela/VIEW nova do schema public, então
**toda migration que cria objeto novo deve terminar com o REVOKE do que o papel não escreve**
(056/057 nos cadastros, **079** no anexo, **081** nas 6 tabelas restantes + a view `app_user`,
onde deixar o default passar era uma escalada de privilégio real). Conferir com
`information_schema.role_table_grants` (grantee='authenticated', privilege_type in INSERT/UPDATE/
DELETE) — o esperado é a lista vazia, fora dos grants POR COLUNA intencionais das 030/033/068.

> **A receita acima está DESATUALIZADA em um ponto: conferir só `authenticated` não basta.**
> Levantado na Fase 0 do chat de IA (2026-07-28) e **corrigido pela migration 097**: a campanha
> 056/057/079/081 tratou o papel `authenticated`, mas **`anon` seguia com `INSERT`/`UPDATE`/
> `DELETE` de tabela inteira em 16 tabelas** do `public` (incluindo `financial_account_control`
> por completo) e **`TRUNCATE` estava concedido aos DOIS papéis** em quase tudo — sendo que
> **`TRUNCATE` não é filtrado por RLS**. Nenhum dos dois era explorável (RLS sem policy para
> `anon` ⇒ default-deny; e `TRUNCATE` não é exposto pelo PostgREST, com ambos os papéis sem
> `rolcanlogin`), mas o primeiro deixava a RLS como barreira **única** e o segundo é o que
> morderia se um dia existir caminho de SQL arbitrário sob esses papéis.
>
> **Receita corrigida** — usar `grantee IN ('anon','authenticated')` e `privilege_type IN
> ('INSERT','UPDATE','DELETE','TRUNCATE')`; o esperado hoje é **lista vazia** (a 097 zerou), com
> os grants POR COLUNA das 030/033/068 preservados à parte em `column_privileges`. E, desde a
> **097**, o `ALTER DEFAULT PRIVILEGES` do `public` já nasce sem escrita para os dois papéis —
> então **tabela nova não reintroduz o resíduo** (a ressalva fica por conta de objeto criado por
> `supabase_admin`, cujo default não é alterável sem superuser).

A `056` é de **segurança**
(idempotente): habilita RLS + leitura `authenticated` + **REVOKE de escrita** do papel
`authenticated` nos cadastros pré-existentes (`company`/`financial_account`/`financial_bank`/
grupos/subgrupos) e em `audit_log` se existir — fecha o ponto cego de RLS apontado na
auditoria de segurança. **Exige verificação no SQL Editor antes de aplicar** — ver
`supabase/migrations/README.md` e `docs/review/seguranca/RELATORIO-SEGURANCA.md` §2. A `055` é **só documentação**
(`COMMENT ON`, idempotente/re-executável): registra no banco o ON DELETE efetivo das FKs de
classificação (`NO ACTION` ≡ `RESTRICT`) e que `status` é a 4ª coluna gravável por `authenticated`
em `financial_account_control` (036). Caveats operacionais — aplicação uma-vez/ordem, migrations
não re-executáveis (042/050/051/053/039) e pré-requisito de bootstrap (cadastros pré-existentes +
`normalize_search`) — em `supabase/migrations/README.md`. A `054` redefine
`resolve_supplier_id`: a busca por e-mail vira **fallback após o nome** (não-interno), corrigindo a
criação de fornecedor duplicado quando o e-mail já consta num cadastro — ver "Auto-resolução de
fornecedor". A `053` adiciona a FK
`financial_account.status_id` → `status.status_id` — formaliza no banco a relação do lookup
de situação do CRUD de Contas; a dimensão `status` tem os ids 1–10 do ciclo de contas a pagar
+ o 30 = "ativo" das contas bancárias, então não há linha órfã.) (As `050`/`051` convertem PKs para
**`GENERATED ALWAYS AS IDENTITY`** — id gerado SEMPRE pelo banco, inclusão direta de id BLOQUEADA
(exige `OVERRIDING SYSTEM VALUE`): a `050` em `financial_chart_of_account.chart_account_id`; a `051`
em `financial_account.financial_account_id`, `financial_chart_of_account_group.chart_account_group_id`,
`financial_chart_of_account_subgroup.chart_account_subgroup_id` e `financial_cost_center.cost_center_id`
(todas eram `smallint NOT NULL DEFAULT 0`; cada uma teve `DROP DEFAULT` → `ADD GENERATED ALWAYS AS
IDENTITY` → `setval` acima do `max` atual). A `052` adiciona `supplier.cost_center_id`/`chart_account_id`
(SMALLINT NOT NULL DEFAULT 0 + FKs + índices) e faz o **merge/backfill** a partir de
`financial_account_control` (par não-zero por fornecedor; diagnóstico: 0 conflitos) — base do **sync de
classificação default do fornecedor**, ver "Classificação default do fornecedor — sync bidirecional".)
(A `049` adiciona policy de **SELECT
`TO authenticated`** em `financial_cost_center` e `financial_chart_of_account` — sem ela, o RLS
estava habilitado **sem nenhuma policy** (default deny) e o embed `cost_center`/`chart_account`
lido pelo frontend com papel `authenticated` voltava **null**, fazendo o grid/detalhe de `/consulta`
mostrar o **`#id`** em vez da descrição. A Next API não sofria por usar service_role.) (As `047`/`048` adicionam a **classificação
contábil** em `financial_account_control`: a `047` cria `cost_center_id` SMALLINT (FK →
`financial_cost_center`) e `chart_account_id` SMALLINT (FK → `financial_chart_of_account`) +
índices; a `048` torna ambas **NOT NULL DEFAULT 0** — id 0 = sentinela "não informado" (a linha id 0
existe nos dois cadastros, então o JOIN sempre casa; a UI trata 0 como vazio "—"). Ver "CRUD de
contas" e "Lookups de classificação contábil". A `046` corrige a **ordem de resolução de
fornecedor** — nome antes do e-mail; e-mail só sem nome — e bloqueia e-mails de domínio interno
(`otimotex.com.br`/`lebianco.com.br`) em `supplier`; ver "Auto-resolução de fornecedor". A `045`
adiciona `supplier.deleted_at`
+ índice parcial — soft delete do CRUD de fornecedores, ver "CRUD de fornecedores (Next API)".
A `037` cria as tabelas de log da
cobrança de vencidos — ver "Pipeline de cobrança de vencidos". A `040` cria a RPC
`resolve_supplier_for_account`; a `041` dropa o trigger de resolução, a RPC
`financial_dup_by_name` e as colunas `supplier_name`/`supplier_cnpj`/`supplier_cpf`. A `042`
introduz a **surrogate key snowflake** `sk_supplier`: vira a PK auto-incremental de `supplier`
e o alvo de toda FK; `supplier_id` passa a chave de negócio (NOT NULL UNIQUE, só em `supplier`);
`financial_account_control.supplier_id` é substituída por `sk_supplier` — **ver "Auto-resolução
de fornecedor"**. A `043` adiciona os tipos `conta de água`/`conta de luz`/`conta de telefone /
internet` ao CHECK de `document_type` e faz backfill — ver "Normalização de `document_type`".)

| Tabela | Propósito |
|---|---|
| `email_control` | Dedup/controle. `status` ∈ (`extraído`, `recebido`, `pendente`, `falha`, `ignorado`, `duplicidade`) — **migrations 022/031**. `extraído`=conta veio do PDF (ou CSV gerado sem conta nova); `recebido`=**conta veio do CORPO** — desde 2026-08-17 vale mesmo com anexo que gerou CSV, desde que nenhuma conta tenha saído dele (ver o invariante em "`status_for_result`"); `pendente`=PDF salvo sem CSV (substitui `baixado`); `falha`=casou keyword mas sem PDF e sem conta no corpo; `ignorado`=não-financeiro (sem keyword) **ou NF-e pura sem conta a pagar** (`subject_is_pure_nfe`); `duplicidade`=pagável do corpo duplica conta já registrada por outro e-mail (**migration 031**; card/filtro próprios em `/emails`). O status é calculado em `process_message` pelo resultado real (conta/CSV/corpo/duplicata), não por `pdf_extracted`. **Visibilidade por REMETENTE (migration 078):** a policy SELECT (`authenticated`) filtra por `lower(sender_email)=lower(auth.email())` quando o grupo do usuário tem `sees_only_own_accounts` (Comercial) — `/emails` mostra só os e-mails de que o usuário é remetente; demais grupos veem tudo; `service_role` com bypass. **Corpo (migrations 105/106 — Onda 2):** `body_preview` segue TRUNCADO em 500 chars (é o preview da tela) e **`body_full`** guarda o corpo INTEIRO — não unificar os dois. **`body_search`** é `tsvector` GERADO de assunto+corpo (`to_tsvector('portuguese'::regconfig, left(…, 100000))` — regconfig explícito porque a versão de 1 argumento é STABLE; o `left` é teto contra o limite de 1 MB do tsvector, que **quebraria o INSERT**), com índice GIN e a tool `analytics.buscar_emails`. `body_full` **NULL significa "ainda não temos o corpo"** (e-mail antigo com preview truncado, ou sem keyword — que nem tem o corpo baixado), distinto de string vazia. **A Onda 4 recuperou 70 dos 506 candidatos (2026-08-03); os 436 restantes são IRRECUPERÁVEIS** — os e-mails já não estão na INBOX, e não há segunda passada que os traga. `authenticated` NÃO grava nessas colunas (o UPDATE dele é restrito a `reviewed_at`) |
| `financial_account_control` | Tabela principal de contas a pagar — uma linha por documento; alimentada pelo pipeline de e-mail **e** por CRUD manual (baixas, consolidações, dashboards). Substitui a antiga `financial_emails` (dropada na migration 020). O fornecedor é referenciado **só pela FK `sk_supplier`** (surrogate key snowflake, NOT NULL — **migration 042**, antes era `supplier_id`) — nome/CNPJ vêm do JOIN com `supplier` (colunas denormalizadas dropadas na **migration 041**). Tem `sender_email` (migration 023; backfill em 025) usado na resolução p/ alinhar `supplier.email`, e `subject` (migration 025) — exibidos/buscados em `/consulta`. **Classificação contábil** (migrations 047/048): `cost_center_id`/`chart_account_id` SMALLINT, NOT NULL DEFAULT 0 (FKs para os cadastros; id 0 = "não informado") — preenchidos no CRUD manual (cascata centro→plano). **Autoria** (migrations 076/077): `created_by` (DONO — base da visibilidade por dono), `updated_by`, `status_changed_by`, `status_changed_at` — UUID → `auth.users`, NOT NULL DEFAULT sentinela (hoje `financeiro@otimotex.com.br` — migration 110), carimbados pelo servidor/trigger `trg_fac_authorship` (ver "Visibilidade de contas por dono" / "Auditoria de autor"). 🔴 **Essas colunas guardam só o ÚLTIMO autor** — a penúltima alteração é sobrescrita. O HISTÓRICO (quem alterou o quê, com antes/depois) vive em **`audit_log`** desde a Onda 7; não tente reconstruí-lo a partir daqui. **`payment_date`** (DATE, migration 096): **a data de pagamento da conta** — carimbada pela trigger `trg_fac_payment_date` ao entrar em `status_id = 8` e limpa ao sair; escrita SÓ pela trigger (fora do grant de coluna de `authenticated` e do schema Zod de escrita). Usar como data de pagamento sem ressalva; a auditoria estrutural e o limite do histórico (backfill da 096 = vencimento) estão no bloco da 096 acima. 🔴 **`competence_date` é TEXT no formato `YYYY-MM` (mês de competência) e NUNCA deve ser convertida para DATE** — `'2026-06'::date` é erro de sintaxe, e o formato é contrato de 3 camadas (prompt do Claude em `extract_pdf.py`, template do CSV, schema Zod); converter faria **todo INSERT do reader falhar**. **Colunas DERIVADAS (Onda 6, migrations 112/114 — todas `GENERATED ALWAYS ... STORED`, só leitura, no `.omit()` do schema Zod):** `competence_month` (1º dia do mês de competência, via **`make_date`** — `to_date` é STABLE e o PostgreSQL a recusa), `days_late` (`payment_date - due_date`; negativo = antecipado; **não é DPO**), `extraction_confidence` (alta/media/baixa/manual/desconhecida), `installment_number`/`installment_base` (ordinal da parcela e documento do carnê; **não existe total** — use `analytics.parcelamentos()`) |
| `financial_cost_center` / `financial_chart_of_account` | **Cadastros de classificação contábil** (pré-existentes, **preservados em limpezas**) usados como lookup no modal de contas. `financial_cost_center` é **gerenciado pelo CRUD de centros de custo** (`/tabelas/centros-de-custo` — PK `cost_center_id` SMALLINT IDENTITY ALWAYS; id 0 = sentinela "não informado", fora do CRUD; ver "CRUD de centros de custo"). `financial_chart_of_account` (também gerenciado pelo **CRUD de Plano de contas** — `/tabelas/plano-de-contas`) tem `cost_center_id` (relaciona o plano ao centro — base da CASCATA), `chart_account_subgroup_id` (FK → subgrupo) e `is_postable` (só os postáveis são lançáveis). Os cadastros `financial_bank`, `financial_account`, `financial_chart_of_account_group` e `financial_chart_of_account_subgroup` também ganharam CRUD próprio (grupo Tabelas — ver "CRUDs dos demais cadastros contábeis"). Lidos via `lib/lookups.ts` (service_role) **e** pelo frontend via embed REST (papel `authenticated`); RLS habilitado com policy de SELECT `TO authenticated` (migration 049 — sem ela o embed voltava null e a UI mostrava `#id`) |
| `email_processing_errors` | Log de falhas com `raw_payload` JSON. **Visibilidade por REMETENTE (migration 078):** policy SELECT (`authenticated`) filtra por `lower(sender_email)=lower(auth.email())` para grupo com `sees_only_own_accounts` (Comercial) — `/erros` mostra só os erros de que o usuário é remetente; demais veem tudo; `service_role` com bypass |
| `financial_account_attachment` | **Anexos (N) de uma conta** (migration 079) — PADRÃO ÚNICO das duas origens: `origin='pipeline'` (documento do e-mail; espelha `financial_account_control.source_file`, gravado pelo reader) e `origin='manual'` (upload do usuário no cadastro/edição). `storage_key` = chave CRUA do objeto no bucket `attachments` (pipeline: nome flat; manual: `manual/{conta}/…`). **Soft delete** (`deleted_at`/`deleted_by`) — o objeto FICA no bucket; anexo `pipeline` é irremovível (auditoria → 403). UNIQUE `(account_id, storage_key)`; **não** UNIQUE global (um PDF com N boletos gera N contas que COMPARTILHAM o objeto). RLS SELECT herda a visibilidade da conta pai (076) via `EXISTS`; escrita só `service_role`. Ver "Anexos de conta" |
| `dim_date` | **Calendário 2015-2045** (11.323 dias, migration 111 — Onda 6). Semeada PELAS funções `br_easter`/`br_holiday_name` (IMMUTABLE), com oráculo diferencial embutido na migration: ela **aborta** se a tabela divergir das funções. `is_business_day` segue o calendário **BANCÁRIO** (Febraban), não a letra da lei — Carnaval e Corpus Christi são ponto facultativo, mas o banco fecha, e o que importa para conta a pagar é se o dinheiro anda; `holiday_kind` distingue `'nacional'` de `'bancario'`. Consciência Negra só é nacional a partir de **2024** (Lei 14.759/2023). Dado de REFERÊNCIA: `authenticated` lê tudo (policy permissiva de SELECT — 🔴 obrigatória, ver a lição do GRANT sem policy), `anon` não lê, ninguém escreve pelo app. Consultada por `public.dias_uteis(de, ate)` (intervalo SEMIABERTO; **STABLE**, logo NÃO usável em coluna gerada). **Cadastro/configuração — preservar em limpezas** |
| `audit_log` | **Trilha de auditoria** (migrations 117/118 — Onda 7): quem alterou o quê em `financial_account_control` e `supplier`. Gravada por trigger **AFTER** (`fn_audit_row`, `SECURITY DEFINER`) em UPDATE/DELETE + **BEFORE TRUNCATE** (`fn_audit_truncate`, que conta as linhas antes de a tabela esvaziar). UPDATE guarda o **delta**; DELETE guarda a **linha inteira** (única cópia que resta); UPDATE sem mudança real **não gera linha**. `registro_dono` desnormaliza o dono para a RLS **sobreviver à conta apagada** (o `EXISTS` da 079 não serve aqui); `ator_via` declara COMO o autor foi obtido (`jwt`/`header`/`guc`/`servico`). 🔴 **`usuario_id` NÃO tem FK para `auth.users` de propósito** — qualquer FK destruiria a trilha (CASCADE apaga, SET NULL desatribui, RESTRICT impede remover usuário); o nome é resolvido na LEITURA por `analytics.audit_actor_label`, que distingue automação de usuário removido. 🔴 `anon` **não lê** — a policy `TO public` original foi removida pela 117. Escrita só pela trigger. **Alvo de limpeza** (é log, não cadastro) |
| `fiscal_document` | **Documento fiscal eletrônico** identificado pela chave de acesso de 44 dígitos (migration 107 — Onda 3): NF-e 55 · CT-e 57 · CF-e 59 · NFC-e 65. Tabela de **PROVENIÊNCIA, append-only** — `access_key` UNIQUE (dedup natural do reenvio), campos derivados da própria chave, `storage_key` (🔴 é o que faz a purga PRESERVAR o PDF) e a origem do e-mail (`gmail_message_id`/`sender_email`/`subject`/`received_at`, sem FK — o registro é não-fatal). **Conteúdo do transporte (migration 119 — Onda 5):** `origin`/`destination`/`cargo_weight_kg`/`freight_amount`/`cargo_amount`/`linked_invoice`/`receiver_name`/`service_date`/`awb`, com `content_source` (`braspress_invoice` \| `dacte_llm`) declarando a procedência — preenchidos só para CT-e vindo de fatura agregada (57 de 293); NULL = **ainda não extraído**, não "não tem". 🔴 **`freight_amount` é DECOMPOSIÇÃO da fatura já lançada como conta a pagar — nunca somar com `gasto_por_*`**; a barreira aqui é declarada + travada em teste, não mais a ausência de coluna. RLS SELECT reusa o recorte por REMETENTE da 078; escrita só `service_role`. Ver "O que a Onda 3 entregou" e "O que a Onda 5 entregou" |
| `supplier` | Fornecedores. PK = `sk_supplier` (surrogate key snowflake auto-incremental — **migration 042**); `supplier_id` é **chave de negócio** (NOT NULL UNIQUE, só nesta tabela; = `sk_supplier` nos fornecedores criados pela extração, via trigger de espelho `trg_supplier_mirror_id`, podendo divergir em cargas externas). Auto-criados pelo trigger de resolução, mas **cadastro PRESERVADO** (curadoria manual de `email`/`email2`/`email3`/`email4`) — **nunca truncar** em limpezas (ver "Limpeza / reset de dados"). Reconhecimento por **e-mail** em `email`/`email2`/`email3`/`email4` (migrations 023/027/028) — ver "Auto-resolução de fornecedor". **Soft delete** via `deleted_at` (migration 045) — a baixa pelo CRUD da Next API marca `deleted_at` (nunca hard delete) e é bloqueada quando há contas vinculadas; ver "CRUD de fornecedores (Next API)". **Classificação default** `cost_center_id`/`chart_account_id` (SMALLINT NOT NULL DEFAULT 0 + FKs — migration 052): semeia o lançamento de novas contas e é atualizada pelo write-back do modal; ver "Classificação default do fornecedor — sync bidirecional". **Contatos** (migration 082): `phone_ddd1`/`phone1`/`phone_ddd2`/`phone2` (char(2)/varchar(9)), `whatsapp1`/`whatsapp2` (varchar(11)), `pix_key1`/`pix_key2` (varchar(77)) — 2 slots por tipo, preenchidos pelo form e pela extração (write-back com lógica de 2 slots); ver "Contato do fornecedor" |
| `company` | Empresa pagadora (**cadastro**, tem campo `email`). PK = **`sk_company`** (surrogate key snowflake `GENERATED ALWAYS AS IDENTITY` — migration 083, chave única de relacionamento); `company_id` é **campo de origem** (NOT NULL UNIQUE, do sistema maior). Hoje há DUAS: OTIMOTEX (sk 1) e LEBIANCO (sk 2). A empresa da conta (`financial_account_control.sk_company`) tem DUAS origens, ambas explícitas: a **regra LEBIANCO** no pipeline e o **select "Empresa" do `ContaForm`** no CRUD manual (default OTIMOTEX) — ver "Empresa pagadora (`sk_company`) — regra LEBIANCO". O trigger `trg_fe_resolve_company()` → **`resolve_company_sk`** (`payer_cnpj`/`payer_name`) ficou como **fallback residual** (migration 084): só atuaria num INSERT que omitisse `sk_company`. O lookup do select é `GET /api/companies` (`companyService`). **Preservada em limpezas** (ver abaixo) |
| `status` | **Dimensão** de situação (`status_id`, `status_name`, `status_short_name`, `has_opened`/`has_closed`/`has_invoiced`). 10 linhas (ids 1..10) = **domínio de `financial_account_control.status_id`** (fonte única — a coluna `status` texto foi removida na 069) + alvo da FK `fk_fac_status`. O nome de exibição da conta vem do embed `status_dim:status(...)`. **Cadastro/configuração — preservar em limpezas** |
| `user_group` | **Catálogo de grupos de usuário** (migration 063 — fundação de permissões por grupo). `group_id` IDENTITY ALWAYS PK, `group_name` VARCHAR(30) DEFAULT ''; **id 0 = sentinela "não informado"**. RLS read `authenticated`/write `service_role`. Carrega as **flags de comportamento do grupo**, hoje duas e **ortogonais**: `sees_only_own_accounts` (076 — visibilidade de LINHA, imposta pela RLS) e `ai_chat_enabled` + `ai_chat_limit_per_hour`/`_per_day` (120 — acesso e cota do chat de IA, impostos na Next API; NULL nas cotas = teto do `.env`). **Editado SÓ via Supabase** (sem CRUD no app); o usuário pretende acrescentar campos. A atribuição por usuário e o RBAC completo (`user_profile`/`permission`/`group_*`) estão **desenhados, não implementados** — ver "Grupos de usuário" na seção de papéis e `docs/design/permissoes-por-grupo.md`. **Cadastro/configuração — preservar em limpezas** |
| `cobranca_envios_log` | Cobranças de vencidos **enviadas com sucesso** (migration 037). `document_id` (= TÍTULO no Firebird) **UNIQUE** = chave de deduplicação: `already_sent()` consulta aqui antes de enviar. Exibida em `/cobranca/envios`. Alvo de limpeza (dados de teste) |
| `cobranca_erros_log` | **Falhas** da cobrança (migration 037), **sem UNIQUE** (reprocessável — o mesmo título pode falhar em execuções distintas). `error_type` ∈ (`email_ausente`, `email_invalido`, `smtp_falha`, `smtp_bloqueio`, `supabase_falha`, `firebird_falha`, `erro_inesperado`); `error_message` = motivo em linguagem leiga (exibido em `/cobranca/erros`), `error_detail` = traceback técnico. Alvo de limpeza |

**Características físicas de `supplier`** (tabela pré-existente, **não criada por migration**;
introspecção em 2026-06-23): colunas `sk_supplier` (PK, bigint), `supplier_id` (bigint, chave de
negócio), `cnpj CHAR(14)`, `cpf CHAR(11)`, `legal_name`, `trade_name`, `email`/`email2`/`email3`/
`email4`. CHECK `chk_supplier_has_identifier` (ao menos um de cnpj/cpf/legal_name/trade_name).
Índices GIN trigram nos 4 e-mails (migration 029); RLS `authenticated_select_supplier`.
- **Estado original (pré-042):** `supplier_id` era **`GENERATED ALWAYS AS IDENTITY`**
  (`pg_attribute.attidentity = 'a'`), backed por `supplier_supplier_id_seq`; PK `supplier_pkey`.
- **Pós-042:** a `042` faz `DROP IDENTITY` em `supplier_id` (remove a `supplier_supplier_id_seq`
  junto) e cria uma **sequence nova** `supplier_sk_supplier_seq` (semeada em `max(sk_supplier)+1`)
  como `DEFAULT` de `sk_supplier`; a PK `supplier_pkey` passa a ser `(sk_supplier)`; `supplier_id`
  vira `NOT NULL UNIQUE` (`uq_supplier_supplier_id`), gravado pelo trigger de espelho
  `trg_supplier_mirror_id` quando o INSERT não o informa.

> **`status_id` é a FONTE ÚNICA da situação — a coluna `status` (texto) foi REMOVIDA (migração
> faseada concluída, FASE 1→3).** A situação de `financial_account_control` é lida/escrita SÓ por
> `status_id` (FK → dimensão `status`); o NOME de exibição vem do embed
> `status_dim:status(status_name,status_short_name)`. Constantes `STATUS_IDS`/`STATUS_ID_*`/
> `STATUS_NAME_BY_ID` em `@sheild/shared` (id 1..10 = a ordem da dimensão).
> **FASE 1 (migration 067):** `status_id` `NOT NULL DEFAULT 3` ('a vencer'); leitura/filtro/ordenação/
> KPI por `status_id` + embed. **FASE 2 (migration 068):** trigger `fn_set_status_from_due_date`
> **id-primária** (recalcula 3/2 por vencimento quando aberto — ids 1/2/3) + `GRANT UPDATE(status_id)
> TO authenticated`; escrita por `status_id` — frontend (`setFinancialAccountStatus`/bulk +
> `StatusSelectCell` por id), Next API (update aceita `status_id`) e Python
> (`register_financial._apply_status_id` traduz o texto interno → `status_id` num único ponto na
> gravação; `'pendente'`→omite/DEFAULT 3, `'falha'`→10; `extract_pdf.py` intocado — ainda rotula por
> texto internamente, traduzido no register). **FASE 3 (migration 069):** trigger simplificada (só id),
> CHECK e coluna `status` texto **DROPADOS**, `status`/`accountStatusSchema` removidos do shared schema.
> **Ordenação da coluna Situação** = `order=status_dim(status_name)` (nome, alfabético — decisão de
> negócio; id ≠ ordem).

**`financial_account_control.status_id`** (`SMALLINT NOT NULL DEFAULT 3`, FK `fk_fac_status` →
`status.status_id`) é a **coluna ÚNICA de situação/ciclo de vida** — a antiga coluna `status`
(texto) foi **REMOVIDA** (migration **069**; ver a nota da migração faseada acima). Domínio = a
dimensão `status` (ids 1..10): `1 pendente · 2 vencido · 3 a vencer · 4 prorrogado · 5 baixado ·
6 protestado · 7 cartório · 8 pago · 9 cancelado · 10 falha`. O **nome de exibição** vem do embed
`status_dim:status(status_name,status_short_name)` (não há mais coluna de texto na linha). A trigger
**`fn_set_status_from_due_date`** (`trg_fe_status_vencimento`, BEFORE INSERT/UPDATE — id-primária
desde a 068, simplificada só-id na 069) grava `status_id` **3 (a vencer) / 2 (vencido)** a partir de
`due_date` × **a data de HOJE** (`NOW()`, fuso `America/Sao_Paulo` — corrigido pela **095**, ver
"Trigger de situação por vencimento usava a data de EXTRAÇÃO" na seção "Pipeline de baixa
automática"; **antes** da 095 usava `extracted_at` congelado, um bug que fazia contas vencidas
ficarem presas em "a vencer" indefinidamente) **apenas quando EM ABERTO** (`status_id IN
(1,2,3)`) — preserva os estados fechados (`falha`/`pago`/`baixado`/`cancelado`/`protestado`/
`cartório`/`prorrogado`). Histórico: a **034** fundiu o antigo `due_status` na coluna `status`
(texto); a **035** alinhou o domínio à dimensão `status`; as **067/068/069** migraram a fonte de
verdade para `status_id` e dropraram o texto; a **095** corrigiu a data de referência. `payment_method` aceita `boleto, pix, ted, cartão, depósito, duplicata,
bancário, carteira, vale, crédito, débito, débito automático, dinheiro, transferência, cheque,
outro` (`débito automático` = débito direto em conta, distinto do `débito` cartão — migration 071;
CHECK por valor EXATO, sem `lower()`); `extraction_source` ∈ (`email_body, pdf_text, pdf_vision,
image_vision, falha`).

**Schemas Zod (`packages/shared`) = fonte única de tipos.** **Zod 4** (upgrade Fase 5):
e-mail usa a API top-level `z.email('…')` (não mais `z.string().email()`); demais APIs
(`z.enum`, `.refine`, `z.coerce.number`, `.default`, `.safeParse`, `error.issues`)
inalteradas. O `zodResolver` vem do `@hookform/resolvers@5` (Standard Schema, compatível
com Zod 4). Os tipos TS são `z.infer` dos
schemas (não há tipo escrito à mão para divergir); os `z.enum` espelham 1:1 os CHECK do
banco — ao alterar um CHECK, **atualizar o enum correspondente**. **Situação:** o schema tem
`status_id` (`z.number().int()`, fonte única — não há mais campo `status` texto nem
`accountStatusSchema`) + o embed de leitura `status_dim` (`status_name`/`status_short_name`). Os
NOMES da situação seguem em `ACCOUNT_STATUSES`/`AccountStatus` (labels) e o mapa id↔nome em
`STATUS_IDS`/`STATUS_NAME_BY_ID` (+ `STATUS_ID_PAGO`/`_CANCELADO`/`_A_VENCER`/`_VENCIDO`), todos em
`@sheild/shared`. `financialAccountControlInputSchema` **inclui `status_id`** (entrada de escrita da
situação — baixa/cancelamento via PATCH) e omite `status_dim` (leitura); `...CreateSchema` omite
`status_id` (a conta nasce no DEFAULT 3 do banco + trigger por vencimento). A trigger grava
`'a vencer'/'vencido'` (ids 3/2); baixas/CRUD manual definem os demais (`pago`/`baixado`/`cancelado`/…).
O frontend consome os schemas de dados (`FinancialAccountControl`, `EmailControl`,
`ProcessingError`) **apenas como `import type`** (sem `.parse()` em runtime — `services/supabase.ts`
faz cast); só os schemas de **auth** rodam em runtime via `zodResolver`.

**Autoria no schema (migrations 076/077):** `financialAccountControlSchema` (leitura) tem
`created_by`/`updated_by`/`status_changed_by`/`status_changed_at` (`z.string().nullable()`) — todos
**OMITIDOS** dos schemas de input/create/update/manualEdit (são carimbados pelo servidor/trigger,
nunca pelo cliente). Consumidos só na exibição do autor no detalhe de `/consulta`.

**`payment_date` no schema (migration 096):** mesma categoria da autoria — `z.string().nullable()`
no schema de **LEITURA** e **OMITIDO explicitamente** no `financialAccountControlInputSchema`
(logo, fora de create/update, que derivam do `.pick()` de manualEdit). O `.pick()` sozinho já a
excluiria; a omissão na base é defesa em profundidade, para a coluna seguir não-gravável se algum
write path futuro usar o InputSchema direto. Quem a grava é a trigger `trg_fac_payment_date`,
derivando-a de `status_id`; `authenticated` **não** tem grant de coluna nela.

**Fornecedor no schema (migrations 040/041/042):** `financialAccountControlSchema` **não** tem mais
`supplier_name`/`supplier_cnpj`/`supplier_cpf` — só `sk_supplier` (`z.number().int()`, NOT NULL — a
FK surrogate; `supplier_id` ficou só na tabela `supplier`) e um recurso embutido opcional `supplier`
(`supplierEmbeddedSchema`: `trade_name`/`legal_name`/`cnpj`/`cpf`), presente quando o select inclui
`supplier(...)`. O `financialAccountControlInputSchema` **inclui `sk_supplier`** (entrada obrigatória
— o pipeline resolve via RPC, que devolve o surrogate, antes de gravar) e omite o recurso `supplier`
(leitura).

**Classificação contábil no schema (migrations 047/048):** `financialAccountControlSchema` tem
`cost_center_id`/`chart_account_id` (`z.number().int().default(0)` — NOT NULL DEFAULT 0 no banco) +
embeds opcionais de leitura `cost_center` (`cost_center_code`/`cost_center_description`) e
`chart_account` (`account_code`/`account_description`), presentes quando o select usa os aliases
`cost_center:financial_cost_center(...)` / `chart_account:financial_chart_of_account(...)`. Schemas
`costCenterSchema`/`chartAccountSchema` em `@sheild/shared`. No input/create/update os embeds são
omitidos; os ids entram como opcionais (a UI envia `0` quando não informado).

**Classificação default no schema do supplier (migration 052):** `supplierSchema` (leitura) também
expõe `cost_center_id`/`chart_account_id` (`z.number().int().default(0)`) + embeds opcionais
`cost_center`/`chart_account` (reutiliza `costCenterEmbeddedSchema`/`chartAccountEmbeddedSchema` de
`financial-account-control.schema`). **Entram** em `editableFields` (logo em
`supplierCreateSchema`/`supplierUpdateSchema`) como `z.number().int().min(0).optional()` — editáveis
pelo CRUD de fornecedores (`/fornecedores`); ver "Classificação default do fornecedor — sync
bidirecional". O write-back do modal de contas (`setSupplierClassification`) **permanece** como
caminho paralelo de gravação.

**Anexos no schema (migration 079):** `financial-account-attachment.schema.ts` traz o domínio
(`ATTACHMENT_MIME_TYPES` — espelha `_UPLOAD_CONTENT_TYPES` do reader; `ATTACHMENT_MIME_TO_EXT`;
`ATTACHMENT_ORIGINS`; `ATTACHMENT_MAX_BYTES` = 10 MB) + `financialAccountAttachmentSchema` (leitura)
e as duas entradas do upload em 2 passos: `attachmentUploadRequestSchema` (`file_name`/`mime_type`/
`size_bytes` — o que o cliente DECLARA, só um pré-filtro) e `attachmentRegisterSchema` (+
`storage_key`). `financialAccountControlSchema` ganhou o embed de leitura
`attachments: z.array(...).optional()`, presente quando o select usa o alias
`attachments:financial_account_attachment(...)`; ele entra no `.omit()` do
`financialAccountControlInputSchema` (junto de `supplier`/`cost_center`/`chart_account`/`status_dim`)
— **anexo NUNCA é gravável pelo corpo da conta**, só pelas rotas dedicadas, o que mantém a regra
**S3-2** intacta.

**Schema base vs. criação manual:** `amount` é `nullable` no schema base (o pipeline pode
gravar sem valor → vira erro `sem_valor`, não cria conta). A criação manual via `POST /api/contas`
usa `financialAccountControlCreateSchema` e a edição via `PATCH` usa
`financialAccountControlUpdateSchema`, **ambos derivados de `financialAccountControlManualEditSchema`**
(S3-2, auditoria de segurança — não regredir): um **`.pick()`** SÓ dos campos do formulário
(`sk_supplier`, **`sk_company`**, `cost_center_id`, `chart_account_id`, `invoice_number`, `issue_date`,
`due_date`, `amount`, `document_type`, `payment_method`, `barcode`, `description`, `additional_info`,
`status_id`). **`sk_company` é um CARVE-OUT consciente da S3-2** (a empresa pagadora é escolha do
usuário no `ContaForm` — antes era só derivada): as demais colunas de pagador (`payer_cnpj`/
`payer_name`) e todas as de pipeline/auditoria **continuam fora**, e há teste travando isso. O trigger
da 084 respeita o valor explícito, então **nenhuma migration foi necessária** (a premissa documentada
na 084 — "o CRUD manual não grava sk_company" — deixou de valer). Como `sk_company` chega do schema de
leitura como `nullable`, o pick faz `.extend({ sk_company: z.number().int().positive() })`: um `null`
não daria erro — o trigger o resolveria **em silêncio** para OTIMOTEX, ignorando a intenção do cliente;
com o override vira **422**. Ele **não tem `.default()`**, então omiti-lo num PATCH preserva a empresa
atual (mesma garantia do `status_id`).
**`has_invoice`/`has_bank_slip` FICAM FORA do pick de propósito (não regredir):** elas têm
`.default(false)` no inputSchema e o **`.partial()` do Zod NÃO remove o default** — se estivessem no
pick, omiti-las no PATCH (o `ContaForm` não as edita) faria o parse injetar `false` e o UPDATE
**APAGARIA a curadoria NF/Boleto** (bug real: "Editar conta" zerava NF/BOL). A curadoria é feita
**exclusivamente** pela rota inline de `/consulta` (`setFinancialAccountFlag`, REST direto com grants
por coluna — migration 033), nunca pela Next API; fora do pick, o Zod as descarta (strip), então o
manual CRUD **não pode** tocar NF/Boleto por construção (create → DEFAULT FALSE do banco; update →
não mexe). `status_id` **entra** no pick e é seguro porque **não tem default Zod** (não é injetado). As
colunas de **PIPELINE/AUDITORIA** (`gmail_message_id`,
`source_file`, `extraction_source`, `extracted_at`, `processing_notes`, `email_body_excerpt`,
`sender_email`, `subject`, `payer_cnpj`/`payer_name`, `nosso_numero`, componentes de boleto) **NÃO são
graváveis** por POST/PATCH manual — o Zod (strip) as descarta; protege a trilha de auditoria/dedup. O
pipeline Python grava a tabela inteira via `service_role`, fora destes schemas. O create ainda **exige
`amount` > 0** e **omite `status_id`** (a conta nasce no DEFAULT 3 do banco; o cliente não cria conta
já em estado fechado). Não relaxar o `.positive()`, não reintroduzir campos de pipeline no
`.pick()`, nem trocar a base por `InputSchema` cru. Testes em `lib/contas.test.ts` travam o strip no
create e no PATCH.

RLS habilitado em todas as tabelas. Policies de leitura são `TO authenticated`
(migrations 015/018/019); escrita em `financial_account_control` é `TO service_role`
(CRUD via Next API). Toda nova tabela deve seguir o mesmo padrão. **Exceção — leitura por DONO
(migration 076):** a policy SELECT de `financial_account_control` deixou de ser `USING (true)` e
passou a `USING (NOT public.auth_group_sees_only_own() OR created_by = auth.uid())` — grupo com a
flag `sees_only_own_accounts` (Comercial) vê só as próprias; demais veem tudo. As colunas de autoria
`created_by`/`updated_by`/`status_changed_by`/`status_changed_at` (migrations 076/077) são carimbadas
pelo servidor/trigger `trg_fac_authorship`, nunca pelo cliente — ver "Visibilidade de contas por
dono" e "Auditoria de autor". **Exceção — leitura por REMETENTE em `/emails` e `/erros`
(migration 078):** as policies SELECT de `email_control` e `email_processing_errors` também deixaram
de ser `USING (true)` e passaram a `USING (NOT public.auth_group_sees_only_own() OR
lower(sender_email) = lower(auth.email()))` — a MESMA flag/helper da 076, mas casando o **remetente**
(`sender_email`) com o e-mail do usuário logado (`auth.email()`), não o `created_by`/UUID. Grupo
restrito (Comercial) vê só os e-mails/erros de que é remetente; demais veem tudo; `service_role`
mantém bypass. Linha com `sender_email` NULL fica oculta ao usuário restrito. **Exceção pontual
(migration 030):** `email_control` tem policy de UPDATE `TO authenticated`, mas com
**grant restrito à coluna** `reviewed_at` (`GRANT UPDATE (reviewed_at)`) — o frontend só
consegue marcar "revisado", não alterar outras colunas. `reviewed_at` é setado em `/emails`
ao abrir o card de detalhes de um e-mail com `status='falha'` (`markEmailReviewed`), exibindo
um check verde ao lado do badge de status (compartilhado entre usuários). **Exceção análoga
(migration 033):** `financial_account_control` tem policy de UPDATE `TO authenticated` com
**grant restrito às colunas** `has_invoice`/`has_bank_slip` (`GRANT UPDATE (has_invoice,
has_bank_slip)`) — flags de curadoria "Tem NF ?"/"Tem Boleto" editadas como checkbox
(`CheckToggle`) no grid de `/consulta` via `setFinancialAccountFlag` (update otimista).
**São DUAS travas independentes, não uma (migration 081 — não confundir):** o GRANT por coluna diz
QUAIS COLUNAS podem ser escritas; o predicado da policy diz QUAIS LINHAS. As duas policies de UPDATE
eram `USING (true)` (= qualquer linha) e passaram a usar o MESMO predicado do SELECT (076/078), de
modo que o usuário só edita o que a tela lhe mostra. Ao mexer em grant aqui, **nunca** faça `REVOKE
UPDATE` nessas duas tabelas: derruba os grants por coluna e quebra a curadoria inline — a 081 revoga
só `INSERT, DELETE` (ver "Escrita direta por `authenticated`").
**Baixa automática no ATO da edição (não regredir):** ao marcar a 2ª flag (NF ou BOL) de
uma conta com **vencimento <= hoje** e **situação em aberto** (`status_id ∈ {1,2,3}`), o
`handleToggleFlag` de `Consulta.tsx` dispara também `setFinancialAccountStatus(id,
STATUS_ID_PAGO)` — best-effort (falha aqui não reverte a flag já salva; o batch diário
reconcilia o que escapar). A regra vive em `qualifiesForAutoPago` (helper de módulo em
`Consulta.tsx`) e **espelha** o batch Python `baixa-automatica` (6h). Preserva situações
fechadas (cancelado/baixado/protestado/cartório/prorrogado/já pago) e **não** reverte ao
desmarcar. Ver "Pipeline de baixa automática (skill `baixa-automatica`)".
**O update otimista também espelha a trigger de `payment_date` (migration 096):** o helper
`nextPaymentDate` (`Consulta.tsx`, usado por `applyStatusId` — logo, vale para o toggle de flag,
o dropdown inline e a ação em lote) **preenche** com `todayISO()` ao ENTRAR em pago (preservando
data já existente, como a trigger faz) e **limpa** ao SAIR de pago; nas demais transições não
toca no campo. Sem isso a linha ficaria "paga sem data" até o próximo refresh — hoje invisível
(a coluna não é exibida no grid nem no CSV), visível assim que for. **Terceira
coluna gravável pelo `authenticated` (migration 068):** `status_id` (`GRANT UPDATE (status_id)`) —
a troca de **situação** em `/consulta` (`StatusSelectCell` inline + ação em lote) grava por
`status_id`; a trigger `fn_set_status_from_due_date` (SECURITY DEFINER) faz o resto. O grant antigo
de `status` (texto, migration 036) sumiu com a coluna (069). O frontend só altera essas três
colunas (`has_invoice`/`has_bank_slip`/`status_id`); o pipeline (`service_role`) escreve a tabela inteira.

### Limpeza / reset de dados (SEMPRE preservar os cadastros)

Ao limpar a base para uma nova busca geral, **SEMPRE preserve estas tabelas de
cadastro/configuração** — não são alimentadas pelo pipeline e nunca devem ser apagadas:

- `company`
- `status` (dimensão de situação — domínio de `status` + alvo da FK `status_id`)
- `supplier` (cadastro com curadoria manual — nome/CNPJ/CPF + `email`/`email2`/`email3`/`email4` são a **fonte da busca por fornecedor em `/consulta`**, que resolve `sk_supplier` na tabela `supplier` via `findSupplierIdsByTerm`; truncá-lo destruiria os e-mails cadastrados à mão **e** quebraria a exibição/busca, já que `financial_account_control` só guarda a FK `sk_supplier`. **Atenção:** truncar `supplier` com `RESTART IDENTITY` zeraria a sequence de `sk_supplier` e desalinharia das contas — mais um motivo para nunca truncá-lo)
- `financial_account`
- `financial_bank`
- `financial_chart_of_account`
- `financial_chart_of_account_group`
- `financial_chart_of_account_subgroup`
- `financial_cost_center`
- `user_group` (catálogo de grupos de usuário — migration 063; id 0 = sentinela "não informado". A atribuição por usuário vive no claim `app_metadata.group_id`, não aqui. Truncar destruiria as definições de grupo/permissão)
- `dim_date` (calendário 2015-2045 — migration 111; não tem relação com o pipeline. Truncar não perde dado de negócio, mas quebra `dias_uteis()` até alguém reexecutar a 111 — e o sintoma seria "0 dias úteis", silencioso)

**Alvos da limpeza** (truncar com `RESTART IDENTITY CASCADE`): `email_control`,
`financial_account_control`, `email_processing_errors`, `audit_log` — e, para os testes da
cobrança de vencidos, `cobranca_envios_log` + `cobranca_erros_log` — mais o
bucket **`attachments`** do Storage e o cache local (`data/pdfs_inbox`, `data/csv_output`).
`financial_account_attachment` **não precisa entrar na lista**: a FK
`account_id → financial_account_control(id)` é `ON DELETE CASCADE`, então o `TRUNCATE … CASCADE`
da tabela de contas já a esvazia junto (é dado do pipeline, não cadastro — pode ir).
`supplier` **não** é mais alvo: embora seja auto-criado pelo trigger, acumula curadoria
manual (e-mails `email2`/`email3`/`email4`) que seria perdida na truncagem; no
reprocessamento o `resolve_supplier_id` reutiliza os fornecedores existentes (casa por
CNPJ/CPF/e-mail/nome) sem duplicar. A `company` e o `supplier` preservados continuam
resolvendo `sk_company`/`sk_supplier` das novas contas.

> 🔴 **A ORDEM da limpeza passou a importar (Onda 7).** `TRUNCATE` em
> `financial_account_control` agora dispara `trg_audit_fac_truncate`, que **grava uma linha em
> `audit_log`** registrando quantas linhas foram destruídas — é justamente o registro que se quer
> ter depois de uma limpeza. Truncar a `audit_log` DEPOIS apagaria essa prova. **Truncar a
> `audit_log` PRIMEIRO**, ou aceitar deliberadamente perder o registro da própria limpeza.
> (Não há FK entre as duas, então o `CASCADE` de uma não alcança a outra — a ordem é escolha
> de quem executa, não do banco.)

> **Storage:** `DELETE` por `authenticated` em objetos do bucket `attachments` é bloqueado
> pela policy RESTRICTIVE `attachments_no_delete_authenticated` (migration 073 — S2-2; antes
> só o default-deny da RLS protegia, sem policy explícita). Esvaziar o bucket via **Storage
> API** com `SUPABASE_SERVICE_KEY` (o `service_role` ignora RLS): `POST object/list/attachments`
> → `DELETE object/attachments` com `{prefixes:[…]}`, do `.env` da raiz.

## Pipeline de cobrança de vencidos (skill `cobranca-vencidos`)

Segundo pipeline do projeto — **saída** (envio), paralelo ao de entrada (leitura de e-mails).
Lê títulos vencidos no **Firebird**, monta um e-mail HTML e **envia por SMTP (Locaweb)**,
registrando sucesso/falha no Supabase. Roda por `py -3` (Task Scheduler), **independente** do
Flask/Next.

```
Firebird (VW_PSQ_FIN_REC_BAN + _004)  →  run.py  →  SMTP transacional Locaweb (smtplw.com.br)
   títulos vencidos (STFI='VENCIDO',          │         To: cliente · Cc: representante
   DTVC >= hoje-7)                            │
                                              ├─ dedup: already_sent() consulta cobranca_envios_log (UNIQUE document_id)
                                              ├─ sucesso → cobranca_envios_log  (+ limpa erros antigos do título)
                                              ├─ falha   → cobranca_erros_log   →  UI /cobranca/erros
                                              └─ ao fim: resumo por CC das falhas DEFINITIVAS (failure_notify)
```

**Scripts** (`skills/cobranca-vencidos/scripts/`, importados como **módulos irmãos** via
`sys.path` no próprio dir — a pasta tem hífen, inválido como pacote Python; mesmo padrão de
`server/app.py` com `read_emails`):

| Arquivo | Papel |
|---|---|
| `run.py` | Entry-point do **batch diário** (`py -3 run.py [--dry-run]`). Lê o Firebird, abre **uma `SmtpSession` por lote** e, por título, chama `send_core.send_and_log` (passando a sessão). Loop com **rede de segurança** (`_process_titulo_safe`): falha de um e-mail **nunca** trava os demais. Throttle entre envios (`COBRANCA_SEND_DELAY_SECONDS`, default 10s). **Limpa erros resolvidos:** ao enviar com sucesso (ou pular um título já enviado) que **antes tinha erro** (`fetch_error_document_ids` no início → `delete_erro_rows_by_document_id`), remove as linhas antigas dele de `cobranca_erros_log` — assim um `email_ausente` corrigido no Firebird volta ao fluxo no dia seguinte e a falha some sozinha (best-effort; vale dentro da janela `DTVC >= hoje-7`) |
| `send_core.py` | **Núcleo compartilhado** por `run.py` (batch) e `resend.py` (reenvio manual): `validate_email`, `classify_smtp_error` e `send_and_log` (render→envia→loga; sucesso→`cobranca_envios_log`, falha→`cobranca_erros_log`; **nunca propaga exceção SMTP**). Centraliza a lógica num só lugar — não duplicar entre os fluxos |
| `resend.py` | **Reenvio manual** de falhas a partir de `/cobranca/erros` (`resend_erros(ids, on_progress)`). Ver subseção "Reenvio manual" abaixo |
| `db_firebird.py` | Conexão Firebird (driver **`fdb`**, fixado em `server/requirements.txt`) + `_QUERY` (UNION das views `VW_PSQ_FIN_REC_BAN` e `_004`). Linha **sem e-mail SEGUE** o fluxo (vira `email_ausente`); só descarta linha sem `document_id` |
| `email_sender.py` | Monta e envia. **To primeiro; se o principal falhar, o Cc NÃO é enviado** (2 `sendmail` na mesma conexão). **`SmtpSession`**: conexão **reaproveitada no lote** (lazy no 1º envio; reconecta+reenvia 1× se cair). `send_cobranca` (avulso) é wrapper de compat. **Atenção:** `smtplib.SMTPException` herda de `OSError` — o catch de queda usa `(SMTPServerDisconnected, ConnectionError, TimeoutError)`, **nunca** `OSError`, para não reenviar recusa definitiva (451/5xx/auth). **Segurança §4 A-2/A-3 (não regredir):** Subject é normalizado (`_strip_crlf`) e o Cc com quebra de linha é DESCARTADO (`_safe_address`) antes do header E do envelope `sendmail` — barra header injection (CRLF) a partir de dados do Firebird. **TLS (S4423 — não regredir):** o STARTTLS usa `_secure_tls_context()` (helper testado) = `ssl.create_default_context()` (valida certificado + hostname) **+ `minimum_version = TLSv1_2` explícito** (rejeita SSLv3/TLS 1.0/1.1, defesa em profundidade). Testes em `tests/test_email_security.py` (`TlsContextTest`) |
| `supabase_log.py` | `already_sent` (dedup), `log_envio_sucesso`, `log_envio_erro`, `fetch_company_smtp`, `fetch_erro_rows` (linhas de erro para o reenvio), `delete_erro_rows`/`delete_erro_rows_by_document_id`/`fetch_error_document_ids` (limpeza de resolvidos) |
| `template.py` | HTML do e-mail de cobrança (`render_html`). **Segurança §4 A-1 (não regredir):** `customer_name`/`document_id` (do Firebird) passam por `html.escape` antes de entrar no HTML — barra HTML/script injection no e-mail do cliente. Testes em `tests/test_email_security.py` |
| `failure_notify.py` | **Notificação ao representante (CC)** das falhas **definitivas** (`DEFINITIVE_ERROR_TYPES` = email_ausente/email_invalido/smtp_bloqueio): `group_by_cc` (resumo por CC, ignora falha sem CC) + `render_failure_digest` (HTML com cliente/título/vencimento/valor/motivo) + `build_subject`. Só no batch (`run.py`) |

**SMTP (não óbvio — não regredir):** remetente (`From`) = `company.email` (`sk_company=1` =
`financeiro@otimotex.com.br`). **Desde 2026-06-25 o envio usa o SMTP transacional da Locaweb**
(`smtplw.com.br`, produto de alto volume — credencial/token PRÓPRIA do painel, **não** a senha
do mailbox): `.env` tem `SMTP_HOST=smtplw.com.br` · `SMTP_PORT=587` (STARTTLS) · `SMTP_USER=otimotex1`
(usuário do painel, não o e-mail) · `SMTP_PASSWORD=<token>`. `_load_smtp_config` dá **prioridade às
`SMTP_*` sobre as `IMAP_*`** — a virada foi **só `.env`**, sem mudança de código. O domínio
`otimotex.com.br` precisa estar autorizado no painel (Domínio de Remetente). **Fallback** (sem
`SMTP_*`): caminho legado pelo mailbox IMAP — host `IMAP_HOST` (**`email-ssl.com.br`** —
`smtp.locaweb.com.br` dá timeout nesta conta) + senha `IMAP_PASS`, porta 587 STARTTLS.
`fetch_company_smtp` só lê colunas existentes (`email,legal_name,trade_name`) — a tabela `company`
**não** tem colunas `smtp_*`. A conexão é **reaproveitada no lote** (`SmtpSession`) — não mais uma
conexão por e-mail — para aliviar a pressão sobre o relay (`451 queue file write error`).

**Classificação de falha (regra de negócio):** `smtp_falha` = **instabilidade** (timeout,
queda, 450/451/452) → o próximo run **retenta**; `smtp_bloqueio` = **negação** (auth 535, 421,
5xx, destinatário recusado) → exige **ação humana** (limite de envios / conta bloqueada na
Locaweb). `_classify_smtp_error` decide pelo código/exceção. Mensagens em `error_message` são
**leigas** (coluna "Motivo" da UI); o técnico vai em `error_detail`.

**Exit code do batch (`run.py` — tarefa verde/vermelha no Agendador, não regredir):** `main()`
**retorna** o exit code (não chama `sys.exit` no meio; `__main__` faz `sys.exit(main())`).
`compute_exit_code(error_types)` decide: erros de **DADO** do cliente (`DATA_ERROR_TYPES` =
email_ausente/email_invalido — cliente sem e-mail no Firebird) **NÃO** reprovam a tarefa (são
logados em `cobranca_erros_log` e notificados ao CC, mas o run cumpriu seu papel); só erros
**OPERACIONAIS** (smtp_falha/smtp_bloqueio/supabase_falha/erro_inesperado/firebird_falha) fazem
sair `!= 0` → o `run_cobranca.ps1` marca "CRASH / ERRO" + Event Log e o Agendador mostra `0x1`.
Antes, **qualquer** erro (`counts["error"] > 0`) saía 1, então um run 100% OK com clientes sem
e-mail aparecia como falha (`0x1`). O resumo separa: `erros=N (sem e-mail/inválido=X · operacionais=Y)`.
O loop do lote vive em `_run_batch` (uma `SmtpSession` por lote, sempre fechada no `finally`);
`_record_result` contabiliza counts/error_types/limpeza/falhas-definitivas. Testes:
`tests/test_run_exit_code.py` (+ `test_run_notify`/`test_run_cleanup` atualizados — `main()`
agora **retorna** o código, não levanta `SystemExit`).

**Notificação ao representante (CC) — só batch:** ao fim do `run.py`, as falhas **definitivas**
(`DEFINITIVE_ERROR_TYPES`: email_ausente/email_invalido/smtp_bloqueio — exigem ação humana) são
agrupadas por **CC** (representante do título, `CV_EMAIL` do Firebird) e cada CC recebe **um
resumo** (`failure_notify`) com cliente/título/vencimento/valor/motivo dos seus títulos que
falharam. Transitórias (`smtp_falha`/timeout) **não** notificam (re-tentam sozinhas). Falha sem
CC não tem para quem notificar (logada). `send_and_log` retorna **`SendResult`** (status +
error_type + motivo) para o `run.py` filtrar as definitivas sem reclassificar. Envio best-effort
(falha na notificação não derruba o run) e reusa a `SmtpSession` do lote (respeita DEV_MODE). O
reenvio manual (`resend.py`) **não** notifica (o usuário já vê os erros na tela).

**`.env` (raiz):** `FB_HOST/FB_PORT/FB_DATABASE/FB_USER/FB_PASSWORD/FB_CHARSET`;
**SMTP transacional Locaweb** (ATIVO desde 2026-06-25) — `SMTP_HOST=smtplw.com.br` ·
`SMTP_PORT=587` · `SMTP_USER=otimotex1` (usuário do PAINEL, não o e-mail) · `SMTP_PASSWORD=<token>`
(prioridade sobre `IMAP_*` em `_load_smtp_config`; sem o bloco, cai no fallback IMAP
`email-ssl.com.br`); `DEV_MODE=true` + `DEV_OVERRIDE_EMAIL` (To de teste) + `DEV_OVERRIDE_CC_EMAIL`
(Cc de teste); `COBRANCA_SEND_DELAY_SECONDS` (throttle anti-bloqueio Locaweb, default 10s, `0`
desliga). Em **DEV_MODE** todos os envios vão para as caixas de teste (To→`DEV_OVERRIDE_EMAIL`,
Cc→`DEV_OVERRIDE_CC_EMAIL`); em produção, To/Cc reais do Firebird. **Em produção desde 2026-06-22
(`DEV_MODE=false`): envia para os clientes reais (To/Cc do Firebird).** As variáveis
`DEV_OVERRIDE_*` ficam **comentadas** no `.env` (desativadas) — para um teste pontual, defina
`DEV_MODE=true` e descomente ambas. Spec completa: `skills/cobranca-vencidos/references/env_reference.md`.

**Entregabilidade (DNS, fora do código):** SPF ✅ (`include:_spf.locaweb.com.br`); DMARC ⚠️
`p=none`; **DKIM ❌ a configurar** no painel Locaweb (melhora caixa-de-entrada em Gmail/Outlook).
O envio **funciona** sem DKIM (SPF já autentica); é melhoria, não pré-requisito.

**Reenvio manual de falhas (tela `/cobranca/erros`):** o usuário **seleciona** linhas de erro
(1 ou em lote) e reenvia **sem depender do Firebird** — `resend.py` (`resend_erros(ids)`)
reconstrói o e-mail a partir dos campos **já gravados** em `cobranca_erros_log` (via
`fetch_erro_rows`) e reusa `send_core.send_and_log` (mesma dedup, throttle e classificação de
erro do batch). Teto `MAX_IDS=500`; throttle `COBRANCA_SEND_DELAY_SECONDS` (default **10s** no
reenvio — ver memória `cobranca-smtp-bottleneck`) só **entre envios reais** (não após skip/
no_email nem após o último). Status por título (consumido pela UI): `sent` (enviado agora) ·
`skipped` (já em `cobranca_envios_log` — dedup, **não** reenvia) · `no_email` (sem e-mail/
inválido → novo registro de erro) · `error` (falha SMTP → novo registro).

**Endpoints Flask (assíncronos, **um job por vez** — dict + lock em `server/app.py`):**
`GET /api/cobranca/resend/health` (prontidão: `resend_ready()` checa Supabase + SMTP/IMAP +
DEV_MODE/override → a UI **desabilita o botão** quando `ready=false`, com o motivo no `title`) ·
`POST /api/cobranca/resend/start` (dispara em **thread**, responde na hora) ·
`GET /api/cobranca/resend/progress` (poll do progresso).

**Guarda CSRF dos endpoints de DISPARO (segurança §4 M-1 — não regredir):** os POST que
disparam leitura (`/api/emails/read`, `/api/emails/read/start`) e reenvio
(`/api/cobranca/resend/start`) passam por `_reject_trigger_request` (`server/app.py`): exigem
`Content-Type: application/json` (→ `415` caso contrário, quebrando o CSRF "simples" do
navegador) e, se `FLASK_TRIGGER_TOKEN` estiver no `.env`, o header `X-Trigger-Token` (→ `401`).
O frontend e a ponte Next já enviam `application/json`. A barreira primária continua sendo o
bind em `127.0.0.1`; isto é defesa em profundidade para quando o Flask for exposto numa VM.
Teste: `tests/test_flask_csrf_guard.py`.

**Frontend:** rotas lazy `/cobranca/envios` e `/cobranca/erros` (`App.tsx`), páginas
`pages/cobranca/CobrancaEnvios.tsx` + `CobrancaErros.tsx` sobre o **`DataGrid` do projeto**
(colunas em `cobrancaColumns.ts` no `ColumnDef<T>` de `useGridColumns`, **não** o do TanStack),
serviço `services/cobrancaService.ts` (REST direto, paginado; + `startResend`/`getResendProgress`/
health do reenvio), tipos `types/cobranca.ts` (`ErrorType` + `ERROR_TYPE_LABEL` — **não** ficam
em `@sheild/shared`). O grid de `/cobranca/erros` liga **seleção** + a ação
`organisms/ResendErrosAction.tsx` (botão "Reenviar e-mails (N)" na barra de seleção;
**confirmação inline** antes de disparar — são e-mails reais; poll de progresso a cada 1,5s;
**desabilitado** quando o backend não está pronto). Sidebar: grupo **Envios**. **Ordenação
padrão de `/cobranca/envios`: `sent_at` desc** (data de envio, mais recentes no topo) — o ciclo
de clique no cabeçalho volta a esse padrão no 3º clique.

## Pipeline de backup do Supabase (skill `backup-supabase`)

Terceiro pipeline (infra) — **backup diário e automático do Supabase**, independente do
Flask/Next (mesmo padrão de `email-reader`/`cobranca-vencidos`). **Em produção desde
2026-07-03** (`C:\Sheild\API\Pagamentos`, tarefa "Pagamentos - Backup Supabase" na pasta
`\Sheild\` do Agendador, 02:00 diário; 1º backup real: 381 arquivos / ~52 MB, exit 0).

```
Windows Task Scheduler (02:00 diário)
        │
        ▼
scheduler/run_backup.ps1  ──►  skills/backup-supabase/scripts/run.py
        │
        ├── pg_dump (subprocess, native exe) ──► Supabase Postgres (SUPABASE_DB_URL)
        │       └── backups/<ts>/db/db_postgres_public.dump   (formato custom, pg_restore)
        │
        ├── Storage REST (urllib) ──► bucket attachments (SUPABASE_SERVICE_KEY)
        │       └── backups/<ts>/storage/attachments/<arquivos>
        │
        ├── backups/<ts>/manifest.json   (resumo: contagens, tamanhos, versões, status)
        └── retenção: remove backups/<ts> além de BACKUP_RETENTION_DAYS dias (padrão 30)
```

**Estrutura** (`skills/backup-supabase/`): `scripts/run.py` (entry-point/orquestrador —
Task Scheduler aponta aqui) + `config.py` (.env, caminhos, **detecção do `pg_dump`**) +
`backup_db.py` (`pg_dump`; senha via `PGPASSWORD`, **fora do argv/log**) + `backup_storage.py`
(list + download do bucket via `urllib`, item que falha é NÃO-fatal) + `retention.py` (remove
backups > N dias, só pastas com nome de carimbo `YYYY-MM-DD_HHMMSS`). Docs em `SKILL.md` +
`references/env_reference.md`. Wrappers `scheduler/run_backup.ps1` + `setup-backup-task.ps1`.

**Pontos NÃO óbvios (não regredir):**
- **`pg_dump` ≥ 17 é requisito externo** (servidor é PG 17). `config.find_pg_dump` procura
  `PG_DUMP_PATH` no `.env` → PATH → `C:\Program Files\PostgreSQL\*\bin\pg_dump.exe` → pgAdmin
  (`...\pgAdmin 4\runtime\pg_dump.exe`, **com e sem** subpasta de versão). Em dev veio do pgAdmin
  standalone (18.2); em produção, do **PostgreSQL 18 completo** (`...\PostgreSQL\18\bin\`).
- **`SUPABASE_DB_URL`** (novo no `.env`) = a **MESMA** connection string do pgAdmin (**Session
  pooler**, IPv4, porta **5432** — a 6543/Transaction NÃO funciona com `pg_dump`). Senha
  **URL-encoded** (`@`→`%40`, etc.); `backup_db._parse_db_url` faz `unquote`. `SUPABASE_URL`/
  `SUPABASE_SERVICE_KEY` (Storage) já existem. Sem dependência Python nova (stdlib + `dotenv`).
- **Backup é COMPLETO todo dia** (re-baixa todo o bucket) — não incremental. Disco ≈
  (dump + Storage) × retenção; baixar `BACKUP_RETENTION_DAYS` se o disco apertar.
- **Exit code**: 0 = OK; ≠ 0 = falha operacional (banco ou Storage) → `run_backup.ps1` marca a
  tarefa vermelha + Event Log (`Pagamentos-Backup`, EventId 1003). Os logs `INFO` do Python saem
  pelo **stderr** (padrão do `logging`), então aparecem sob `--- STDERR ---` no log do wrapper
  **mesmo em sucesso** — não é erro (igual reader/cobrança); o sinal de erro é o exit ≠ 0.
- **Restaurar**: `pg_restore --no-owner --no-privileges --clean --if-exists` do `.dump`; Storage =
  re-upload dos arquivos (o nome do arquivo é a chave do objeto no bucket).

Variáveis do `.env` em `references/env_reference.md`. Deploy em produção: ver "Deploy manual do
Backup do Supabase em produção".

## Pipeline de baixa automática (skill `baixa-automatica`)

Quarto pipeline (reconciliação) — **duas regras independentes** sobre
`financial_account_control`, no mesmo script/tarefa, cada uma isolada da outra (falha
numa não impede a outra de rodar), independente do Flask/Next (mesmo padrão de
`email-reader`/`cobranca-vencidos`/`backup-supabase`).

### Regra 1 — Baixa (marca como `pago`)

**Regra de negócio (fonte única):** uma conta em `financial_account_control` vira `pago`
(`status_id = 8`) quando **todas** valem: `has_invoice = true` **e** `has_bank_slip = true`
**e** `due_date <= hoje` (data local) **e** `status_id ∈ {1,2,3}` (pendente/vencido/a vencer —
**em aberto**). Situações **fechadas** (cancelado/baixado/protestado/cartório/prorrogado/já
pago) são **preservadas** — nunca reabre nem sobrescreve. A regra **não** reverte (desmarcar
NF/BOL depois não desfaz o `pago`). Funções: `build_filter`/`count_eligible`/`apply_baixa`.

**Duas instâncias da MESMA regra:**
1. **No ato da edição (`/consulta`, frontend):** `qualifiesForAutoPago` +
   `handleToggleFlag` em `Consulta.tsx` — ao marcar a 2ª flag (NF/BOL) de uma conta vencida
   e em aberto, grava `status_id = 8` na hora (best-effort; ver "Baixa automática no ATO da
   edição" na seção de RLS/grants).
2. **Batch diário (esta skill):** cobre as contas cujo `due_date` "passa" com o tempo sem
   nenhuma edição disparar a baixa.

### Regra 2 — Marcação de vencidos (marca como `vencido`)

**Regra de negócio:** uma conta em `financial_account_control` **EM ABERTO**
(`status_id ∈ {1,3}` — pendente/a vencer; **não** inclui 2=vencido, já é o alvo) cujo
vencimento é **ANTERIOR** a hoje (`due_date < hoje`, **estritamente** menor — quem vence
HOJE ainda está "a vencer") vira `vencido` (`status_id = 2`). Situações **fechadas** são
preservadas; a regra **não** reverte. Mesma semântica da trigger `fn_set_status_from_due_date`
(`due_date < ref_date → vencido`). Funções:
`build_filter_vencido`/`count_eligible_vencido`/`apply_vencido`. Adicionada em 2026-07-23
a pedido do usuário, **dentro** desta skill (não como skill nova nem dentro de
`cobranca-vencidos` — que é outro domínio, contas a RECEBER via Firebird).

### Por que as duas regras existem (motivo estrutural comum)

A trigger `fn_set_status_from_due_date` só recalcula `status_id` por vencimento em
**INSERT/UPDATE** da linha — sem nenhuma edição, uma conta que era "a vencer"/"pendente"
ontem **não** transiciona sozinha hoje (nem para pago, nem para vencido). Este batch cobre
essa lacuna para as duas transições. Roda **1x/dia às 08:00** na máquina de produção
(`scheduler/run_baixa.ps1`).

**Mecânica (`skills/baixa-automatica/scripts/run.py`):** cada regra faz um único
`PATCH /rest/v1/financial_account_control` filtrado com seu próprio status alvo (`{status_id:
8}` ou `{status_id: 2}`), escrita via **`SUPABASE_SERVICE_KEY`** (service_role ignora RLS).
Setar `status_id=8` (Regra 1) é seguro incondicionalmente — `8` **não** está em `{1,2,3}`, a
trigger nem entra no ramo de recálculo. **Setar `status_id=2` (Regra 2) SÓ é seguro DEPOIS da
correção da migration `095`** (ver bloco abaixo) — `2` **está** em `{1,2,3}`, então a trigger
recalcula por vencimento a cada UPDATE; antes da `095` ela usava uma data de referência
congelada e revertia o UPDATE de volta para `3` na prática. `main()` roda as duas em sequência,
cada uma no seu próprio try/except
(`_run_baixa_step`/`_run_vencido_step`) — **isoladas**: falha numa não impede a outra; exit
code `1` se **qualquer uma** falhar, mas a que teve sucesso já gravou (sem rollback cruzado,
não é uma transação). `--dry-run` faz um `GET` com `Prefer: count=exact` **por regra** e
reporta os dois totais, sem gravar. **Sem dependência Python nova** — `urllib` (stdlib) +
`python-dotenv`. Exit code `0` = as duas com sucesso; `≠ 0` = falha em ao menos uma → o
wrapper marca a tarefa vermelha + Event Log. `.env`: reusa `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`
(já presentes para o reader). Teste: `tests/test_baixa_automatica.py` (os dois construtores de
filtro, ids/status alvo de cada regra, independência entre elas, isolamento de falha entre as
etapas). **Isolamento do teste (não regredir):** o teste carrega o `run.py` via `importlib`
com nome de módulo ÚNICO (`baixa_automatica_run`), **não** `import run` via `sys.path` —
várias skills têm `run.py` (`cobranca-vencidos`, `backup-supabase`), e importar o nome `run`
colidiria em `sys.modules`, poluindo a suíte (quebrava os testes da cobrança). **Nenhum passo de
banco** (colunas e grants já existem — migrations 033/068).

**Backfill inicial aplicado (2026-07-10, só Regra 1):** a 1ª execução real do batch marcou
**15 contas** que já se enquadravam na regra de baixa (NF + Boleto + vencidas + em aberto)
como `pago`; o `--dry-run` seguinte reportou `0` (idempotente). Como dev e produção
compartilham a **mesma Supabase**, as 15 baixas já valem para os dois ambientes — não repetir
a aplicação após o deploy dos scripts.

**Trigger de situação por vencimento usava a data de EXTRAÇÃO, não a data de HOJE — bug de
fundação corrigido pela migration `095` (2026-07-23, não regredir):** a Regra 2 (vencidos) foi
implantada em produção e rodou nas execuções agendadas de 2026-07-23 (06:00 e 08:00 —
`Marcacao de vencidos concluida: 126 titulo(s) marcados como 'vencido'`), mas o grid de
`/consulta` seguia mostrando a maioria delas como **"a vencer"**. Causa raiz: a trigger
`fn_set_status_from_due_date` (criada na migration `034`, 2026-06-18, e mantida assim pelas
`067`/`068`/`069`) calculava `ref_date := COALESCE(NEW.extracted_at, NOW())` — a data em que a
conta foi **extraída** (congelada), não a data atual. Como a Regra 2 grava `status_id=2` via
`PATCH`, e `2` está no conjunto `{1,2,3}` que a trigger BEFORE UPDATE recalcula, ela reavaliava
`due_date >= ref_date` usando o `extracted_at` congelado — quase sempre **anterior** ao
vencimento (a conta é extraída ANTES de vencer) — e revertia o `UPDATE` de volta para `status_id
= 3` ("a vencer"), **na mesma transação**, silenciosamente. O `PATCH` "funcionava" (o filtro
`WHERE` batia 126 linhas e a resposta HTTP era 200), mas o valor final persistido era decidido
pela trigger, não pelo corpo do request. **Medido antes do fix:** das 123 contas que deveriam
estar `vencido` (`status_id ∈ {1,3}` E `due_date < hoje`), só **3** realmente persistiam assim —
exatamente as que tinham `due_date < extracted_at` (vencimento corrigido manualmente para uma
data anterior à extração; único caso em que o cálculo antigo, por coincidência, batia com "hoje").

Este **não é um bug exclusivo da skill `baixa-automatica`** — é um bug de fundação da trigger,
presente desde a `034`: **qualquer** `UPDATE` numa conta "em aberto" feito depois do vencimento
já ter passado (ex.: a curadoria de NF/Boleto em `/consulta`, que não toca `status_id` mas ainda
assim dispara a trigger) recalculava contra a data de extração congelada e nunca corrigia para
`vencido`. Só passou despercebido porque, até a Regra 2 existir, nada tentava setar
`status_id=2` explicitamente em massa — o efeito prático (contas vencidas presas em "a vencer")
sempre existiu, só não tinha sido notado/medido.

**Fix (`095_fix_status_trigger_reference_date.sql`, idempotente — `CREATE OR REPLACE FUNCTION`):**
`ref_date` passa a ser `(NOW() AT TIME ZONE 'America/Sao_Paulo')::date` — a data ATUAL a cada
disparo da trigger, nunca mais `extracted_at`. Sem efeito colateral no `INSERT` (`extracted_at` ≈
`NOW()` no momento da extração — resultado idêntico); no `UPDATE`, agora reavalia corretamente
contra "hoje", inclusive quando disparado por uma curadoria que não toca `status_id`. Regra 1
(`status_id=8`) e as demais transições fechadas continuam intocadas — `8`/`9`/etc. não estão em
`{1,2,3}`, a trigger nem entra no ramo de recálculo. **Correção retroativa aplicada no mesmo
momento** (SQL direto, mesma Supabase dev+prod): as 123 contas mal-classificadas foram
corrigidas (`UPDATE ... SET status_id = 2 WHERE status_id IN (1,3) AND due_date < CURRENT_DATE`)
— **verificado**: `126` contas em `vencido` após a correção (as 3 antigas + as 123 corrigidas),
`0` restantes fora de conformidade. **A partir de agora, a Regra 2 do batch diário funciona
como documentado** (o `PATCH status_id=2` não é mais revertido pela trigger) — a correção
retroativa foi só para não esperar a próxima execução agendada (08:00 do dia seguinte).

```powershell
py -3 skills\baixa-automatica\scripts\run.py --dry-run   # quantas contas/títulos SERIAM afetados pelas 2 regras (não grava)
py -3 skills\baixa-automatica\scripts\run.py             # aplica as duas regras
```

## Windows Task Scheduler

Quatro tarefas agendadas na pasta `\Sheild\` do Agendador (produção
`C:\Sheild\API\Pagamentos`): **Email Reader** (leitura, 5 min), **Cobrança Vencidos**
(envios, 08:00), **Backup Supabase** (02:00 diário — ver seção acima) e **Baixa Automática**
(reconciliação de pagos + marcação de vencidos, 08:00 diário — ver "Pipeline de baixa
automática"). **Cobrança Vencidos e Baixa Automática coincidem no horário (08:00)** — são
tarefas independentes (scripts, tabelas e sistemas distintos: Firebird+SMTP vs. Supabase
REST), sem recurso compartilhado, então rodam em paralelo sem conflito.

> **QUINTA tarefa — *Pagamentos - Gatilhos Roadmap*** (skill **`roadmap-gatilhos`**,
> `scheduler/setup-gatilhos-task.ps1`): mede mensalmente (dia 1, 07:00) os 7 gatilhos condicionais
> da Onda 9 e grava a série em `analytics.roadmap_trigger_snapshot` (migration 122). **Roda em
> produção**, como as outras quatro — decisão do dono do produto em 2026-08-13 (antes rodava só no
> dev), então ela está nos **`DEPLOY_GLOBS`** e o manifesto passou de 28 para **31 arquivos**.
> ⚠️ **É a única rotina agendada que NÃO faz parte do pipeline financeiro** — não lê e-mail, não
> cobra ninguém, não move dinheiro. Uma falha dela reprova a tarefa e gera Event Log
> (`Pagamentos-Gatilhos`, EventId **1005**) como as demais, mas **sem impacto no negócio**: o
> efeito é a série ficar sem o ponto do mês. Comece a triagem por aí. **Zero dependência nova** —
> `urllib` + `python-dotenv` e as mesmas `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` da
> `baixa-automatica`; não usa `SUPABASE_DB_URL` nem `pg_dump`.
> ⚠️ **Instalada e validada em produção em 2026-08-13** (`LastTaskResult = 0`; próxima execução
> 01/09 07:00), e a série já foi gravada de lá.
>
> 🔴 **É a única tarefa MENSAL, e ela é registrada por XML — não pelos cmdlets (não regredir).**
> `New-ScheduledTaskTrigger` não tem opção mensal (só Once/Daily/Weekly/AtLogon/AtStartup), e
> `-Once -RepetitionInterval 30 dias` seria sutilmente errado (30 dias não é um mês: a medição
> escorrega até cair fora do mês pretendido). **Três defeitos foram pagos para chegar ao XML, e os
> três só apareceram AO REGISTRAR — montar, parsear e validar passavam:**
> 1. **Trigger por CIM (`MSFT_TaskMonthlyTrigger`) NÃO funciona.** O objeto monta sem erro, mas o
>    `Register-ScheduledTask` do PowerShell 7 recusa com **"Parâmetro incorreto"**, sem dizer qual.
> 2. **`<Principal>` vai DENTRO de `<Principals>` (plural), e a ORDEM dos nós é fixa:**
>    `RegistrationInfo → Principals → Settings → Triggers → Actions` — sequência tirada de um
>    `Export-ScheduledTask` **real**, não do XSD publicado. Fora dela: *"o XML contém um nó
>    inesperado"*, que aponta a linha e não a causa. O script hoje **confere a sequência antes de
>    registrar**, para o erro sair explicando o esperado.
> 3. 🔴 **Verificar o TIPO do trigger é falso-positivo garantido.** A checagem original exigia
>    `CimClassName -eq 'MSFT_TaskMonthlyTrigger'` e **reprovou uma tarefa registrada corretamente**:
>    via XML o Agendador expõe o gatilho como `MSFT_TaskTrigger` genérico. Hoje a prova é
>    **`NextRunTime`** — comportamento, não implementação: ele só existe com gatilho ativo, e vale
>    para qualquer forma de registro. *Verificação que acusa defeito onde não há custa mais que
>    verificação nenhuma* — esta mandou remover uma tarefa que estava boa.
>
> ⚠️ **Mensagem de erro não pode culpar o palpite mais comum.** O `catch` do setup dizia "verifique
> se é Administrador" para qualquer falha, e mandou o operador procurar no lugar errado **com a
> janela já elevada**. A elevação é checada no início; daí em diante o erro reporta a causa real.
>
> 🔴 **O `BUDGET_SECONDS` do `run.py` (10 min) e o `ExecutionTimeLimit` da tarefa (15 min) são um
> PAR — mexer num sem o outro quebra a garantia** *(endurecimento de 2026-08-13)*. O pior caso de
> rede (≈15 requisições × 3 tentativas × 30 s de timeout + backoff) passa de 24 min, e quem
> encerraria o processo seria o **Agendador**: sem exit code próprio, sem log de resumo e **sem
> gravar os gatilhos que já tinham sido medidos** — a medição do mês inteiro se perde por causa dos
> últimos. Com o teto no script, ele para sozinho, grava o que apurou e sai 1. A folga de 5 min é
> para a gravação e o encerramento.
> ⚠️ Os temporários do runner são **por processo** (`_stdout_$PID.tmp`): com nome fixo, uma execução
> manual coincidindo com a agendada faz as duas redirecionarem para o MESMO arquivo e a segunda
> morre ao abri-lo. O `MultipleInstancesPolicy=IgnoreNew` protege o Agendador contra si mesmo, não
> contra alguém rodando o runner à mão.
>
> 🔴 **Desde a Onda 10 (2026-08-14), o medidor também compara `fired` com a última medição
> gravada e loga `ERROR` quando muda de estado** — nunca altera o exit code (diagnóstico, não
> falha). Detalhe completo (por quê, o campo `metrics.mudou_desde_ultima_medicao`, a consulta que
> lista toda a história de transições) em `SKILL.md` da skill.

`scheduler/run_reader.ps1` — intervalo de 5 min (`$INTERVAL_MIN` em
`scheduler/setup-task.ps1`). Detecta Python com `pdfplumber` (ordem: `py -3.12`,
`-3.13`, `-3.11`, `-3.10`, `-3`, PATH). Logs em
`logs/scheduler/reader_YYYYMMDD.log`, retidos 30 dias. Instalação em outra
máquina: `scheduler/INSTALL.md` (setup detecta executor `pwsh.exe`/`powershell.exe`
e checa o `.env`).

O backup usa `scheduler/run_backup.ps1` + `setup-backup-task.ps1` (mesmo padrão do runner da
cobrança: detecção de Python, log diário em `logs/backup/`, Event Log em falha). A baixa
automática usa `scheduler/run_baixa.ps1` + `setup-baixa-task.ps1` (log diário em `logs/baixa/`,
Event Log `Pagamentos-Baixa` em falha).

Checkout de **desenvolvimento**: `C:\Sheild\Projetos\Claude\Contas a pagar\Pagamentos`
(branch `Features`, sincronizado com `main`) — clone git completo onde todo o trabalho acontece.

**Produção dos recebimentos (outra máquina):** o scheduler roda de
`C:\Sheild\API\Pagamentos`, um **deploy mínimo** (NÃO é clone git) com apenas o
necessário para o pipeline de leitura: `scheduler\` + `skills\` + `.env` + `data\` +
`logs\`. Não tem `apps\`, `server\`, `supabase\`, `packages\` nem `.git`. Como os
scripts `.ps1` usam caminhos relativos a `$PSScriptRoot`, funcionam nesse caminho sem
ajuste. **Atualizar produção = copiar manualmente** os arquivos alterados (ex.: os 2
scripts de `scheduler\`) — não há `git pull` lá. Requer Python 3.12 + `pdfplumber`
instalados na máquina. Guia: `scheduler/INSTALL.md`.

> **A máquina de PRODUÇÃO fica em OUTRO LOCAL FÍSICO (não regredir):** a máquina de
> desenvolvimento **NÃO enxerga** `C:\Sheild\API\Pagamentos` (o caminho nem existe no
> dev), então **o Claude não consegue copiar arquivos nem validar em produção a partir
> daqui**. Todo deploy do pipeline Python (reader, cobrança, backup, baixa) é feito
> **manualmente NA máquina de produção**, por quem tem acesso a ela. O papel do Claude é
> deixar o fix canônico em `main` (via commit/PR/merge) e **entregar o passo de cópia +
> comando de validação**; a execução em produção é do operador.
>
> **Deploy para produção — use a skill `deploy-producao`** (`.claude/skills/deploy-producao/`).
> Ela tem o procedimento completo: o que copiar, em que ORDEM, o manifesto de paridade, o comando
> de validação e as armadilhas que já quebraram produção (módulo novo importado no topo, manifesto
> esquecido, dependência nova, tarefa do Agendador que não muda de horário sozinha). O que cada
> deploy fez: [docs/deploy/historico-deploys.md](docs/deploy/historico-deploys.md).
>
> 🔴 **A regra que vale SEMPRE, mesmo sem abrir a skill: a máquina de produção fica em OUTRO LOCAL
> FÍSICO e o Claude NUNCA executa nada nela.** `C:\Sheild\API\Pagamentos` não existe no ambiente
> de desenvolvimento; não é clone git (não há `git pull` lá). Toda cópia de arquivo,
> `setup-*-task.ps1`, `pip install` ou reinício de serviço é feita **pelo próprio usuário,
> manualmente** — não tente, não se ofereça para tentar, não simule que foi feito. Seu trabalho
> termina no código correto no repositório e nas instruções copiáveis.
>
> **`scheduler/check_deploy_parity.py`** é a fonte da verdade de "produção está atualizada?" —
> compara o SHA-256 dos arquivos de deploy com o manifesto e sai com **exit 1** em divergência,
> portanto agendável. 🔴 **No DEV, após alterar qualquer script de deploy, regrave o manifesto no
> mesmo commit** (`--update`) — e ele **viaja junto** com os `.py` na cópia.
