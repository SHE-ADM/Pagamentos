# Code Review — Features / botão flutuante do chat de IA (2026-08-17)

## Resumo

Alvo: `Botão flutuante chat ai` — **não resolvido como documento de plano**. Nenhum `.md` do
repositório descreve este trabalho; a régua de referência foi o `CLAUDE.md` (Regras mandatórias
1, 2 e 6) e `docs/arquitetura-chat-ia-pagamentos.md` (§ decisões do widget). O diff revisado é
**completo**, não recortado pelo alvo.
Modo: light (sem passo de ataque, sem verificação adversarial)
Delta: 4 arquivos alterados, 0 novos, +105/−7 linhas
Régua: `CLAUDE.md` (raiz do projeto) · `C:\Sheild\Projetos\Claude\CLAUDE.md` (workspace) ·
`docs/arquitetura-chat-ia-pagamentos.md`
Gates: frontend-vite **885 testes** (145 arquivos, `--maxWorkers=1`) · api-backend **620** ·
packages/shared **53** · portal-next **2** · lint **exit 0** · typecheck **exit 0** ·
ts-prune **exit 0** · e2e Playwright **não executado** (o renderer do Chromium crasha no sandbox
do agente — restrição registrada no `CLAUDE.md`)

O delta faz três coisas independentes no assistente de IA: troca o ícone `MessageCircle` pelo
**logo do app** no lançador flutuante, leva o painel de 32rem fixos para **metade da tela a partir
de `lg`**, e corrige a **rolagem de abertura** (o painel abria no fim da lista de sugestões em vez
do começo). As três vêm acompanhadas de teste, e os dois testes que fazem afirmação não-trivial
foram **validados por mutante** nesta revisão — ficam vermelhos quando o defeito é reintroduzido.
Nenhum bloqueante. Um recomendado, sobre a premissa não verificada da guarda de largura.

## Achados

### 🔴 Bloqueantes

Nenhum.

### 🟡 Recomendados

- [apps/frontend-vite/src/components/organisms/AiChatWidget.test.tsx:90-92] A guarda de largura
  reafirma **constantes locais** do Tailwind em vez de verificar a premissa que ela própria declara
  ("o `@theme` do projeto não sobrescreve nenhum dos dois") — se o projeto passar a sobrescrever,
  o teste continua verde provando uma aritmética que não é mais a do produto.

  Falha:     alguém acrescenta `--container-lg: 36rem;` ao `@theme` de `src/index.css` (para
             alargar cards do app — é exatamente onde toda customização vive no Tailwind v4
             CSS-first). O `max-w-lg` do painel passa a valer **36rem**, o breakpoint `lg` continua
             em 64rem ⇒ 50vw = 32rem ao cruzá-lo, e o painel **encolhe de 36rem para 32rem** —
             precisamente o defeito que o teste existe para impedir. A tabela `MAX_W_REM` local
             segue dizendo `lg: 32`, `64/2 === 32` continua verdadeiro e o teste passa.
  Evidência: o teste declara a premissa em comentário (linha 90: "o `@theme` do projeto não
             sobrescreve nenhum dos dois") e não a verifica. Medido nesta revisão:
             `grep -nE '^\s*--(breakpoint|container)-' src/index.css` → **exit 1, nenhuma linha**,
             ou seja, a premissa é verdadeira **hoje** e nada a mantém verdadeira amanhã. O rito
             (`rito.md`, Passo 4, item 3) trata este caso: "guarda que compara duas camadas precisa
             **ler a outra camada** em vez de reafirmar uma constante local".
  Correção:  acrescentar ao teste uma guarda de ausência que leia `src/index.css` e falhe se o
             `@theme` definir `--breakpoint-<x>` ou `--container-<y>` para as chaves usadas —
             mesmo padrão já praticado em `tests/contrast.a11y.test.ts` (que lê o `@theme`) e em
             `src/lib/sentinelAuthor.test.ts` (que lê a migration). Ler o theme default do
             Tailwind em `node_modules` seria frágil; a guarda de ausência é o lastro proporcional.
  Regra:     `CLAUDE.md` § Regra mandatória 2 — "Teste que promete uma garantia tem de entregá-la";
             `rito.md` Passo 4.3.

### 🔵 Opcionais

- [apps/frontend-vite/src/components/organisms/AiChatPanel.tsx:197] A condição
  `entries.length === 0 && !loading` é a **mesma** da linha 271 (que decide renderizar as
  sugestões), escrita duas vezes. Extrair uma const antes do `return` e usá-la nos dois pontos
  elimina a divergência silenciosa — o effect existe justamente *porque* aquele ramo mostra
  sugestões. Cenário de falha é hipotético (exigiria alterar uma metade e esquecer a outra), por
  isso opcional e não recomendado.
- [apps/frontend-vite/src/components/organisms/AiChatWidget.test.tsx:71] `container.querySelector('img')`
  poderia ser `botao.querySelector('img')` — escopo mais estreito e independente de o painel um dia
  renderizar imagens. O risco atual é nulo: o `expect(botao).toContainElement(logo)` da linha 74 já
  reprovaria uma `<img>` que viesse de fora do botão.

## Pendências (trabalho incompleto)

Nenhuma. Varredura sobre o diff (marcadores `TODO|FIXME|HACK|XXX|WIP|@todo|@pendente`, `it.skip`/
`.only`, `console.log`/`debugger`) e sobre os untracked: **0 ocorrências, 0 arquivos untracked**.

## Drift código × documentação

Nenhum. Verificado: nem o `CLAUDE.md` (linhas 731, 1241, 1244, 1278, 2200-2201) nem
`docs/arquitetura-chat-ia-pagamentos.md` (§1212-1213) afirmam o ícone do lançador ou a largura do
painel — descrevem o widget por comportamento (`botão flutuante + estado da conversa`,
`side sheet à direita`, `<dialog> + showModal()`), tudo preservado. A nota do `CLAUDE.md:1278`
(footer de `/consulta` com `pl-1 pr-20` "para o botão flutuante não cobrir o Carregar mais")
continua válida: o botão manteve `h-12 w-12` em `bottom-5 right-5`.

## Verificações executadas nesta revisão

Registradas porque sustentam as afirmações acima — o Passo 6 do rito exige lastro, não dedução.

| O que | Como | Resultado |
|---|---|---|
| Guarda do scroll é real (jsdom podia tornar `scrollTop` um no-op, e o teste ficaria verde com o bug) | mutante: `el.scrollTop = el.scrollHeight` (código anterior) + `vitest -t "TOPO"` | **VERMELHO** — `expected 900 to be +0`. Mutante revertido e confirmado por `diff -q` |
| Guarda da largura pega o encolhimento no breakpoint | mutante: `lg:max-w-[50vw]` → `md:max-w-[50vw]` + `vitest -t "metade da tela"` | **VERMELHO** — `expected 24 to be 32`. Mutante revertido e confirmado por `diff -q` |
| Afirmações do comentário sobre o PNG | decodificação do `otimotex.png` (zlib + desfiltragem de scanlines) | confirmadas: **256×256 RGBA**, **alfa 255 em toda a amostragem** (fundo branco **opaco**, não transparente), disco escuro `(33,22,18)` de **x=3 a x=252** ⇒ margem de ~1,2% por lado, coberta pelo `scale-105` (2,5% por lado) |
| Aritmética do breakpoint | defaults do Tailwind v4: `lg` = 64rem, `max-w-lg` = 32rem | 50vw de 64rem = 32rem ⇒ transição **contínua**, o painel cresce a partir da largura que já tinha |
| O `@theme` do projeto não redefine breakpoints/containers | `grep -nE '^\s*--(breakpoint\|container)-' src/index.css` | exit 1 (nenhuma linha) — premissa verdadeira hoje; ver 🟡 acima |
| `MessageCircle` não ficou órfão em nenhum consumidor | `grep -rn "MessageCircle" src e2e tests` | 0 ocorrências |
| Seletores dos consumidores do botão sobreviveram | `grep -rn "abrir assistente"` | 7 pontos (`Layout.test.tsx` ×2, `AiChatWidget.a11y.test.tsx` ×2, `AiChatWidget.test.tsx` ×2, `e2e/protected.a11y.e2e.ts`), **todos por `aria-label`**, que não mudou |
| O guard de contraste não ficou com lacuna | leitura de `tests/contrast-usage.a11y.test.ts` | o par `white/brand-dark` foi **mantido** (bolha da pergunta), só o `where` mudou; o anel de foco `brand-dark/white min 3` já está coberto pela linha 121. O botão não tem texto nem ícone de cor ⇒ nada a acrescentar |
| Anel de foco sobrevive ao `overflow-hidden` novo | análise do modelo de caixa | `overflow: hidden` clipa **descendentes**, não o `box-shadow` do próprio elemento — o `focus-visible:ring-2` continua visível (seria um defeito sério de a11y se não fosse) |

## Não coberto

- **e2e Playwright + axe em navegador** (`e2e/protected.a11y.e2e.ts`, caso "Assistente de IA —
  painel aberto") — não executado: o renderer do Chromium crasha na SPA completa dentro do sandbox
  do agente, restrição já registrada no `CLAUDE.md`. É a única camada que enxergaria contraste sob
  render efetivo e a aparência real do lançador. **Validar no CI** (workflow `a11y.yml`, que roda a
  cada push na `Features`) ou na máquina do usuário. Nada no delta sugere risco ali: o botão não
  tem texto nem ícone de cor, e a `<img alt="">` é decorativa (o axe aceita `alt=""`).
- **Conferência visual em tela** das três mudanças (recorte do logo no círculo a 48px, painel a
  50vw em monitor largo, posição de abertura da lista). O jsdom não faz layout; os testes travam a
  estrutura e a aritmética, não os pixels.
- **`apps/frontend-vite/tests/contrast-usage.a11y.test.ts`** foi lido apenas no entorno do hunk
  (±20 linhas) e por `grep` dos pares `brand*`, não por inteiro — o delta ali são 2 linhas de
  comentário e 1 de string de rótulo.
- **`AiChatWidget.test.tsx`** foi lido até a linha 140 (o delta vai da 62 à 133); o restante do
  arquivo está fora do delta.

---

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| R1 | Guarda de largura reafirma constantes locais do Tailwind sem verificar a premissa que declara | ✅ corrigido | `AiChatWidget.test.tsx:85-121` — guarda de **ausência** lendo `src/index.css`: falha se o `@theme` declarar qualquer `--breakpoint-{sm,md,lg,xl,2xl}` ou `--container-{md,lg,xl,2xl}` que as tabelas do teste assumem como default. Acompanha **asserção de sanidade do detector** (`--color-brand-dark`, que existe no `@theme`), sem a qual a guarda de ausência viraria `[] === []` |
| O1 | Condição `entries.length === 0 && !loading` duplicada entre effect e JSX | ⏸️ adiado | 🔵 opcional — a fase de correção não mexe em opcionais (infla o diff da correção, que precisa ficar re-revisável) |
| O2 | `container.querySelector('img')` poderia ser `botao.querySelector('img')` | ⏸️ adiado | 🔵 opcional, mesmo motivo; o risco já é neutralizado pelo `toContainElement` da linha seguinte |

### Validação por mutante da própria correção

| Mutante | Alvo | Resultado |
|---|---|---|
| `--container-lg: 36rem;` acrescentado ao `@theme` de `src/index.css` | a guarda de ausência | **VERMELHO** — `expected [ '--container-lg' ] to deeply equal []`. `src/index.css` restaurado e confirmado por `diff -q` + `git diff --stat` vazio |
| `declara` trocado por um regex que nunca casa (`^ZZZNUNCA`) | a asserção de sanidade | **VERMELHO** — `o detector de token do @theme parou de casar: expected false to be true`. Sem essa asserção o mutante deixaria a guarda de ausência **verde por vacuidade**. Arquivo restaurado e confirmado por `diff -q` |

### Correção de rota durante a implementação

A 1ª versão ancorou o caminho em `fileURLToPath(new URL('../../index.css', import.meta.url))`
— forma preferida no `api-backend` (env node). **Falhou:** `TypeError: The URL must be of scheme
file`. Sob **jsdom** o `import.meta.url` não é uma URL `file:`, e é exatamente por isso que
`tests/contrast.a11y.test.ts` — o precedente do próprio workspace — usa `process.cwd()`. Adotado o
precedente, com o motivo registrado em comentário. A leitura falha **fechada** (caminho errado ⇒
`readFileSync` lança ⇒ vermelho), nunca vira ausência silenciosa.

### Gates

```
Gates após a correção:  frontend-vite 885 · lint exit 0 · typecheck exit 0 · prune exit 0
Baseline (Passo 3):     frontend-vite 885 · lint exit 0 · typecheck exit 0 · prune exit 0
                        api-backend 620 · packages/shared 53 · portal-next 2 (não reexecutados:
                        a correção é local ao frontend-vite)
```

Re-review do diff da correção: **sem achado novo**. Verificado sobre as linhas isoladas em
`pre-fix.diff` × `pos-fix.diff` — não há caminho de erro engolido (a leitura falha fechada), não há
mudança de assinatura ou contrato (o delta é 100% arquivo de teste), não há regra duplicada de outra
camada (o detector **lê** a camada real, que é o objetivo), e o fix ataca a causa (tabela local sem
lastro) e não o sintoma. `src/index.css` está **intocado** no working tree.

Não corrigido por decisão sua: os dois 🔵 opcionais acima.
**Nada foi commitado.**
