# Prompt de correção — Código morto e dependências

> Gerado pela revisão pré-produção de 2026-07-08. Aplicar na branch `Features`.
> Origem: `docs/review/RELATORIO-CODE-REVIEW.md` §6.

```xml
<objetivo>
  Eliminar formatadores duplicados (fonte única em lib/format.ts), zerar o único achado do ts-prune
  (ADMIN_GROUP_ID), remover um formatador local redundante em Erros.tsx e corrigir o pin/comentário enganoso
  do Pillow.
</objetivo>

<read_first>
  - apps/frontend-vite/src/lib/format.ts (fmtDate :8-9, fmtDateTime :12-21, fmtMoney :24-25 — fonte única)
  - apps/frontend-vite/src/pages/cobranca/cobrancaColumns.ts (:12 fmtDate, :18-27 fmtDateTime, :29-30 fmtCurrency)
  - apps/frontend-vite/src/pages/Erros.tsx (:11 fmtDt local)
  - apps/api-backend/lib/auth.ts (:13 export const ADMIN_GROUP_ID; :121 uso)
  - apps/frontend-vite/src/contexts/AuthContext.tsx:22 (cópia independente — NÃO é import)
  - server/requirements.txt (:13 Pillow~=12.2 + comentário)
</read_first>

<achados>
  - [MÉDIO] A6-1 — cobrancaColumns.ts:12,18,29: fmtDate/fmtDateTime/fmtCurrency duplicam lib/format.ts
    (fmtDateTime idêntico byte-a-byte; fmtCurrency == fmtMoney).
  - [BAIXO] A6-2 — auth.ts:13: export const ADMIN_GROUP_ID só é usado no próprio módulo (único hit do ts-prune).
  - [BAIXO] A6-3 — Erros.tsx:11: fmtDt local redundante com fmtDateTime.
  - [BAIXO] A6-4 — requirements.txt:13: Pillow sem import direto (transitivo de pdfplumber) + comentário
    atribui a ele o trabalho do pypdf.
</achados>

<mudancas_exigidas>
  1. A6-1: em cobrancaColumns.ts, importar fmtDate, fmtDateTime, fmtMoney de '../../lib/format' e remover as 3
     cópias locais (fmtCurrency → usar fmtMoney). Manter só a constante DASH se ainda usada em outro lugar.
  2. A6-2: remover a palavra `export` de ADMIN_GROUP_ID em auth.ts (vira `const` local). NÃO usar
     ts-prune-ignore-next (não há consumidor externo real; o espelhamento no frontend é cópia de valor).
     Confirmar que requireAdminGroup segue usando a constante local.
  3. A6-3: em Erros.tsx, trocar fmtDt por fmtDateTime importado de lib/format e remover a função local.
  4. A6-4: remover o pin explícito `Pillow~=12.2` do requirements.txt (confiar no transitivo de pdfplumber)
     OU manter o pin e corrigir o comentário para "transitivo de pdfplumber" (a descriptografia/split de carnê
     é do pypdf, não do Pillow). Escolher uma das duas e deixar o comentário coerente.
</mudancas_exigidas>

<restricoes>
  - NÃO reportar/mexer nos falsos positivos: 7 rotas Flask no vulture, barrel do packages/shared no ts-prune.
  - Não alterar a semântica de ADMIN_GROUP_ID (valor 1) nem o espelhamento frontend/backend — só o `export`.
  - Não trocar a lógica de nenhuma coluna de cobrança — só a origem dos formatadores.
</restricoes>

<validacao>
  - npm run lint && npm run typecheck && npm test
  - npm run prune  → deve reportar 0 (o hit ADMIN_GROUP_ID some).
  - py -3 -m pip install -r server/requirements.txt (se remover o pin, a instalação segue via transitivo).
  - Verificar visualmente /cobranca/envios e /cobranca/erros e /erros (datas/valores formatados iguais).
</validacao>

<criterio_de_aceite>
  Gate verde e `npm run prune` reportando 0. Nenhum formatador duplicado (cobrancaColumns e Erros consomem
  lib/format). requirements.txt sem comentário enganoso. Sem mudança visível de formatação.
</criterio_de_aceite>
```
