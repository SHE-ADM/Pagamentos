# Prompt de correção — Código morto e dependências

> Rodar na raiz do monorepo `pagamentos`, branch `Features`. Base: `docs/review/RELATORIO-CODE-REVIEW.md` §6.
> Escopo cirúrgico: remover o único achado real do vulture e a dep órfã confirmada. Não "limpar" falsos positivos.

```xml
<objetivo>
  Zerar o achado real do vulture (variável morta) e remover a dependência Python declarada mas nunca importada,
  sem tocar em nada que seja falso positivo conhecido. Manter o gate verde.
</objetivo>

<read_first>
  - CLAUDE.md (ts-prune/vulture — seção de lint e análise estática; deps Python)
  - skills/email-reader/scripts/read_emails.py (SUPPLIER_INPUT_FIELDS:784 — e as tuplas irmãs usadas FINANCIAL_VALUE_FIELDS:787, SKIP_ACCOUNT_TYPES:794)
  - server/requirements.txt (pypdf~=6.13:13; Pillow~=12.2:14)
</read_first>

<achados>
  - BAIXO  SUPPLIER_INPUT_FIELDS morto — read_emails.py:784 (grep no repo inteiro retorna só a definição; resíduo das colunas denormalizadas removidas em 040/041/042).
  - BAIXO  pypdf~=6.13 declarada mas nunca importada — server/requirements.txt:13 (não é transitiva de pdfplumber).
</achados>

<mudancas_exigidas>
  1. Remover a constante `SUPPLIER_INPUT_FIELDS` (read_emails.py:784) — confirmar com grep que continua sem referência
     antes de apagar. Política no-dead-code: remover, não comentar.
  2. pypdf: confirmar com o usuário/PR se há uso planejado. Se NÃO houver, remover a linha pypdf~=6.13 de server/requirements.txt.
     Se houver feature planejada, manter e adicionar comentário explicando a reserva (para o vulture/dep-audit futuro não reflagar).
</mudancas_exigidas>

<restricoes>
  - NÃO remover Pillow~=12.2: é transitiva de pdfplumber e o pin é intencional (dev/prod não divergirem).
  - NÃO "corrigir" falsos positivos: 7 rotas Flask do vulture (decoradas @app.get/@app.post); exports de barrel do
    packages/shared no ts-prune; exports com ts-prune-ignore-next (getSupabaseAdmin, ApiResponse, ReaderSummary, parsePaginationTotal).
  - NÃO mexer no espelhamento intencional enum Zod ↔ CHECK SQL ↔ constante Python (não é duplicação acidental).
  - NÃO remover deps build-time não importadas em src (eslint plugins, babel/react-compiler, tailwind, vitest/playwright, @types, ts-prune, concurrently).
</restricoes>

<validacao>
  - py -3 -m vulture server/ skills/ scripts/ --min-confidence 60   (deve restar SÓ as 7 rotas Flask — FP).
  - py -3 -m pytest tests/ -q                                       (pipeline intocado).
  - npm run prune                                                   (0 órfãos, sem regressão).
  - npm run lint / typecheck / test                                (verde).
  - Se removeu pypdf: pip install -r server/requirements.txt + py -3 skills\cobranca-vencidos\scripts\run.py --dry-run (imports OK).
</validacao>

<criterio_de_aceite>
  - vulture sem o achado SUPPLIER_INPUT_FIELDS (só restam as 7 rotas Flask, FP).
  - requirements.txt sem dep órfã (ou pypdf mantido com comentário justificando a reserva).
  - Gate verde; nenhuma dep build-time nem falso positivo removido por engano.
</criterio_de_aceite>
```
