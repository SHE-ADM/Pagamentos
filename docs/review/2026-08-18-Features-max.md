# Code Review — Features (2026-08-18)

## Resumo

**Alvo:** `CLAUDE.md` — o próprio arquivo reestruturado é a régua e o objeto do trabalho. Não há
documento de plano separado; a referência de pendências foi o contrato que o `CLAUDE.md` novo
declara sobre si mesmo (§ "Onde está cada coisa": invariante fica aqui, procedimento vai para
skill, o porquê vai para `docs/`, o que expira vai para `progress.md`).
**Modo:** max (passo de ataque + verificação adversarial).
**Delta:** 8 arquivos alterados, 12 novos (6 skills, 2 módulos de frontend, 4 docs), **+1.502 /
−5.585** linhas versionadas + ~2.400 linhas de arquivos novos.
**Régua:** `CLAUDE.md` (raiz), `docs/padrao-execucao.md`, `.claude/skills/testes-e-gates/SKILL.md`,
`.claude/skills/frontend-ui/SKILL.md`, `CLAUDE.md` do workspace e o global.
**Gates:** pytest **1491 passed** · Vitest **1583 passed** (api-backend 620 · frontend-vite 908 ·
shared 53 · portal-next 2) · typecheck **OK** · ts-prune **0** · **lint FALHA (exit 1, 2 erros)** ·
e2e Playwright a11y **não executado** (exige navegador; o renderer crasha no sandbox) · SonarCloud
**não executado** (só no CI).
**Verificação adversarial:** 7 contestações; **3 confirmados, 2 enfraquecidos, 0 refutados**.

O delta faz duas coisas independentes: (1) enxuga o `CLAUDE.md` de 5.718 para 1.100 linhas,
realocando o conteúdo em 6 skills novas + 3 docs novos, e reescreve `tests/test_doc_links.py` como
guarda mecânica dessa rede de ponteiros; (2) entrega a pré-visualização de `.docx` no navegador
(`docxPreview.ts`, leitor de ZIP sem dependência nova) e torna o nome do anexo o alvo de clique.

O trabalho é de qualidade alta e o risco central da reestruturação — **perda silenciosa de
invariante** — foi medido e não se confirmou: o saldo de regras 🔴 **subiu** de 232 para 318 (169
no `CLAUDE.md` + 149 nas skills), nenhum ponteiro `.md` está quebrado em nenhum documento vivo, e
as guardas existentes que leem o `CLAUDE.md` (13 arquivos de teste) continuam verdes, o que prova
que os textos que elas exigem sobreviveram. O que impede o "pronto para PR" é um único item
mecânico — o lint vermelho. Os demais achados são de robustez de guarda, não de comportamento.

---

## Achados

### 🔴 Bloqueantes

- **[apps/frontend-vite/src/lib/docxPreview.test.ts:226,240]** Duas asserções de tipo redundantes
  fazem `npm run lint` sair com exit 1, violando a regra mandatória de 0 erros/0 warnings.
  **Falha:** `npm run lint` na raiz → `EXIT=1`; workspace `frontend-vite` acusa
  `226:24` e `240:19 error This assertion is unnecessary since it does not change the type of the
  expression @typescript-eslint/no-unnecessary-type-assertion`. `new Uint8Array(n)` já é declarado
  como `Uint8Array<ArrayBuffer>` e `png()` (linha 131 do próprio arquivo) também — as asserções não
  mudam tipo nenhum. Os outros 3 workspaces saem limpos, e o arquivo é untracked: a baseline estava
  verde e os 2 erros são **do delta**.
  **Evidência:** saída literal do gate, reproduzida por 3 lentes independentes; medido que remover
  as duas asserções mantém `tsc --noEmit` exit 0, `eslint` exit 0 e os 13 casos do arquivo verdes.
  **Correção:** remover ` as Uint8Array<ArrayBuffer>` nas duas linhas (`eslint --fix` resolve).
  **Regra:** `CLAUDE.md` § Regras mandatórias, item 5 — "**`npm run lint` na raiz deve passar com 0
  erros e 0 warnings** em todos os workspaces"; `.claude/skills/testes-e-gates/SKILL.md:20`.
  **Veredito:** CONFIRMADO **[verificado]** — placar 2×CONFIRMADO, 1×ENFRAQUECIDO.
  ⚠️ **Ressalva registrada da lente de impacto, medida e não descartada:** nenhum mecanismo
  *automático* bloqueia o merge por causa disto — `grep -rn "lint" .github/` devolve **0**
  ocorrências (o CI só tem `sonarcloud.yml` e `a11y.yml`), não há git hook, e o
  `sonar-project.properties` classifica `**/*.test.ts` como `sonar.test.inclusions`, fora das
  regras de código `main`. O item permanece bloqueante porque o rito define bloqueante como
  "corrige **antes de commitar**", e este é exatamente o gate que se roda à mão — não porque o
  GitHub o reprovaria.

### 🟡 Recomendados

- **[tests/test_doc_links.py:214]** `zip(CONTADORES_PROIBIDOS, exemplos)` sem `strict=True` desliga
  em silêncio a sanidade de qualquer padrão acrescentado sem o exemplo correspondente.
  **Falha:** acrescentar um 4º padrão proibido (o caminho natural — a lista já cresceu de 1 para 3,
  e `exemplos` fica 145 linhas abaixo, em outra classe) sem o 4º exemplo faz o `zip` truncar; o
  padrão novo nunca é exercido. Se ele tiver erro de digitação, `test_contador_movel_nao_vive_no_
  CLAUDE_md` passa a aplicá-lo casando nada — `[] == []` para aquele padrão, verde para sempre —
  e um contador móvel de classe nova entra no `CLAUDE.md` sem ninguém ver.
  **Evidência:** validado por mutante. Com 4 padrões (o 4º com o typo `cotnas`) e 3 exemplos:
  `9 passed`. Contrafactual com o 4º exemplo presente: `FAILED ... o padrao 'total de cotnas:
  [0-9]+' deixou de casar o formato que deveria proibir`. Com `strict=True` e as listas
  desalinhadas: `ValueError: zip() argument 2 is shorter than argument 1`. Arquivo restaurado e
  conferido por sha256.
  **Correção:** `zip(CONTADORES_PROIBIDOS, exemplos, strict=True)`.
  **Regra:** `CLAUDE.md` § Regras mandatórias, item 2 — "Teste que promete uma garantia tem de
  entregá-la"; o próprio docstring promete "**Cada** padrao tem de casar um exemplo real".
  **Veredito:** CONFIRMADO **[verificado]**.

- **[tests/test_doc_links.py:27-36 · tests/test_onda8_gate_ia.py:372-376]** As skills viraram
  superfície normativa (149 marcadores 🔴 em 1.643 linhas) e ficaram **fora** das duas guardas de
  documentação, que continuam varrendo só `CLAUDE.md` + `docs/**`.
  **Falha:** dois cenários medidos. (a) Renomear `.claude/skills/deploy-producao/pipelines.md`
  deixa o link emitido por `deploy-producao/SKILL.md:64` cego e a suíte fica **verde** — são 7
  links `.md` emitidos de dentro das skills, nenhum verificado. (b) Inserir a frase
  "`failFromError` ... `status < 500`" **sem** citar `clientSafe` em
  `.claude/skills/chat-ia-gateway/SKILL.md` → **29 passed**; a mesma frase em
  `docs/knowledge/dashboards.md` (controle) → **1 failed** em
  `G9ContratoDoErroTest::test_todo_doc_que_enuncia_o_corte_enuncia_a_excecao`. A skill do chat é o
  lugar natural para esse texto migrar, e no dia em que migrar entra sem guarda — reabrindo o modo
  de falha que a guarda existe para impedir (quem lê acredita e reporta um vazamento inexistente).
  **Evidência:** oráculo diferencial acima; `grep -rn "\.claude" tests/*.py` mostra que nenhuma
  outra guarda do repositório varre a pasta. Árvore restaurada e conferida byte a byte.
  **Correção:** incluir `.claude/skills/**/*.md` em `FONTES` (e em `_docs_vivos`). ⚠️ **Não basta
  acrescentar à lista:** a checagem atual é `(RAIZ / alvo).exists()` (linha 120) e os 7 links são
  relativos ao emissor (`../../../docs/...`) — a resolução precisa passar a considerar
  `fonte.parent / alvo`.
  **Regra:** `tests/test_doc_links.py`, docstring item 1 — "PONTEIRO QUEBRADO é pior que texto
  ausente".
  **Veredito:** CONFIRMADO **[verificado]**.

- **[apps/frontend-vite/src/lib/docxPreview.ts:207]** `catch { return null; }` engole qualquer
  exceção da leitura do ZIP sem deixar rastro. **[verificado, rebaixado — ver 🔵]**

- **[apps/frontend-vite/src/pages/Consulta.tsx — documentação]** Regras 🔴 removidas do `CLAUDE.md`
  sem destino em documento vivo. **[verificado, rebaixado — ver 🔵]**

### 🔵 Opcionais

- **[apps/frontend-vite/src/lib/docxPreview.ts:207]** `[verificado, rebaixado]` — rebaixado de 🟡
  porque a contestação **mediu** que o log proposto não entrega a diagnosticabilidade alegada: de
  10 corrupções de ZIP testadas, só **3** chegam ao `catch` (as outras 7 saem pelos ~6 `return null`
  defensivos de `listEntries`/`readEntry`, sem lançar), e uma corrupção de 1 byte no fluxo deflate
  produz **imagem corrompida na tela**, que nenhum log alcança. O que sobrevive íntegro é o segundo
  braço: um `TypeError`/`ReferenceError` introduzido por refactor futuro em `listEntries`/
  `readEntry` fica **100% mascarado** — os testes atuais só asseguram "não lança" e "devolve null",
  que é exatamente o que o bug produziria. Confirmado que o `catch (e)` do chamador
  (`AttachmentViewer.tsx:129`) é estruturalmente inalcançável para erro interno, que não há
  `ErrorBoundary`/`unhandledrejection`/telemetria cobrindo o caso, e que
  `docs/padrao-execucao.md:12` ("nunca silenciar erro") se aplica sem carve-out para UI. Correção
  mínima: `console.error` no `catch`; correção real: distinguir na UI "falhou ao ler o ZIP" de
  "leu e não havia imagem" — o mesmo item que o review de 2026-08-17 adiou por "exigir decisão de
  UI".

- **[CLAUDE.md — enxugamento]** `[verificado, rebaixado]` — rebaixado de 🟡 porque a contestação
  **refutou a consequência**. É verdade que `periodBeforeRange`, `loadOptions` e "o seletor do
  PERÍODO fica SUSPENSO e NÃO se desabilita" desapareceram de todo `.md` vivo. Mas as três regras
  moram no call site, com o mesmo "porquê": `Consulta.tsx:175-183` (+ o texto de `aria-describedby`
  visível ao usuário), `Consulta.tsx:831-839` e `ChartAccountSelect.tsx:159-165`. E **duas estão
  travadas por teste** (`ChartAccountSelect.test.tsx:84,112` — o par é mútuo; `Consulta.test.tsx:
  508,533,567`). Resíduo real, único e menor: a decisão "**suspenso ≠ desabilitado**" (com o
  histórico de que desabilitar foi considerado e rejeitado) sobrevive só como comentário e texto de
  UI, **sem teste**. Fecharia a lacuna um caso em `Consulta.test.tsx` que preencha `dateFrom` e
  asserte que o seletor de tipo de data **não** está `disabled`.

- **[progress.md:127-128]** O snapshot "Python **1.486**" já nasce defasado: o próprio delta
  acrescenta 5 casos a `tests/test_doc_links.py` (de 4 para 9 métodos) e a suíte mede **1.491**. O
  número de Node (1.583) está correto. O arquivo se declara "informativo — derive antes de citar",
  então é ruído, não erro.

- **[apps/frontend-vite/src/components/AttachmentViewer.tsx:110-143]** `docxImage`/`docxDone` não
  são reinicializados quando `sourceFile`/`url` mudam sem desmontar: o cleanup revoga o object URL
  mas o estado permanece, e o `<img>` apontaria para um blob revogado. Hoje **inalcançável** pela
  UI — o `<dialog>` é aberto com `showModal()` e bloqueia o clique num segundo anexo — e ambos os
  call sites (`ContaAttachments.tsx:200`, `Emails.tsx:662`) montam/desmontam por `viewing &&`.
  Registrado como armadilha para quem trocar o modal por não-modal.

- **[apps/frontend-vite/src/lib/docxPreview.ts:24 × skills/*/scripts/docx_content.py:52]**
  `DOCX_MAX_BYTES` (TS) e `DOCX_MAX_UNCOMPRESSED_BYTES` (Python) valem **os mesmos 25 MB** com
  semânticas diferentes: o TS mede o arquivo comprimido, o Python a **soma declarada** das
  entradas. Não há furo — o TS infla no máximo uma entrada e a limita a 12 MB durante a leitura,
  então o teto agregado é dispensável ali —, mas o par de nomes quase iguais com o mesmo número
  convida ao erro na próxima manutenção. Vale um comentário cruzado.

- **[apps/frontend-vite/src/components/molecules/AttachmentList.tsx:112-125]** O ícone de olho leva
  `aria-hidden="true"` + `tabIndex={-1}`, o que o tira da ordem de tabulação, mas ele **continua
  focável por clique de mouse** — o foco pode pousar numa subárvore oculta da árvore de
  acessibilidade. O axe em jsdom passa (e trataria o caso como *incomplete*, não violação). Não há
  alternativa limpa: transformá-lo em `<span>` com handler cairia no S1082 do Sonar, e `inert`
  mataria também o clique de mouse, que é a razão de o atalho existir. Trade-off aceito, registrado.

---

## Pendências (trabalho incompleto)

Nenhuma. A varredura por marcadores (`TODO|FIXME|HACK|XXX|WIP`, `@todo`, `@pendente`, `todo:`) no
diff versionado **e** nos 12 arquivos novos devolveu **0** ocorrências verdadeiras (a única
coincidência, `docs/db/historico-migrations.md:641`, é a palavra "TODO" dentro de "quebrou TODO"),
e não há stub, `NotImplementedError`, `it.skip` nem `console.log` de depuração no código novo.

Registro de escopo, não de pendência: a lacuna de teste do "suspenso ≠ desabilitado" está descrita
no 🔵 do enxugamento.

---

## Drift código × documentação

- **`docs/knowledge/auth.md:12-17` × `CLAUDE.md` do workspace** — o doc novo documenta **quatro**
  telas de autenticação (acrescenta `/auth/change-password`, da troca obrigatória no 1º acesso),
  enquanto `C:\Sheild\Projetos\Claude\CLAUDE.md` § AUTH STANDARD afirma "Todos os projetos
  implementam exatamente estes **três** fluxos — nada mais". O código do projeto tem as quatro; a
  régua do workspace é que está desatualizada. **Decisão sua:** atualizar a régua do workspace ou
  declarar o `pagamentos` como exceção documentada.

- **`progress.md:127-128`** — snapshot da suíte Python defasado pelo próprio delta (1.486 → 1.491).
  Detalhado no 🔵 correspondente. **Decisão sua**, porque tocar `progress.md` é sincronizar doc de
  estado, que esta fase não faz por conta própria.

---

## Não coberto

- **Gates não executados:** camada de acessibilidade em navegador real (Playwright + axe,
  `apps/frontend-vite/e2e/`) — o próprio `CLAUDE.md` proíbe rodá-la no sandbox do agente, e é
  justamente a camada que enxergaria contraste efetivo, ordem de foco e o conteúdo **dentro do
  `<dialog>`**, onde vive a nova `<img>` do `.docx`. SonarCloud — só roda no CI, e o
  `CLAUDE.md` avisa que lint local verde não garante PR verde.
- **Arquivos lidos por busca dirigida, não integralmente:** `CLAUDE.md` (1.100 linhas — lido por
  seção, por medição de teto e por confronto de invariantes), os 9 arquivos de skill (1.643 linhas
  — lidos por contagem de 🔴, por links emitidos e por confronto com o texto antigo) e
  `docs/db/historico-migrations.md` (769 linhas, não lido). Lidos por inteiro: `docxPreview.ts`,
  `docxPreview.test.ts`, `AttachmentViewer.tsx`, `AttachmentList.tsx`, `tests/test_doc_links.py`,
  `progress.md`, `docs/knowledge/auth.md` e os diffs dos 4 arquivos de teste/componente.
- **Método da varredura de perda de invariante:** comparei as 232 linhas 🔴 do `CLAUDE.md` antigo
  contra o corpus vivo por identificador em crase (símbolos de código), não por sinônimo semântico.
  Um invariante reescrito com outras palavras **e** sem nenhum símbolo em comum passaria
  despercebido por esse método. Mitigação parcial: os 13 arquivos de teste que leem o `CLAUDE.md`
  continuam verdes, o que cobre os invariantes já travados mecanicamente.
- **Não medido:** comportamento real do `docxPreview` contra um `.docx` de produção (os 3 casos
  reais das guias do TJSP). Todos os casos são fixtures montadas byte a byte — excelentes para o
  parser, mas não provam que um arquivo do Word real cai no ramo esperado.
- **Superfície adjacente verificada e sem achado:** a duplicação cross-language da heurística "maior
  imagem embutida" entre `docxPreview.ts` e `skills/*/scripts/docx_content.py` foi confrontada
  linha a linha — mesmo regex de `word/media/`, mesmo `DOCX_MAX_ENTRIES` (2.000), mesmo
  `DOCX_MAX_IMAGE_BYTES` (12 MB), mesma disciplina de "tamanho declarado mente, medir os bytes
  reais". Só a divergência de semântica do teto de 25 MB, registrada como 🔵.
- **Fora do delta, não revisado:** nenhum arquivo `.py` de `skills/` ou `scheduler/` foi tocado,
  então não há impacto no manifesto de paridade de produção nem necessidade de deploy.

---

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| B1 | Duas asserções de tipo redundantes derrubam `npm run lint` | ✅ corrigido | `apps/frontend-vite/src/lib/docxPreview.test.ts:226,240` — removido ` as Uint8Array<ArrayBuffer>` das duas linhas. `npm run lint` passou de exit 1 para **exit 0**; os 13 casos do arquivo seguem verdes |
| R1 | `zip()` sem `strict=True` desliga a sanidade de padrão novo | ✅ corrigido | `tests/test_doc_links.py:249` — `strict=True` + docstring com o motivo. **Mutante:** 4 padrões / 3 exemplos → `ValueError: zip() argument 2 is shorter than argument 1`, VERMELHO |
| R2a | Os 7 links `.md` emitidos pelas skills não eram verificados | ✅ corrigido | `tests/test_doc_links.py` — skills entram em `FONTES` **por glob** (skill nova nasce coberta), resolução passa a aceitar caminho relativo ao emissor, e entrou `test_sanidade_as_skills_entram_na_rede`. **Dois mutantes:** renomear `pipelines.md` → VERMELHO; quebrar o glob → VERMELHO |
| R2b | `tests/test_onda8_gate_ia.py::_docs_vivos` não varre `.claude/skills/` | ⏸️ adiado | O arquivo está **fora do delta** (não foi tocado por este trabalho). A correção é uma linha — trocar a lista por `[RAIZ/"CLAUDE.md", *sorted((RAIZ/"docs").rglob("*.md")), *sorted((RAIZ/".claude"/"skills").glob("*/*.md"))]` — e foi medido que fica **verde** hoje, porque nenhuma skill cita o corte em 500. Corrigir de carona misturaria duas intenções no mesmo diff |
| R3 | `catch { return null; }` sem log em `docxPreview.ts:207` | ⏸️ adiado | **ENFRAQUECIDO** na verificação adversarial: medido que só 3 de 10 corrupções chegam ao `catch`, então o log não entrega a diagnosticabilidade alegada. Corrigir sobre premissa abalada é o pior dos dois mundos. A metade que sobrevive (bug futuro 100% mascarado) fica registrada como 🔵 |
| R4 | Regras 🔴 sem destino em documento vivo | ⏸️ adiado | **ENFRAQUECIDO**: as três regras moram no call site e duas estão travadas por teste. Além disso, mexer em doc de regra do projeto é decisão sua, não inferência do revisor. O resíduo real (falta um teste para "suspenso ≠ desabilitado") está no 🔵 |

**Gates após a correção:** pytest **1492 (+1)** · Vitest **1583** (frontend-vite 908, medido com
`--maxWorkers=1`) · lint **0 erros / 0 warnings** · typecheck **OK** · ts-prune **0**.
**Baseline (Passo 3):** pytest 1491 · Vitest 1583 · lint **exit 1 (2 erros)** · typecheck OK ·
ts-prune 0.

⚠️ Na execução em paralelo, `src/components/organisms/AiChatWidget.test.tsx` falhou 1 caso. **Não é
regressão:** o arquivo passa isolado (21/21) e a suíte inteira passa com `--maxWorkers=1`
(908/908); a correção tocou só `docxPreview.test.ts` e um arquivo Python, que não alcançam esse
componente. É a exaustão de recursos do sandbox que o próprio `CLAUDE.md` documenta.

**Re-review do diff da correção:** sem achado novo. Nenhum caminho de erro engolido (a sanidade
nova falha ruidosamente); `FONTES`/`_SKILLS_MD` não têm consumidor externo, então não houve mudança
de contrato; nenhuma regra duplicada em outra camada; e os três fixes atacam a causa, não o sintoma
(asserção removida em vez de `eslint-disable`, `strict=True` em vez de asserção de tamanho, glob em
vez de lista fixa). Risco avaliado e comentado no código: a resolução dupla de caminho é mais
permissiva que a original — um falso-verde exigiria um arquivo homônimo no mesmo caminho relativo
abaixo do emissor, o que não ocorre hoje. Fim de linha conferido em bytes: **0 CRLF**, LF puro nos
dois arquivos editados.

**Não corrigido por decisão sua:** os dois drifts (régua de auth do workspace × as 4 telas reais;
snapshot da suíte em `progress.md`), os 6 achados 🔵 e a perna R2b.

**Nada foi commitado.**

---

## 2ª rodada de correção — os quatro adiados, resolvidos a pedido

Executada depois da tabela acima, com autorização explícita para tratar os itens que a fase
automática havia deixado em `⏸️ adiado`.

| # | Item | Desfecho | Como |
|---|---|---|---|
| R2b | `_docs_vivos` cego para `.claude/skills/` | ✅ corrigido | `tests/test_onda8_gate_ia.py` — as skills entram por glob e entrou `test_sanidade_o_conjunto_cobre_docs_E_skills`, que assere por **família de caminho** (`CLAUDE.md`/`docs`/`.claude`) em vez de contagem, que envelheceria a cada doc novo. **Mutante:** a frase do corte em 500 sem `clientSafe` numa skill → VERMELHO |
| R3 | `catch { return null; }` engolindo a leitura do ZIP | ✅ corrigido | Redesenho do contrato, não `console.error` no `catch` |
| R4a | `periodBeforeRange` e "suspenso ≠ desabilitado" sem destino | ✅ corrigido | Regras registradas em `.claude/skills/frontend-ui/SKILL.md` § "Intervalo De/Até × período por mês" |
| R4b | A decisão "suspenso ≠ desabilitado" não tinha teste | ✅ corrigido | `Consulta.test.tsx` — "o seletor do período NÃO é desabilitado pelo intervalo". **Mutante:** `disabled={!!f.dateFrom \|\| !!f.dateTo}` → VERMELHO |
| Drift | Régua do workspace × as 4 telas de auth | ✅ resolvido | `C:\Sheild\Projetos\Claude\CLAUDE.md` § AUTH STANDARD passou a declarar **quatro** fluxos |

### Por que o R3 exigiu redesenho, e não um log

A contestação adversarial havia medido que 7 das 10 corrupções de ZIP **não passam pelo `catch`** —
saem pelos `return null` defensivos. Um `console.error` ali teria fechado ⅓ do problema e deixado a
tela continuar afirmando "documento sem imagem" nos outros ⅔. A causa não era a ausência de log:
era o **tipo de retorno**, que colapsava dez situações distintas num único `null`.

`extractLargestDocxImage` passou a devolver `DocxPreviewResult` — `{ image, failure, error? }` —
com dez motivos que separam três classes que pedem ações opostas: recusa por teto nosso, arquivo
corrompido, e recurso não implementado (zip64, método AES, navegador sem `DecompressionStream`).
O invariante fica explícito no tipo: **`image: null` + `failure: null` é a única combinação que
autoriza a tela a afirmar um fato sobre o arquivo**. `image` presente com `failure` é anomalia
parcial — mostra a imagem, registra o motivo, não alarma.

`erro-inesperado` ficou reservado para o que nenhum caminho previsto explica, e um caso de sanidade
(`NENHUMA corrupção de dado produz 'erro-inesperado'`) impede que ele vire lixeira — sem isso, o
motivo que existe para denunciar bug perderia justamente o poder de denunciar. O `AttachmentViewer`
ganhou a mensagem "Não foi possível ler este documento do Word", distinta de "sem imagem para
pré-visualizar", e loga `failure` + o erro original.

**Mutantes:** `listEntries` parar de declarar `nao-e-zip` → 3 casos VERMELHOS; o viewer voltar a
ignorar `resultado.failure` → o caso da mensagem VERMELHO. Ambos revertidos e conferidos.

### Achado da própria correção (encontrado no re-review, corrigido)

- `ts-prune` passou de 0 para 1: `DocxPreviewFailure` nasceu exportado sem consumidor por nome.
  Fechado com `// ts-prune-ignore-next` na linha **imediatamente** anterior ao `export` — o JSDoc
  virou comentário de linha porque um bloco entre o marcador e a declaração o anula em silêncio.
- Um comentário do `AttachmentViewer` descrevia o comportamento **anterior** ("a tela afirmaria
  documento sem imagem"). Reescrito: o valor que sobrevive no `if (!res.ok)` é o **log** — sem ele,
  um 403 na URL assinada seria diagnosticado como `nao-e-zip`, mandando o suporte investigar um
  arquivo que está intacto no Storage.

### Gates

| | Baseline (Passo 3) | 1ª rodada | 2ª rodada |
|---|---|---|---|
| lint | **exit 1 (2 erros)** | 0/0 | **0/0** |
| typecheck | OK | OK | **OK** |
| ts-prune | 0 | 0 | **0** |
| pytest | 1491 | 1492 | **1493 (+2)** |
| Vitest (total) | 1583 | 1583 | **1591 (+8)** |
| frontend-vite | 908 | 908 | **916 (+8)** |

Medição do `frontend-vite` com `--maxWorkers=1`, como o `CLAUDE.md` exige.

**Re-review desta rodada:** um só consumidor de produção da função cujo contrato mudou
(`AttachmentViewer.tsx`), atualizado; nenhum `setState` após desmontar (o `if (!active) return` e
os dois `if (active)` cobrem os três caminhos); tokens semânticos existentes na mensagem nova
(`status-warning-*`), sem hex nem cor default; nenhuma regra duplicada entre camadas.

**Permanece 🔵, sem mudança:** `docxImage`/`docxDone`/`docxFalhou` não são reinicializados quando
`sourceFile` muda sem desmontar — segue inalcançável pela UI (o `<dialog>` é modal e os dois call
sites montam por `viewing &&`), e o terceiro estado não altera esse raciocínio.

⚠️ **Uma alteração saiu do repositório:** `C:\Sheild\Projetos\Claude\CLAUDE.md` (régua do
workspace, vale para **todos** os projetos Sheild). Resolver o drift exigia escolher um lado, e o
lado errado era a régua: a 4ª tela é consequência do não-autorregistro — quem cria usuário por fora
define senha temporária, e senha que o admin conhece não pode sobreviver ao 1º login. Qualquer
projeto Sheild novo vai precisar dela.

**Nada foi commitado.**
