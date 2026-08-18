---
name: testes-e-gates
description: >-
  Escrever testes e passar nos gates de qualidade do projeto `pagamentos` (Vitest nos 4
  workspaces, pytest no pipeline Python, ESLint, tsc, ts-prune, vulture, SonarCloud). Cobre as
  lições que este projeto pagou caro — teste verde que não travava nada, guarda textual que não
  cobre o call site executado, validação por mutante, teste que herda estado local do ambiente —
  e o motivo de o lint local verde não garantir o PR verde. Acione SEMPRE que o usuário disser
  "escrever teste", "rodar os gates", "npm test", "pytest", "lint", "typecheck", "prune",
  "SonarCloud", "PR vermelho", "quality gate", "cobertura", ou quando uma mudança precisar de
  teste novo — mesmo sem dizer "skill".
---

# Testes e gates — `pagamentos`

## Rodar

```powershell
npm test            # os 4 workspaces (frontend-vite, api-backend, packages/shared, portal-next)
npm run lint        # 0 erros E 0 warnings — em todos
npm run typecheck
npm run prune       # ts-prune nos 3 apps — deve reportar 0

py -3 -m pytest tests/ -q                                   # pipeline Python
py -3 -m vulture server/ skills/ scripts/ --min-confidence 60
```

⚠️ **Medir o `frontend-vite` com `--maxWorkers=1`.** Em paralelo, o sandbox derruba ~9 casos de
a11y por esgotamento de recursos. **Falha espalhada em arquivo que a mudança não tocou é sintoma
de ambiente, não de regressão.**

⚠️ **NUNCA encadeie `| tail` / `| grep` ao medir gate** — o exit code do pipeline é o do último
comando, e o `tsc` imprime erro em **stdout**. Já mascarou vermelho em duas medições.

## A regra: todo componente/alteração relevante tem teste

Cobrindo renderização **e** a interação principal. Referência de granularidade:
`StatusBadge.test.tsx`, `ExpandableText.test.tsx`, `organisms/LoginForm.test.tsx`.

## 🔴 Teste que promete uma garantia tem de entregá-la

Três testes verdes deste projeto não travavam o que o nome dizia. Se o nome ou o comentário afirma
"**ANTES** de", "**alinhado com** X" ou "**cabe no limite** de Y", a asserção precisa **observar
aquilo** — não um número mágico, não uma chamada isolada, não uma contagem do próprio array.

**As seis ferramentas:**

1. **Guarda cross-layer** — ler o outro arquivo e comparar, em vez de afirmar coerência.
   Exemplos: `log.test.ts` × migrations · `regression.test.ts` × `AiChatPanel.tsx` ·
   `test_body_full.py` × migration do `body_search` · `test_doc_type_domain_consistency.py`.
2. **Sanidade do parser** em toda guarda que faz parsing — um regex que para de casar transforma
   o teste em `0 === 0`, verde para sempre.
3. **Validação por mutante** — introduza o defeito de propósito e confirme o VERMELHO. Teste que
   não falha com o defeito instalado não é teste, é decoração.
4. **Guarda que procura AUSÊNCIA precisa ler CÓDIGO, não prosa.** Os scripts explicam em
   comentário justamente o que não devem fazer, então a guarda casaria a própria advertência. Use
   **`ast` + `tokenize`**, nunca regex: `re.sub(r"#[^\n]*", "")` corta a partir de um `#` **dentro
   de string** — falso negativo, o pior desfecho numa guarda. Helper: `_sem_prosa`.
5. 🔴 **Testar a função PURA não cobre o CALL SITE.** Ao trocar o render de uma coluna por um
   helper, o helper ganhou 8 testes e o **wiring** ficou sem nenhum: as fixtures usavam os casos
   em que o código novo e o antigo produzem o MESMO texto. Medido: o mutante que restaura o
   comportamento antigo **mantendo o import usado** passava **748/748 testes e typecheck limpo**.
   ⚠️ Ao escolher o mutante, prefira o que **preserva as referências** — o ingênuo é pego pelo
   `tsc` (`TS6133: import órfão`), o que detecta "o símbolo ficou sem uso", **não** o defeito.
6. 🔴 **Guarda de wiring por TEXTO não cobre o call site EXECUTADO.** `WiringDasGuardasTest`
   ficou **VERDE com o pipeline quebrado**: a chamada estava lá, no argumento certo, mas a
   variável só era atribuída dentro de um `if`, e **todo e-mail com anexo** levantava
   `UnboundLocalError` — 13 e-mails num dia virando `falha`. A guarda textual prova que a chamada
   **existe**; só a execução prova que **funciona** (ela não vê escopo, ordem de atribuição,
   exceção nem tipo). Use-a para impedir que alguém REMOVA a ligação, e **acrescente um caso que
   execute a função de topo** por caminho estrutural.

A pergunta que encontra os três: *"o que aconteceria se eu quebrasse isto de propósito?"* — se a
resposta for "nada falharia", o teste está incompleto.

> ⚠️ **Mutante e concorrência não se misturam.** Dois processos sobre o MESMO arquivo — um
> aplicando o mutante, outro lendo — fazem o leitor observar estado transitório e concluir o
> oposto do que o repositório contém. Validação por mutante roda **isolada**: em série, ou sobre
> cópia do arquivo.

🔴 **Teste não pode depender de estado LOCAL herdado do ambiente.** `MainDryRunTest` lia o
checkpoint **real**: enquanto o script nunca tinha rodado, os 7 casos passavam **por acidente**.
Nem o code review nem 15 mutantes pegaram, porque nenhum alterava o disco. Arquivo de estado se
isola no `setUp` com `tempfile.TemporaryDirectory` + `mock.patch.object`.

## Configuração dos workspaces

🔴 **`packages/shared` NÃO tem `vitest.config.ts`, e é deliberado** — os defaults já servem, e um
`.ts` na raiz do pacote ficaria FORA do `include: ["src"]` do tsconfig, quebrando o lint
type-aware. Os testes importam `{ describe, it, expect }` explicitamente (`types: []`).

🔴 **`src/index.test.ts` existe por DOIS motivos.** Valida o barrel (um `export *` esquecido não
quebra a compilação DESTE pacote, só a do consumidor) **e** é o que faz a COBERTURA enxergar o
pacote inteiro: o v8 só reporta arquivo efetivamente carregado. Medido: 5 de 14 arquivos no lcov
sem ele, **14 de 14** com ele.

**`apps/portal-next`** é testado via `renderToStaticMarkup`, não jsdom — a página é um placeholder
sem hooks e jsdom custaria ~16 s por nada. Ao migrar, **declarar `jsdom` e
`@testing-library/react` como devDependencies do portal** (hoje só resolvem por hoisting).

🔴 **Não medir versão de React por substring** — `lucide-react@1.21.0` casa `react@<versão>` e
devolve resposta confiantemente errada. Medir por cópia em disco ou chave do dicionário.

## Lint e análise estática

🔴 **`coverage/` fica FORA do lint nos 3 apps** — os arquivos do lcov-report do istanbul trazem
`/* eslint-disable */` e o `reportUnusedDisableDirectives` os acusa. **Não some apagando a pasta**:
o workflow do SonarCloud a recria a cada PR.

**ESLint diverge por workspace (intencional):** `frontend-vite` em **10**, apps Next em **9**
(o `eslint-config-next` depende de um plugin que quebra no 10).

🔴 **`tsconfigRootDir: import.meta.dirname`** em todo `eslint.config.mjs` — sem ele, "No
tsconfigRootDir was set" no editor. Nos apps Next, **não** habilitar `projectService: true`.

🔴 **`.vscode/settings.json` com `eslint.workingDirectories: [{ "mode": "auto" }]` não se remove**
— o monorepo só tem flat config por-app.

🔴 **`typecheck` dos apps Next EXCLUI `.next/dev/types`** — é cache do `next dev`, escrito e nunca
revisado; uma escrita parcial faz o `tsc` acusar erro de SINTAXE em código que ninguém escreveu
(caso real: 5 erros apontando para artefato gitignored). `exclude` vence `include`. Ganho extra:
num clone limpo o `validator.ts` **nunca era checado**; agora entra sempre.

**ts-prune:** export público intencional sem consumidor leva `// ts-prune-ignore-next` na linha
**IMEDIATAMENTE** anterior ao `export` — com um comentário no meio, o marcador é **ignorado em
silêncio**. `packages/shared` deliberadamente **não** tem `prune` (barrel reportaria toda export
como órfã).

**vulture:** rotas Flask decoradas aparecem como "unused function" — falsos positivos.

## 🔴 SonarCloud BARRA o merge — lint local verde ≠ PR verde

Conjuntos de regras diferentes. A condição que mais morde é **`new_reliability_rating > 1`**: UM
bug no código novo, mesmo MINOR, reprova.

```bash
node -e "fetch('https://sonarcloud.io/api/qualitygates/project_status?projectKey=SHE-ADM_email-financeiro&pullRequest=<N>').then(r=>r.json()).then(j=>console.log(JSON.stringify(j.projectStatus,null,1)))"
node -e "fetch('https://sonarcloud.io/api/issues/search?componentKeys=SHE-ADM_email-financeiro&pullRequest=<N>&types=BUG&resolved=false').then(r=>r.json()).then(j=>j.issues.forEach(i=>console.log(i.component,i.line,i.message)))"
```

(o `curl` do Git Bash falha no TLS do sonarcloud.io — use `node -e` com `fetch`.) Antes de
concluir que é ruído, confira se PRs anteriores passavam.

🔴 **O escopo é VERSIONADO em `sonar-project.properties`** (modo CI-based desde 2026-07-18).
Resolver issue na UI ("Won't Fix") **NÃO é permanente** — o engine perde o rastreamento ao
re-basear e **REABRE** (266 de 376 issues estavam `REOPENED`). O arquivo exclui
`supabase/migrations/**` (analisadas pelo engine PL/SQL da Oracle, semântica divergente), marca os
testes como TEST sources e suprime por regra+arquivo.

**Achados recorrentes** (corrigir antes de abrir PR): S7735 condição positiva · S6754 par
`[x, setX]` · S3358/S4624 ternário aninhado no JSX · S1128 import não usado · S2301 seletor
booleano · S6772 texto solto após elemento inline · S6759 props `Readonly<>` · S3776 complexidade
>15 · S8572 `logging.exception` em `except` · S3457 f-string sem campo · **S1082 handler de clique
em elemento não-interativo** (`<div onClick>`) — a saída é pôr o handler no `<button>`, não
adicionar um `onKeyDown` inútil ao lado.

**Backlog já triado — não reinvestigar do zero:** ver `progress.md` § "Triagem de backlog".

## Refactor de função grande — o precedente que funcionou

`extract_from_email_body` estava em complexidade **61 (grau F)**. O padrão, para repetir:

1. extrair as **cadeias de precedência** como funções PURAS, sem tocar na ordem (que **É** a regra
   de negócio);
2. trocar `if` encadeado por **tabela** (`_BODY_INVOICE_SOURCES`);
3. provar equivalência por **A/B sobre dados reais** (139 corpos + 764 assuntos reprocessados com
   o código de HEAD e com o novo → **0 diferenças**), não só pela suíte.

Resultado: **61 (F) → 17 (C)**. Sem o A/B, refactor desse porte no núcleo não deve ser mesclado.
