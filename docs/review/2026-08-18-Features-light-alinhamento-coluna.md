# Code Review — Features / alinhamento de coluna da tabela do chat (2026-08-18)

## Resumo

Alvo: "Alinhamento de coluna" — **nenhum documento de plano casou** o termo
(`git ls-files '*.md' | grep -iE 'alinha|coluna|column|align'` → vazio; `grep -ril` em `.md` →
vazio). A correção nasceu de um pedido direto sobre a captura de tela do chat, sem plano escrito.
Review do **diff completo**, sem estreitamento.
Modo: light (sem passo de ataque, sem verificação adversarial)
Delta: 2 arquivos alterados, 0 novos, +67/−7 linhas
Régua: `CLAUDE.md` (projeto), `CLAUDE.md` (workspace Sheild), `CLAUDE.md` (global),
`.claude/skills/frontend-ui/SKILL.md`, `.claude/skills/testes-e-gates/SKILL.md`,
`docs/padrao-execucao.md`
Gates: vitest `apps/frontend-vite` **920 passed / 146 arquivos** (`--maxWorkers=1`) · lint raiz
**0/0** (4 workspaces) · typecheck raiz **OK** · ts-prune raiz **0** · pytest **não executado —
`No module named pytest` no `.venv`** · e2e Playwright **não executado — renderer crasha no
sandbox do agente** (regra do projeto) · SonarCloud **não consultado — só roda no CI do PR**

A mudança troca o alinhamento de tabela do chat de **por célula** para **por coluna** em
`MarkdownMessage`, alinhando o `<th>` junto com os números que ele nomeia, e passa a completar
linhas mais curtas que o cabeçalho. O desenho está correto e é o mínimo necessário: nenhuma
regra de negócio foi tocada, nenhum token de cor foi criado, nenhum `useMemo` manual entrou, e
os utilitários compartilhados (`table-header`, `table-cell`) ficaram intactos — `DataGrid` e
`/erros`, que os consomem, não são afetados. Os 5 testes novos foram validados por mutante
(4 mutantes distintos, 4 vermelhos). Um achado recomendado: o critério de "célula que não vota"
cobre a célula **vazia**, mas não o **traço** — o placeholder que o próprio prompt do chat
tende a produzir para valor ausente — e uma única linha com traço desfaz a correção na coluna
inteira.

## Achados

### 🔴 Bloqueantes

Nenhum.

### 🟡 Recomendados

- [apps/frontend-vite/src/components/molecules/MarkdownMessage.tsx:38-54] Célula de placeholder
  ("—", "–", "-") **vota** na classificação da coluna e a desqualifica inteira, desfazendo a
  correção exatamente no caso que o chat mais produz.
  Falha:     resposta com `| Fornecedor | Atraso médio |` onde uma linha traz `| OBER | — |`
             (a régua do chat manda declarar ausência: "`atraso_medio_dias` … vem NULL quando
             não houve nenhuma") → `NUMERIC_CELL_RE.test('—')` é `false` → `return false` →
             a coluna toda volta a alinhar à esquerda, cabeçalho e valores, que é o defeito
             que este diff existe para corrigir.
  Evidência: `NUMERIC_CELL_RE = /^(R\$\s*)?-?[\d.,\s]+%?$/` exige **ao menos um** caractere de
             `[\d.,\s]`, então nem `-` nem `–`/`—` casam; e o laço em `numericColumns` derruba
             a coluna no primeiro reprovado, sem tolerância. O caso vazio já tem tratamento
             (`if (text === '') continue;`), o de traço não — a mesma semântica com dois
             comportamentos.
  Correção:  estender a regra de "não vota" ao placeholder de traço (`/^[-–—]+$/`), na mesma
             linha do `continue` da célula vazia, com teste que o cubra.
  Regra:     consistência interna com a decisão já tomada no próprio diff ("Célula vazia não
             desqualifica a coluna; ela só não vota") — nenhum doc do projeto legisla sobre
             isso.

### 🔵 Opcionais

- [MarkdownMessage.tsx:107-119] Linha com **mais** células que o cabeçalho agora alarga a tabela
  inteira (uma coluna vazia sem `<th>` em todas as linhas), onde antes só aquela linha ficava
  irregular. É trade-off deliberado — a alternativa (cortar em `header.length`) perderia dado em
  silêncio, o pior dos três desfechos —, mas vale registrar a mudança de comportamento.
- [AiChatPanel.tsx:373 + MarkdownMessage.tsx:84] Durante o **streaming**, a classificação da
  coluna é recalculada a cada token: uma coluna numérica pode "pular" para a esquerda quando
  chega uma linha de texto. Transitório, e o bloco é `aria-hidden`, então não afeta leitor de
  tela.

## Pendências (trabalho incompleto)

Nenhuma. Varredura de marcadores (`TODO|FIXME|HACK|XXX|WIP`, `@todo`, `todo:`) sobre o diff:
0 ocorrências. Nenhum `it.skip`/`xit`, nenhum `console.log`, nenhum stub.

## Drift código × documentação

Nenhum. O único doc que fala da renderização de markdown do chat é
`docs/arquitetura-chat-ia-pagamentos.md:1214`, e ele descreve a existência do parser próprio
(`lib/markdownLite.ts`), não a regra de alinhamento — que não está escrita em lugar nenhum e,
portanto, não diverge de nada. O `CLAUDE.md` não menciona `MarkdownMessage`.

## Não coberto

- **pytest não executado** — `python -m pytest` falha com `No module named pytest` no `.venv` do
  projeto. O diff não toca nenhum arquivo `.py`, então o risco de regressão ali é nulo, mas o
  gate fica declarado como não medido.
- **Camada e2e (Playwright + axe) não executada** — regra do projeto: o renderer crasha no
  sandbox do agente ao montar a SPA. É justamente a camada que enxergaria contraste sob render
  efetivo; como o diff não cria nem altera cor, a exposição é baixa.
- **SonarCloud não consultado** — roda no CI do PR. Lint local verde não garante PR verde
  (regra 5 do `CLAUDE.md`).
- **Baseline dos gates não medido em worktree isolado** — instalar as dependências numa cópia
  custaria mais que o valor da medição para um diff de 2 arquivos. O incremento de **+5 testes**
  é aritmético (7 → 12 casos no arquivo alterado, total 920), não medido contra o commit
  anterior.
- **Modo light** — sem passo de ataque e sem contestação adversarial dos achados; nenhum achado
  aqui carrega marca `[verificado]`.

---

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| R1 | Placeholder de traço desqualificava a coluna inteira | ✅ corrigido | `MarkdownMessage.tsx:44` — `BLANK_CELL_RE = /^[-–—]*$/` (o `*` absorve o caso vazio, que antes tinha regra própria). Teste novo: "traço de 'sem dado' não desalinha a coluna numérica". **Mutante** (`/^$/`, traço volta a votar) → VERMELHO, revertido e conferido com `diff -q` |
| O1 | Linha mais longa que o cabeçalho alarga a tabela | ⏸️ adiado | 🔵 opcional — o rito não corrige opcionais, e a alternativa (cortar em `header.length`) perderia dado em silêncio |
| O2 | Alinhamento reclassificado a cada token no streaming | ⏸️ adiado | 🔵 opcional — transitório, bloco `aria-hidden`, sem efeito para leitor de tela |

Gates após a correção: vitest `apps/frontend-vite` **921 (+1)** / 146 arquivos · lint raiz **0/0** ·
typecheck raiz **OK** · ts-prune raiz **0**
Baseline (Passo 3):    vitest **920** · lint **0/0** · typecheck **OK** · ts-prune **0**
Re-review do diff da correção: **sem achado novo**. A constante é local e não exportada
(`ts-prune` segue em 0), o `*` do regex preserva o comportamento do caso vazio, nenhuma
assinatura ou contrato mudou e nenhum caminho de erro foi introduzido. Um ajuste saiu do próprio
re-review: o comentário do `BLANK_CELL_RE` afirmava como fato que "o modelo escreve `—`" —
reescrito para descrever a grafia usual em tabela, sem documentar comportamento não medido.
Estado final reconferido depois do ajuste de comentário: `MarkdownMessage` + `AiChatWidget` +
`AiChatWidget.a11y` → 37 testes passando.

Não corrigido por decisão sua: os dois 🔵 opcionais acima.
Nada foi commitado.
