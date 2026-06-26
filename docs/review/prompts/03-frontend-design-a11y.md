# Prompt de correção — Frontend (design tokens, contraste AA, código morto de UI)

> Rodar na raiz do monorepo `pagamentos`, branch `Features`. Base: `docs/review/RELATORIO-CODE-REVIEW.md` §3 (Tailwind v4 / Acessibilidade).
> Escopo: `apps/frontend-vite`. Tokens semânticos e contraste AA.

```xml
<objetivo>
  Eliminar a última cor semântica fora de token (hex hardcoded no Dashboard) criando tokens status-*,
  e confirmar o contraste AA dos cards de /consulta na camada de navegador. Manter o gate e os guards de contraste verdes.
</objetivo>

<read_first>
  - CLAUDE.md (Regra 1 — tokens; "Guia de cores — paleta semântica status"; Regra 6 — a11y)
  - apps/frontend-vite/src/index.css  (bloco @theme — paleta status-* / loginGreen-*)
  - apps/frontend-vite/src/pages/Dashboard.tsx (mapa de cores do donut:27-28 — prorrogado '#7c3aed', baixado '#0e7490')
  - apps/frontend-vite/src/pages/Consulta.tsx (cards:564, label:587 — text-slate-500 sobre branco)
  - apps/frontend-vite/tests/contrast.a11y.test.ts (guarda dos tokens do projeto)
  - apps/frontend-vite/tests/contrast-usage.a11y.test.ts (guarda das cores default em uso — array COMPLIANT / it.fails)
  - apps/frontend-vite/e2e/*.a11y.e2e.ts (camada navegador — NÃO rodar aqui)
</read_first>

<achados>
  - BAIXO  Hex hardcoded em mapa semântico de status — Dashboard.tsx:27-28 (prorrogado/baixado sem token status-*).
  - MÉDIO (verificar em navegador) Cards de /consulta usam text-slate-500 (~4,7:1) — Consulta.tsx:564,587 (par de menor margem AA da página).
</achados>

<mudancas_exigidas>
  1. Tokens status-* para prorrogado/baixado:
     - Adicionar ao bloco @theme de src/index.css os tokens semânticos faltantes (ex.: --color-status-prorrogado-fg / -bg
       e --color-status-baixado-fg / -bg) com valores que cumpram AA, e trocar os hex de Dashboard.tsx:27-28 pelas
       variáveis var(--color-status-*). Alinhar com o mapeamento já usado pelas demais entradas do donut.
     - Acrescentar o par ao guard tests/contrast.a11y.test.ts (mínimo AA travado).
  2. Contraste dos cards /consulta:
     - Validar o par text-slate-500/branco. Se o número/label pequeno ficar abaixo de AA, subir o tom (ex.: slate-600)
       conforme o padrão documentado (Guia de cores — grid). jsdom não pega contraste; o veredito final é da camada
       e2e (Playwright + axe) — descrever a verificação no PR; rodar no CI / máquina do usuário, NÃO neste ambiente.
     - Se subir o tom, mover o par para o array COMPLIANT de tests/contrast-usage.a11y.test.ts (ratchet, não regredir).
</mudancas_exigidas>

<restricoes>
  - NÃO misturar paletas (loginGreen só nas telas de auth; status-* no app).
  - NÃO usar cor default do Tailwind para estado semântico nem concatenar classe (`bg-x-${var}`) — quebra o JIT.
  - NÃO desligar a regra color-contrast nos guards; o ratchet é para SUBIR o tom, não relaxar o limite.
  - Falso positivo: o "chrome neutro" do DataGrid (slate/zinc em fundo/bordas/ícones SVG) é exceção documentada — só TEXTO precisa AA.
</restricoes>

<validacao>
  - npm run lint
  - npm run typecheck
  - npm test            (inclui contrast.a11y.test.ts e contrast-usage.a11y.test.ts)
  - npm run prune
  - NÃO rodar npm run test:e2e neste ambiente (validar a camada navegador no CI).
</validacao>

<criterio_de_aceite>
  - Gate verde, incluindo os dois guards de contraste.
  - Dashboard sem hex semântico hardcoded (prorrogado/baixado via token status-*).
  - Par de contraste dos cards /consulta cumpre AA (confirmado no guard de uso e, idealmente, na camada e2e do CI).
</criterio_de_aceite>
```
