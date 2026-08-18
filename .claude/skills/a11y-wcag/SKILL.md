---
name: a11y-wcag
description: >-
  Cumprir e verificar acessibilidade WCAG 2.1 AA no frontend do projeto `pagamentos`. Cobre as
  três camadas de verificação (jest-axe em jsdom, guardas de contraste por token e por uso, e o
  scan em navegador real com Playwright + axe), o que cada uma consegue e NÃO consegue enxergar,
  os mínimos de contraste, os requisitos do usuário de CI e os achados que só o navegador pegou.
  Acione SEMPRE que o usuário disser "acessibilidade", "a11y", "axe", "contraste", "leitor de
  tela", "navegação por teclado", "WCAG", "aria-label", "foco", ou ao criar/alterar componente,
  página ou token de cor — mesmo sem dizer "skill".
---

# Acessibilidade — WCAG 2.1 AA

Alvo: **Nível AA** em todas as telas.

## As três camadas — e o que cada uma NÃO vê

| Camada | Onde | Enxerga | **Não** enxerga |
|---|---|---|---|
| **jest-axe (jsdom)** | `*.a11y.test.tsx`, runner em `tests/axe.ts` | estrutura, nome acessível, aria | **contraste** (regra desligada), layout, e **nada dentro de `<dialog>`** |
| **Guardas de contraste** | `tests/contrast.a11y.test.ts` (tokens) · `contrast-usage.a11y.test.ts` (cores default em uso) | ratio numérico dos pares reais | pares que ninguém cadastrou |
| **Playwright + axe** | `e2e/*.a11y.e2e.ts` | contraste sob render efetivo, ordem de foco, região rolável, autofill | só o que o spec navega |

## 🔴 O axe em jsdom NÃO VARRE NADA DENTRO DE UM `<dialog>` — e passa VERDE

Medido em 2026-08-17. Sonda isolada: `<img>` sem `alt` dentro de um `<div>` → **1 violação**;
o mesmo `<img>` dentro de `<dialog open>` → **0**. Não é o atributo `open` que falta (abrir o
dialog à mão foi testado e **não** resolve), e não é a config do runner.

Ou seja, todo `expect(await axe(container)).toHaveNoViolations()` cujo conteúdo viva num
`<dialog>` está verde **sem verificar coisa alguma** — hoje `AttachmentViewer.a11y`, e pela mesma
mecânica `AiChatPanel` e `ExpenseDetailModal`.

**Consequência prática:** **não escreva caso novo de axe para conteúdo de modal** — seria a
decoração que a regra de teste do projeto proíbe. A cobertura real desses modais é a camada e2e
(onde `showModal()` existe); em jsdom, trave o requisito por **asserção DIRETA no DOM**.

## Regras práticas

- **Todo controle de formulário tem nome acessível + `id`/`name`.** Filtros recebem `aria-label`
  (para leitor de tela e axe) **e** `id`/`name` (resolve o autofill do Chrome). Campo com label
  visível usa `<label htmlFor>`. Botão só-ícone leva `aria-label`.
  > ⚠️ **Exceção conhecida: os controles react-select ficam SEM `name`, e a prop `name` NÃO
  > resolve** (medido — não repetir a tentativa). O `name` renderiza um input **OCULTO**; o campo
  > visível continua exatamente como estava. Vale para `ChartAccountSelect`, `CostCenterSelect`
  > e `SupplierSelect`.
- **Contraste:** texto normal ≥ **4.5:1**, texto grande/ícone de UI ≥ **3:1**. Controle
  desabilitado é isento (1.4.3).
- **Em superfície escura** (`bg-sidebar`), texto **claro**: `slate-300/400`, nunca `slate-500/600`
  (invertem e reprovam). **Em fundo claro**, secundário mínimo `slate-600` quando puder cair sobre
  tinta — não `slate-400/500`.
- `text-white` sobre `bg-brand` sólido **reprova** (3,4:1) — usar `bg-brand-dark`.
- 🔴 **Em linha de fundo tintado, o hover NÃO deve escurecer o fundo** — use um **anel**
  (`hover:ring-1 hover:ring-inset`). Vermelho-sobre-vermelho é intrinsecamente baixo: o texto
  `status-error-fg` sobre o hover dava **4,47:1**.

**Ratchet de contraste:** cor nova de baixo contraste vai para `KNOWN_VIOLATIONS` verificado com
`it.fails` (suíte verde, dívida visível) e, ao corrigir, sobe para `COMPLIANT` (asserção dura).
Ao introduzir cor default escura, **suba o tom** (`*-400`→`*-500`) em vez de relaxar o threshold.

## Camada e2e (Playwright)

```powershell
cd apps\frontend-vite
npx playwright install chromium      # uma vez
npm run test:e2e                     # todas (protegidas pulam sem credencial)
npm run test:e2e -- public-auth      # só login/forgot/reset
```

🔴 **NÃO executar no sandbox do agente** — o renderer do Chromium crasha ao montar a SPA completa
(limite de recursos do ambiente, não do código). Validar na máquina do usuário ou no CI.

🔴 **Rota cujo DOM muda por interação declara ESTADOS extras (`PageState`), um `test` cada.** São
três hoje. Não é enfeite: desde que os dashboards passam a abrir em `vencendo7`, a linha crítica do
`PriorityList` ficou **inalcançável em qualquer base** (o filtro exige "a vencer" e `critical`
exige "vencido"), e o `<dialog>` do drill-down só existe depois do clique.

O `enter` do estado é **tolerante à ausência** do gatilho e **intolerante à permanência** do
estado que promete deixar — sem essa asserção, um `enter` que falhasse em silêncio faria o teste
escanear o MESMO DOM duas vezes e reportar verde: **pior que não existir**, porque declararia
cobertura que não teve.

🔴 **Sem gatilho, o `enter` ANOTA** (`test.info().annotations`, tipo `estado-nao-exercitado`) — é
a terceira saída entre "falhar por falta de dado" (acopla o CI à produção) e "escanear o mesmo DOM
de novo". ⚠️ E espera um `h3` **antes** de contar gatilhos: `count()` não tem auto-wait.

O reporter emite, por nó, o **`failureSummary`** (foreground/background/ratio/esperado) **+ o HTML
do elemento** — a falha fica depurável só pelo log do CI, essencial já que o navegador não roda no
sandbox.

## Usuário do CI — duas dependências não-óbvias

Workflow: `.github/workflows/a11y.yml` (PR/push na `Features` + **`workflow_dispatch`**).
Usuário dedicado: **`teste-a11y@sheild.app.br`**, grupo **7 Financeiro**.

🔴 **Precisa de `app_metadata.password_changed = true`.** Criá-lo pelo Dashboard **não** define a
marca, e sem ela o `ProtectedRoute` manda o 1º login para `/auth/change-password`: os specs
protegidos nunca chegam a `/consulta` e falham por um motivo sem relação com acessibilidade.
Criar pela **Admin API** já com a marca e **provar o login antes de cadastrar o secret** — criar
o usuário não prova que ele loga.

🔴 **O grupo precisa ter `ai_chat_enabled = true`** — o caso "Assistente de IA — painel aberto"
clica no botão flutuante, e o gate de UI não o renderiza para grupo sem acesso. O grupo 0
(sentinela) **não pode ser liberado**: é o destino de qualquer usuário sem perfil.

**Esta é a 2ª vez que o CI aparece como dependência não-óbvia de uma mudança de autorização** — ao
mexer em grupo, papel ou flag, confira o `a11y.yml` antes.

🔴 **O disparo manual leva `require_protected` (default `true`) e FALHA CEDO** se faltar algum dos
4 secrets — sem a guarda, o `test.skip` pularia as rotas protegidas em silêncio, e "pulado" num
log de CI se lê como "passou".

## Achados que só o navegador pegou (não regredir)

| Achado | Fix |
|---|---|
| Sidebar transbordava sobre o `<main>` branco (`text-slate-400` = 2,57:1) | `nav` = **`flex-1 min-h-0 overflow-y-auto`** — rola DENTRO da sidebar escura |
| Corpo do Dashboard = região rolável sem acesso por teclado | `<section aria-label>` (papel `region` implícito, evita **S6819**) + os 5 KPIs `<button>` como descendentes focáveis — **sem** `tabIndex`, que dispararia **S6845** |
| `DataGrid` com `maxBodyHeight` sem nada focável dentro (no `ExpenseDetailModal`) | `tabIndex={0}` + `aria-label` no viewport — **a saída OPOSTA** à do Dashboard, porque ali não há conteúdo focável de carona |
| Meses esmaecidos no escopo `all` continuavam na ordem de TAB dentro de contêiner `aria-hidden` | `disabled` além de `pointer-events-none` (axe `aria-hidden-focus`, WCAG 4.1.2) |
| 45 violações de contraste nas páginas protegidas | ver "Regras práticas" |

⚠️ **Estado que só existe após interação precisa de varredura própria** — os casos de página em
repouso não o alcançam (ex.: a barra de seleção de `/consulta`, que acrescenta 5 controles a uma
linha que tinha 2 botões).

⚠️ **`toHaveAccessibleDescription` NÃO trava `aria-describedby`**: sem o atributo, o próprio
`title` vira a descrição computada e a asserção segue **verde com a ligação removida** (medido por
mutante). A guarda tem de ler o ATRIBUTO, resolver o id e conferir o texto do elemento apontado.

⚠️ **`title` não basta como ressalva** — não aparece no toque, não é focável e, com `aria-label`
presente, não é anunciado de forma confiável. Use `aria-describedby` + `<span class="sr-only">`.
