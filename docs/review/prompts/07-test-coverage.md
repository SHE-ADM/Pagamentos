# Prompt de correção — Cobertura de testes (fechar o gate / provar o app)

> Rodar na raiz do monorepo `pagamentos`, branch `Features`. Base: `docs/review/RELATORIO-CODE-REVIEW.md`.
> Escopo: adicionar/estender testes que PROVAM o comportamento após as correções 01–06. Todo componente novo/alterado tem teste.

```xml
<objetivo>
  Garantir que cada correção das Fases 01–06 tenha teste que prove o comportamento esperado e que o app fique
  à prova de regressão: contrato dos CRUDs, interação principal de cada Form e do DataGrid, e as proteções do pipeline Python.
</objetivo>

<read_first>
  - CLAUDE.md (Regra 2 — todo componente tem teste; suítes Vitest api/frontend, pytest, a11y)
  - apps/api-backend/app/api/**/route.test.ts (padrão co-locado; ex.: app/api/emails/read/route.test.ts cobre 422/200/502)
  - apps/frontend-vite/src/components/organisms/*.test.tsx (DataGrid.test.tsx, *Form.test.tsx) e *.a11y.test.tsx
  - tests/test_status_for_result.py, test_rfc822_fetch.py, test_run_exit_code.py, test_dup_by_supplier_id.py, test_doc_type_utilities.py
</read_first>

<achados>
  - Lacunas a fechar conforme cada prompt 01–06 introduzir/alterar comportamento (status no create, cap de lookup,
    busca robusta, getEmailStats, formatters extraídos, fechamento IMAP em erro, remoção de dead code).
</achados>

<mudancas_exigidas>
  1. Vitest api-backend — para CADA CRUD (suppliers, contas, cost-centers, banks, financial-accounts, chart-accounts,
     chart-account-groups, chart-account-subgroups, users/auth), casos co-locados em app/api/**/route.test.ts:
     201 (create), 200 (get/list/patch), 400 (id inválido), 401 (sem token), 404, 409 (UNIQUE 23505 e FK/em-uso), 422 (Zod).
     Nível service para: 409 de FK/em-uso, código único (validado na app, sem UNIQUE no banco).
     Específicos das correções: POST /api/contas com `status` no corpo NÃO cria conta fechada; lookup de banks/groups/subgroups
     retorna > 100 itens; busca com termo malformado retorna vazio (não 500).
  2. Vitest frontend — render + interação principal de cada *Form (ContaForm cascata centro→plano reset; SupplierForm;
     CostCenterForm; BankForm; FinancialAccountForm; ChartAccountForm; ChartAccountGroupForm; ChartAccountSubgroupForm)
     e do DataGrid (seleção, bulk status, loadMore idempotente). Se os formatters forem extraídos para src/lib, teste unitário do módulo.
  3. pytest — completar/confirmar: status_for_result (cadeia completa), dedup (message_id + sk_supplier), _rfc822_from_fetch
     (FETCH intercalado), exit code da cobrança (DADO não reprova / OPERACIONAL reprova), classificação de doc_type
     (utilities/honorários/NF-e pura). Novo: fechamento do IMAP em caminho de erro do run_reader (mock).
  4. a11y — *.a11y.test.tsx para toda página/forma nova ou alterada sem cobertura (axe AA, tags wcag2a/2aa/21a/21aa).
</mudancas_exigidas>

<restricoes>
  - NÃO baixar cobertura existente; só adicionar/estender. Mocks de serviço seguem o padrão das páginas já testadas.
  - NÃO rodar npm run test:e2e neste ambiente (renderer do Chromium crasha na SPA — validar no CI / máquina do usuário).
  - portal-next testa via server rendering (renderToStaticMarkup), não jsdom.
</restricoes>

<validacao>
  - npm run lint
  - npm run typecheck
  - npm test
  - npm run prune
  - py -3 -m pytest tests/ -q
  - py -3 -m vulture server/ skills/ scripts/ --min-confidence 60
</validacao>

<criterio_de_aceite>
  - Gate verde (0 erro / 0 warning) com os testes novos.
  - Cada correção 01–06 tem ao menos um teste que prova o comportamento esperado.
  - Nenhuma regressão de cobertura; toda forma/página nova tem render + interação + a11y.
</criterio_de_aceite>
```
