# S5 — Frontend: CSV/formula injection na exportação

> Base: `docs/review/seguranca/RELATORIO-SEGURANCA.md` §5. Único achado MÉDIO acionável do frontend.

```xml
<objetivo>
  Neutralizar a injeção de fórmula no CSV exportado de /consulta (conteúdo de e-mail hostil que sai do
  navegador para o Excel/Sheets), sem alterar o conteúdo legítimo nem o resto do export. Documentar o gap
  de defesa-em-profundidade da feature flag de IMAP.
</objetivo>

<read_first>
  - apps/frontend-vite/src/pages/Consulta.tsx (exportCsv:99-111 e a montagem das linhas)
  - apps/frontend-vite/src/lib/featureFlags.ts
  - CLAUDE.md (memória vercel-deploy — Flask local-only)
</read_first>

<achados>
  - MÉDIO M1: CSV/formula injection — exportCsv (Consulta.tsx:99-111) escapa aspas e remove \r\n mas NÃO neutraliza
    células iniciando com `= + - @` (ou \t/\r). Colunas com conteúdo do remetente: email_body_excerpt, description,
    processing_notes, invoice_number. Vetor: corpo iniciando com `=HYPERLINK(...)` / `=cmd|'/c calc'!A1`.
  - INFO N2: featureFlags.EMAIL_READER_ENABLED é defesa só de UI; o endpoint Flask segue alcançável (impacto nulo hoje, Flask local-only).
</achados>

<correcao>
  1. Em exportCsv, ao montar cada célula, sanitizar fórmula ANTES de envolver em aspas:
     - `const cell = /^[=+\-@\t\r]/.test(String(v ?? '').trimStart()) ? "'" + v : v;` e então aplicar o escaping de aspas atual.
     - Aplicar a TODAS as colunas de texto livre (no mínimo as 4 citadas), idealmente a todas as células string.
  2. Teste (Vitest): exportCsv com uma linha cujo description = `=HYPERLINK("http://x")` → a célula no CSV começa com `'`
     (prefixo) e o conteúdo legítimo (ex.: `Nota 123`) permanece intacto. Cobrir também `+`, `-`, `@`.
  3. N2 (documentação, sem código): registrar no CLAUDE.md (seção featureFlags) que esconder o botão NÃO é controle de
     acesso — se o Flask for exposto numa VM, os endpoints de disparo precisam de auth própria (ver S4 M-1).
</correcao>

<restricoes>
  - NÃO alterar o conteúdo legítimo das células (só prefixar quando iniciar com caractere de fórmula).
  - NÃO introduzir dependência nova; manter o export client-side. NÃO mexer no resto do CSV (cabeçalho, separador, BOM se houver).
</restricoes>

<validacao>
  - npm run lint && npm run typecheck && npm test
  - npm run prune
  - Vetor: abrir o CSV exportado de um registro com description começando por `=` e confirmar que o Excel NÃO avalia a fórmula.
</validacao>

<criterio_de_aceite>
  - Células iniciando com = + - @ \t \r saem prefixadas com `'` no CSV; conteúdo normal inalterado (teste cobre ambos).
  - Gate verde; nota de defesa-em-profundidade da flag documentada.
</criterio_de_aceite>
```
