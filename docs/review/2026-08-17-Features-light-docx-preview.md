# Code Review — Features / pré-visualização de .docx + alvo de clique do anexo (2026-08-17)

## Resumo
Alvo: nenhum (review do diff completo)
Modo: light (sem passo de ataque, sem verificação adversarial)
Delta: 5 arquivos alterados, 2 novos, +253/−18 linhas (versionado) + 418 linhas nos dois untracked
Régua: `CLAUDE.md` do projeto (Regras 1, 2, 5 e 6), `CLAUDE.md` global (gate de robustez), `docs/padrao-execucao.md`
Gates: frontend-vite **904/904 em 146 arquivos** (`--maxWorkers=1`) · lint 0/0 (4 workspaces) · typecheck OK (4 workspaces) · **prune 2 órfãos (regra do projeto exige 0)** · pytest não executado (delta não toca Python) · e2e não executado (exige navegador; sandbox derruba o renderer)

O delta faz duas coisas independentes: (1) `AttachmentViewer` deixa de mostrar "pré-visualização
não disponível" para `.docx` e passa a abrir o ZIP no próprio navegador (`lib/docxPreview.ts`,
novo, sem dependência nova) exibindo a maior imagem embutida; (2) `AttachmentList` move o alvo
de clique para o **nome** do arquivo, corrigindo o relato de anexo "visível mas não clicável" no
`<td colSpan>` de `/consulta`. A engenharia está sólida — fixture de ZIP real byte a byte, tetos
contra zip bomb, `aria-hidden` no controle duplicado, contagem de testes do `CLAUDE.md` conferida
e **batendo exatamente** (885 + 19 = 904). Os achados são de acabamento: uma regressão de tooltip,
uma falha de rede que se disfarça de "documento sem imagem", um teto declarado e não aplicado num
ramo, e a régua do `prune`.

## Achados

### 🔴 Bloqueantes
Nenhum.

### 🟡 Recomendados

- [apps/frontend-vite/src/components/molecules/AttachmentList.tsx:79] O `title={item.name}` foi
  perdido no ramo com `onView`, então o nome truncado deixou de ser legível no hover.
  Falha:     anexo `manual/512/20260715T120000Z_a1b2c3d4_Boleto Fornecedor XYZ Julho.pdf` na lista
             estreita do painel de detalhe → o texto trunca com reticências e o hover passa a
             mostrar **"Ver o anexo"** (o `title` do novo `<button>`) em vez do nome completo, que
             era o que o `<span>` mostrava antes. Quem usa mouse perde a única forma de ler o nome
             inteiro; o ramo `else` (fila de pendentes, sem `onView`) manteve o `title` — ou seja,
             a perda atinge exatamente o caso principal.
  Evidência: diff — antes `<span … title={item.name}>`; depois o `<span>` dentro do botão não tem
             `title`, e o botão traz `title="Ver o anexo"`. O `else` em :86 preserva `title={item.name}`.
  Correção:  devolver `title={item.name}` ao `<span>` interno do botão (o `title` do botão continua
             valendo sobre o ícone).
  Regra:     regressão de comportamento existente — `docs/padrao-execucao.md`, "verificar regressão".

- [apps/frontend-vite/src/components/AttachmentViewer.tsx:116] O `fetch` da signed URL não checa
  `response.ok`, e o erro do Storage vira a mensagem "documento sem imagem".
  Falha:     a signed URL expira (TTL de 300 s — o modal fica aberto 5 min) ou o Storage devolve
             403/404 → **`fetch` NÃO lança** nesse caso; `arrayBuffer()` entrega o corpo XML de erro,
             `extractLargestDocxImage` não acha EOCD e devolve `null` pelo caminho normal (sem passar
             pelo `catch`) → a tela afirma *"Documento do Word (.docx) sem imagem para pré-visualizar"*.
             O usuário lê um fato sobre o documento quando o que houve foi falha de download, e o
             operador não tem nada no console para distinguir os dois.
  Evidência: `const bytes = await (await fetch(url)).arrayBuffer();` — sem checagem de status; o
             `catch {}` de :123 está vazio, sem log.
  Correção:  checar `res.ok` antes do `arrayBuffer()` e emitir `console.error` no `catch` (o padrão
             de `warnIfCachingDisabled`); estado de erro de download distinto da ausência de imagem
             seria desejável, mas exige decisão de UI — a checagem + log é o mínimo.
  Regra:     `CLAUDE.md` global, "nunca silenciar erro (sem `catch` vazio engolindo falha)"; e o
             precedente registrado no `CLAUDE.md` do projeto — *"Erro de código NÃO se disfarça de
             'link inacessível'"* (`_fetch_url`).

- [apps/frontend-vite/src/lib/docxPreview.ts:119] O ramo `METHOD_STORED` devolve os bytes sem
  aplicar `DOCX_MAX_IMAGE_BYTES`, apoiando-se no tamanho **declarado** — que o próprio arquivo
  comenta poder mentir.
  Falha:     `.docx` de 24 MB com uma entrada `word/media/x.png` **stored** declarando
             `uncompressedSize = 1000` → passa no filtro de :182 (que lê o valor declarado) e
             `readEntry` retorna a view inteira de 24 MB, o dobro do teto de 12 MB que o módulo
             declara como defesa. Contido pelo `DOCX_MAX_BYTES` de 25 MB, então não amplifica —
             mas a garantia enunciada no cabeçalho ("tetos de tamanho … contra zip bomb") não vale
             nesse ramo.
  Evidência: :119 `if (entry.method === METHOD_STORED) return raw;` — sem teto; o comentário de
             :154 ("o teto já foi aplicado acima, sobre os bytes REAIS") descreve só o ramo deflate.
  Correção:  `if (entry.method === METHOD_STORED) return raw.byteLength > DOCX_MAX_IMAGE_BYTES ? null : raw;`
  Regra:     `CLAUDE.md` Regra 2 — garantia enunciada tem de ser entregue; e o próprio cabeçalho do
             módulo, que lista os tetos como a defesa contra conteúdo de remetente não confiável.

- [apps/frontend-vite/src/lib/docxPreview.ts:24] `npm run prune` passou a reportar 2 exports órfãos
  (`DOCX_MAX_BYTES`, `DocxImage`), e a régua do projeto exige 0.
  Falha:     o gate `prune` da raiz — declarado no `CLAUDE.md` Regra 5 como "deve reportar 0" —
             ficou com duas linhas por causa deste delta; ele não tem exit code próprio, então a
             violação é silenciosa e o próximo review a herda como ruído de baseline. O caso de
             `DOCX_MAX_BYTES` é o mais informativo: ele é órfão **porque nenhum teste o importa**,
             isto é, o teto do arquivo inteiro é a única das três defesas sem caso próprio (os
             outros dois têm — `DOCX_MAX_IMAGE_BYTES` e `DOCX_MAX_ENTRIES`).
  Evidência: `npm run prune` → `\src\lib\docxPreview.ts:24 - DOCX_MAX_BYTES (used in module)` e
             `:165 - DocxImage (used in module)`; nenhum outro workspace reporta linha.
  Correção:  acrescentar o caso de teto do arquivo inteiro em `docxPreview.test.ts` (importando
             `DOCX_MAX_BYTES`, o que fecha a lacuna e o órfão de uma vez) e marcar `DocxImage` com
             `// ts-prune-ignore-next` — é o tipo de retorno da função pública, export intencional,
             exatamente o caso que a Regra 5 manda anotar.
  Regra:     `CLAUDE.md` Regra 5 — "`npm run prune` … deve reportar 0"; export intencional sem
             consumidor leva `// ts-prune-ignore-next`.

- [apps/frontend-vite/src/components/AttachmentViewer.a11y.test.tsx:13] Os três estados novos do
  viewer (`.docx` extraindo · com imagem · sem imagem) não passam pelo axe.
  Falha:     o estado "com imagem" é o único do componente que renderiza um `<img>` — o elemento
             mais sujeito a violação de a11y — e a varredura só cobre `ok` (PDF), `notfound` e o
             nome do dialog. Uma regressão no `alt` (ou um `alt=""` acidental, que tornaria o
             conteúdo invisível ao leitor de tela) não seria pega por nenhum gate: o teste funcional
             asserta o `alt` com um regex de nome de arquivo, o que não é a mesma cobertura.
  Evidência: `AttachmentViewer.a11y.test.tsx` tem 3 casos, todos com `sourceFile` `.pdf`;
             `container.querySelector('img')` só aparece em `AttachmentViewer.test.tsx`.
  Correção:  um `it` a mais no arquivo a11y renderizando `sourceFile="boleto.docx"` com
             `extractLargestDocxImage` mockado, esperando a `<img>` e rodando `axe(container)`.
  Regra:     `CLAUDE.md` Regra 6 — "todo componente/página relevante ganha um `*.a11y.test.tsx`";
             e o padrão já estabelecido de varrer **estado que muda a árvore acessível**
             (`DashboardHeader.a11y.test.tsx`, os `PageState` do e2e).

- [apps/frontend-vite/src/lib/docxPreview.ts:191] Comentário descreve um `buffer as ArrayBuffer`
  que não existe no código.
  Falha:     a linha imediatamente abaixo é `const copia = bytes.slice();` — o comentário sobrou de
             uma versão anterior e explica uma decisão (cast de `SharedArrayBuffer`) que foi
             substituída por outra (cópia dos bytes). Quem for mexer ali lê a justificativa errada
             e pode "simplificar" a cópia de volta para um cast, reintroduzindo a retenção do buffer
             inteiro do `.docx` dentro do Blob.
  Evidência: :191-192 — `// \`buffer as ArrayBuffer\`: …` seguido de `const copia = bytes.slice();`.
  Correção:  reescrever o comentário para o que a linha faz: copiar os bytes para o Blob não reter
             a view sobre o ArrayBuffer do arquivo inteiro.

### 🔵 Opcionais

- [apps/frontend-vite/src/components/AttachmentViewer.test.tsx:118] `vi.stubGlobal('fetch', …)` e os
  dois `Object.defineProperty(URL, …)` não são revertidos; o `describe` é o último do arquivo hoje,
  mas um caso acrescentado depois dele herdaria os stubs.
- [apps/frontend-vite/src/components/molecules/AttachmentList.tsx:79] `hover:underline` está no
  `<span>`, não no botão — o sublinhado não aparece quando o mouse está sobre o ícone.
- [apps/frontend-vite/src/lib/docxPreview.ts:183] A ordenação usa o `uncompressedSize` **declarado**;
  um índice mentiroso escolhe a imagem errada (sem impacto de segurança, só de resultado).
- [apps/frontend-vite/src/components/AttachmentViewer.tsx:116] O `fetch` não usa `AbortController`;
  ao desmontar durante o download o request segue até o fim (o guard `active` já impede o setState).

## Pendências (trabalho incompleto)
- [apps/frontend-vite/src/lib/docxPreview.ts:24] Teto `DOCX_MAX_BYTES` sem caso de teste — as
  outras duas defesas têm — recomendada (mesma correção do achado de `prune`).
- [apps/frontend-vite/src/components/AttachmentViewer.tsx:110] O caminho `.docx` nunca foi
  exercitado em navegador real: `DecompressionStream('deflate-raw')` e `URL.createObjectURL` são
  stubs no jsdom, e a camada e2e não roda no sandbox — recomendada (validar na máquina do usuário
  com um dos 3 `.docx` reais do TJSP).
- Nenhum marcador `TODO`/`FIXME`/`HACK`/`WIP`, stub ou teste pulado no delta (varredura sobre o
  diff versionado **e** os dois untracked).

## Drift código × documentação
- Nenhum. O `CLAUDE.md` foi atualizado no mesmo diff, substituiu o trecho obsoleto em vez de
  empilhar, e os números conferem contra a medição: frontend-vite **904 em 146 arquivos** (declarado
  904/146), `docxPreview.test.ts` com **11** casos e `AttachmentViewer.test.tsx` com **5** novos
  (declarado 11 + 5), `AttachmentList.test.tsx` com **3** (declarado 3) — 885 + 19 = 904. ⚠️ O único
  ponto a rever depois do fix: o `CLAUDE.md` afirma "tetos de tamanho/entradas" como defesa herdada
  do Python, e o ramo STORED escapa do teto de imagem (achado acima) — a afirmação passa a ser
  verdadeira com a correção aplicada.

## Não coberto
- **SonarCloud não consultado** (não há PR aberto para este delta). Observação: o bloco
  `<Icon/><span>{item.name}</span>` e o handler `stopPropagation → onView` ficaram duplicados nos
  dois ramos de `AttachmentList`; são ~4 linhas por bloco, abaixo do que costuma disparar o detector
  de duplicação, mas o gate julga só código novo e o limiar é 3%.
- **Camada e2e/axe em navegador não executada** — o renderer do Chromium crasha no sandbox do
  agente (limitação registrada no `CLAUDE.md`). É justamente onde `DecompressionStream` e o
  `<dialog open>` existem de verdade.
- **Suíte Python (1.428 casos) não executada** — o delta não toca `skills/`, `server/` nem
  `scripts/`; nenhum arquivo de deploy mudou, então `check_deploy_parity` segue em 32/32.
- **Não medi baseline pré-delta.** Os dois arquivos com órfão de `prune` são novos, e nenhum outro
  workspace reporta linha, o que já atribui a violação ao delta sem precisar de worktree.
- **Superfície adjacente verificada e limpa:** os 2 call sites de `AttachmentViewer`
  (`Emails.tsx:662`, `ContaAttachments.tsx:200`) montam o componente condicionalmente, e o
  `showModal()` torna o fundo inerte — então `sourceFile` não muda com o componente montado, e a
  ausência de reset de `docxImage`/`docxDone` entre anexos é inalcançável. O `AttachmentList` já é
  varrido pelo axe indiretamente, via `ContaAttachments.a11y.test.tsx`, que renderiza a lista real
  (verde com o botão novo).

---

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| R1 | `title={item.name}` perdido no ramo com `onView` | ✅ corrigido | `AttachmentList.tsx:79` — `title` devolvido ao `<span>`; guarda nova em `AttachmentList.test.tsx` ("o nome truncado continua legível no hover"), **mutante M4** (remover o `title`) → vermelho |
| R2 | `fetch` sem checar `response.ok` — erro de download vira "documento sem imagem", sem rastro | ✅ corrigido | `AttachmentViewer.tsx:116` — `if (!res.ok) throw` + `console.error` no `catch`; guarda nova ("HTTP de erro no download NÃO é tratado como ZIP, e deixa rastro"), **mutante M3** → vermelho. Os mocks de `fetch` dos testes existentes ganharam `ok`/`status` (o contrato mudou) |
| R3 | Ramo `METHOD_STORED` sem o teto real de imagem | ✅ corrigido | `docxPreview.ts:119` — teto aplicado sobre `raw.byteLength`; guarda nova ("recusa mídia STORED grande que MENTE o tamanho no índice"), **mutante M2** → vermelho |
| R4 | `prune` com 2 órfãos (régua exige 0) | ✅ corrigido | `DOCX_MAX_BYTES` deixou de ser órfão porque ganhou **teste** (fecha também a lacuna: era o único dos 3 tetos sem caso), **mutante M1** → vermelho; `DocxImage` recebeu `// ts-prune-ignore-next`. ⚠️ Na 1ª tentativa o marcador ficou 2 linhas acima do export e **não teve efeito** — ele só vale na linha imediatamente anterior (padrão conferido em `api-backend/lib/response.ts`). `npm run prune` = **0** |
| R5 | Estados `.docx` não passam pelo axe | ❌ **retirado** | A premissa estava errada, e a medição inverteu a conclusão — ver abaixo |
| R6 | Comentário descreve um `buffer as ArrayBuffer` que não existe | ✅ corrigido | `docxPreview.ts:191` — comentário reescrito para o que a linha faz (a cópia evita reter o ArrayBuffer do `.docx` inteiro no Blob, que é justamente o que o ramo STORED devolve) |

### Por que R5 foi retirado (e o que a medição revelou)

O achado dizia que uma regressão no `alt` da imagem não seria pega por nenhum gate. **Os dois
lados da afirmação são falsos, e cada um foi medido por mutante:**

1. **O teste funcional JÁ cobre o `alt`.** Mutante `alt=""` → `AttachmentViewer.test.tsx` fica
   **vermelho** ("exibe a imagem embutida quando o .docx tem uma", que casa o `alt` contra o nome).
2. **O teste a11y que eu havia escrito não cobriria nada.** Com `alt=""` **e** com o atributo `alt`
   **removido por inteiro**, a varredura seguia com **5 passed**. Sonda isolada (`<img>` sem alt,
   fora e dentro de `<dialog open>`, medida e depois apagada):

   | contexto | violações do axe |
   |---|---|
   | `<div><img src></div>` | **1** (`image-alt`) |
   | `<dialog open><img src></dialog>` | **0** |

   Ou seja: **em jsdom o axe não reporta violação alguma dentro de um `<dialog>`** — com ou sem o
   atributo `open`. Acrescentar o `it` teria criado exatamente o que a Regra 2 proíbe: um verde que
   faz parar de olhar. A tentativa de salvá-lo abrindo o dialog à mão (`setAttribute('open','')`)
   foi medida e **também não funcionou**; o arquivo foi restaurado ao estado original.

**Achado novo que isso expõe — PRÉ-EXISTENTE e FORA do delta, portanto não corrigido:** os casos
de `AttachmentViewer.a11y.test.tsx` que fazem `expect(await axe(container)).toHaveNoViolations()`
(e, pela mesma mecânica, qualquer outro `*.a11y.test.tsx` cujo conteúdo viva dentro de um
`<dialog>` — `AiChatPanel`, `ExpenseDetailModal`) estão **verdes sem varrer nada**. A cobertura
real desses modais é a camada e2e em navegador, onde o `showModal()` existe de verdade. Corrigir
isso é trabalho próprio: exigiria um helper de varredura que remova o conteúdo do dialog para um
container solto antes do axe, e vale reavaliar todos os arquivos afetados de uma vez.

Gates após a correção: **frontend-vite 908 (+4) em 146 arquivos** · lint 0/0 (4 workspaces) · typecheck OK (4 workspaces) · **prune 0 (era 2)**
Baseline (Passo 3):    frontend-vite 904 em 146 arquivos · lint 0/0 · typecheck OK · prune 2 órfãos
Re-review do diff da correção: **sem achado novo** — nenhum caminho de erro engolido (o `catch` passou a logar), nenhuma assinatura quebrada (`readEntry` já podia devolver `null` e o chamador trata), nenhuma regra duplicada (o teto reusa a constante), e os 4 testes novos foram validados por mutante em execução **isolada e em série**, com reversão confirmada por `diff -q` em cada um.

Não corrigido por decisão sua:
- **`CLAUDE.md` desatualizado pela própria correção** — ele declara `frontend-vite 904 em 146 arquivos` / `1.579 no Node`, e agora são **908** / **1.583** (+4: 2 tetos em `docxPreview.test.ts`, 1 de `res.ok`, 1 de `title`). Doc de estado não é tocado pelo review (apagaria a evidência); a atualização é sua.
- **Os 4 achados 🔵 opcionais** (stubs de teste não revertidos, `hover:underline` no span, ordenação pelo tamanho declarado, `AbortController` ausente).
- **A cobertura a11y vazia dos modais** — pré-existente e fora do delta (acima).
- **Validação em navegador real** do caminho `.docx` — `DecompressionStream` e `URL.createObjectURL` são stubs no jsdom, e o e2e não roda no sandbox.

Nada foi commitado.
