# Prompt de correção — Frontend (design tokens, contraste AA, código morto de UI)

> Gerado pela revisão pré-produção de 2026-07-08. Aplicar na branch `Features`.
> Origem: `docs/review/RELATORIO-CODE-REVIEW.md` §3. Contém o único achado ALTO do code review.

```xml
<objetivo>
  Fechar as reprovações de contraste WCAG AA (text-white sobre bg-brand sólido = 3,4:1) em botões do Dashboard
  e da Consulta, o gradiente btn-primary, e os KPIs de Erros.tsx usando cor default do Tailwind para estado
  semântico. Adicionar guard de contraste para o par branco/brand e escanear o Dashboard no e2e. Limpar tokens
  @theme órfãos e um tamanho tipográfico arbitrário.
</objetivo>

<read_first>
  - apps/frontend-vite/src/index.css (@theme: brand/brand-dark, status-*, loginGreen-*; @utility btn-primary :129-132)
  - apps/frontend-vite/src/pages/Dashboard.tsx (:117, :280, :225)
  - apps/frontend-vite/src/pages/Consulta.tsx (:715, :726)
  - apps/frontend-vite/src/pages/Erros.tsx (:116-135 KPIs; :28-34 rowClass já usa status-*)
  - apps/frontend-vite/src/components/ColumnVisibilityMenu.tsx:32 e GridToolbar.tsx:29 (padrão bg-brand-dark correto)
  - apps/frontend-vite/src/components/statusBadge.variants.ts:52-60 (mapa error_type → status-*)
  - apps/frontend-vite/src/components/AttachmentViewer.tsx:96 (amber default no aviso)
  - apps/frontend-vite/src/components/Layout.tsx:165-172 (botão logout só-ícone)
  - apps/frontend-vite/tests/contrast.a11y.test.ts e contrast-usage.a11y.test.ts (guards)
  - apps/frontend-vite/e2e/protected.a11y.e2e.ts:11-15 (PROTECTED_PAGES)
</read_first>

<achados>
  - [ALTO] A3-1 — Dashboard.tsx:117,280 e Consulta.tsx:715,726: text-white sobre bg-brand sólido = 3,40:1
    (botões text-xs, texto normal) — reprova AA (≥4,5:1). Sem guard cobrindo branco/brand; Dashboard fora do
    e2e PROTECTED_PAGES.
  - [MÉDIO] A3-2 — index.css:129-132 (@utility btn-primary): text-white sobre gradiente from-brand→to-brand-dark
    reprova na metade clara (from-brand ~3,40:1).
  - [MÉDIO] A3-3 — Erros.tsx:116-135: text-red-500/red-600/amber-600/orange-600/purple-500 (cor default para
    estado semântico; regra 1). red-500/red-600/purple-500 fora do ratchet de contrast-usage.
  - [BAIXO] A3-4 — Dashboard.tsx:225: text-[10px] (tipografia arbitrária proibida).
  - [BAIXO] A3-5 — index.css: tokens @theme órfãos sem uso: --color-loginGreen-surface (:60),
    --color-loginGreen-borderLight (:65), --background-image-gradient-login-green (:77), --color-brand-glow (:7),
    --color-auth-teal (:53).
  - [BAIXO] A3-6 — AttachmentViewer.tsx:96: bg-amber-50 text-amber-600 (aviso em cor default; whitelisted, mas
    inconsistente com regra 1).
  - [BAIXO] A3-7 — Layout.tsx:165-172: botão só-ícone (LogOut) com title mas sem aria-label.
  - [BAIXO] A3-8 — e2e/protected.a11y.e2e.ts: PROTECTED_PAGES não inclui o Dashboard (rota /) — as violações de
    contraste do Dashboard nunca são escaneadas em navegador real.
</achados>

<mudancas_exigidas>
  1. A3-1/A3-2: trocar `bg-brand` sólido com texto branco por `bg-brand-dark` (#0f6e56 = 6,3:1) nos botões
     citados (padrão já usado em ColumnVisibilityMenu/GridToolbar). No btn-primary, iniciar o gradiente mais
     escuro (ex.: from-brand-dark) OU garantir que o texto assente em região ≥4,5:1 — validar no Playwright.
  2. A3-1 (guard): adicionar ao contrast.a11y.test.ts a asserção do par branco/brand (deve reprovar como texto
     normal) e/ou branco/brand-dark (deve passar), travando a regressão.
  3. A3-3: mapear os KPIs de Erros.tsx para tokens status-* (status-error-fg / status-warning-fg /
     status-neutral-fg), coerente com o StatusBadge (statusBadge.variants.ts) que já pinta os mesmos error_type
     via status-*. Se a diferenciação de 6 hues for intencional, no mínimo registrar os pares no guard de
     contraste (contrast-usage) — mas o preferível é o token semântico.
  4. A3-4: trocar text-[10px] por text-xs.
  5. A3-5: remover os 5 tokens @theme órfãos do index.css (confirmar 0 uso em src/ antes).
  6. A3-6: trocar bg-amber-50/text-amber-600 por status-warning-bg/status-warning-fg no AttachmentViewer.
  7. A3-7: adicionar aria-label="Sair" ao botão de logout do Layout.
  8. A3-8: adicionar a rota do Dashboard (/) ao PROTECTED_PAGES do e2e a11y.
</mudancas_exigidas>

<restricoes>
  - NÃO alterar o "chrome neutro" do grid (slate/zinc em fundo/borda/ícone do DataGrid — exceção documentada).
  - NÃO tocar em style={{}} inline com valores dinâmicos (larguras %, conic-gradient do donut) — legítimos.
  - Manter os arbitrários de LAYOUT aceitos (max-w-[21rem], border-[6px], ring-4) — só tipografia arbitrária é alvo.
  - Não rodar `npm run test:e2e` no sandbox do agente (renderer crasha) — validar no CI / máquina do usuário.
</restricoes>

<validacao>
  - npm run lint && npm run typecheck && npm test  (inclui contrast.a11y.test.ts e contrast-usage.a11y.test.ts)
  - npm run prune
  - No CI / máquina do usuário: `cd apps/frontend-vite && npm run test:e2e -- protected` (com Dashboard incluído)
    → 0 violação de color-contrast.
</validacao>

<criterio_de_aceite>
  Gate verde. Nenhum par branco/brand sólido com texto normal (todos migrados para brand-dark ou reforçados).
  Guard de contraste cobre branco/brand. KPIs de Erros.tsx em tokens status-*. Dashboard escaneado no e2e a11y
  sem violação. Tokens @theme órfãos removidos; sem text-[Npx] em tipografia.
</criterio_de_aceite>
```
