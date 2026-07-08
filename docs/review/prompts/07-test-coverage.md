# Prompt de correção — Cobertura de testes (fechar o gate / provar o app)

> Gerado pela revisão pré-produção de 2026-07-08. Aplicar na branch `Features`.
> Origem: `docs/review/RELATORIO-CODE-REVIEW.md` §7. Contratos de rota já 100% cobertos — fechar lacunas.

```xml
<objetivo>
  Cobrir as duas ações-chave do /consulta sem teste (loadMore idempotente e alteração de situação em lote),
  o teste a11y ausente do Dashboard, o teste funcional ausente do ResetPasswordForm e das páginas
  Erros/CobrancaErros, e a dedup por message_id no pytest.
</objetivo>

<read_first>
  - apps/frontend-vite/src/components/organisms/DataGrid.tsx (onLoadMore/hasMore; bulkStatusOptions/onBulkStatusChange; applyingBulk :852-864)
  - apps/frontend-vite/src/components/organisms/DataGrid.test.tsx (o que já cobre)
  - apps/frontend-vite/src/pages/Consulta.tsx (loadMore :280 + loadingMoreRef; handleBulkStatusChange :359)
  - apps/frontend-vite/src/pages/Consulta.test.tsx
  - apps/frontend-vite/src/pages/Dashboard.tsx + Dashboard.test.tsx (falta .a11y.test.tsx)
  - apps/frontend-vite/src/components/organisms/ResetPasswordForm.tsx + ResetPasswordForm.a11y.test.tsx
  - apps/frontend-vite/src/components/organisms/LoginForm.test.tsx (modelo de teste funcional de form de auth)
  - apps/frontend-vite/src/pages/Erros.tsx / pages/cobranca/CobrancaErros.tsx
  - skills/email-reader/scripts/read_emails.py (is_processed :248) + tests/test_body_duplicate.py (padrão FakeCtrl)
</read_first>

<achados>
  - [MÉDIO] A7-1 — DataGrid.test.tsx + Consulta.test.tsx: loadMore (scroll infinito) e bulk status em lote sem teste.
  - [BAIXO] A7-2 — Dashboard.tsx sem *.a11y.test.tsx (única page de dados sem axe).
  - [BAIXO] A7-3 — ResetPasswordForm.tsx só tem a11y, sem teste funcional.
  - [BAIXO] A7-4 — Erros.tsx e cobranca/CobrancaErros.tsx só têm a11y, sem teste de página.
  - [BAIXO] A7-5 — is_processed (dedup por message_id) sem pytest.
</achados>

<mudancas_exigidas>
  1. A7-1: no DataGrid.test.tsx, adicionar (a) teste de loadMore — disparar o gatilho de "carregar mais" duas
     vezes rapidamente e asseverar que onLoadMore é chamado UMA vez enquanto loading (idempotência via guarda);
     (b) teste de bulk status — selecionar linhas, escolher uma situação e clicar Aplicar → onBulkStatusChange
     recebe os ids selecionados + o status; e que applyingBulk trava o duplo Aplicar. No Consulta.test.tsx,
     cobrir handleBulkStatusChange chamando setFinancialAccountStatusBulk (mock) com id=in.(…) + update otimista.
  2. A7-2: criar Dashboard.a11y.test.tsx (mockando getDashboardData) com expect(await axe(container)).toHaveNoViolations().
  3. A7-3: criar ResetPasswordForm.test.tsx (render + submit da nova senha + validação de confirmação divergente
     + updateUser/signOut mockados), espelhando LoginForm.test.tsx.
  4. A7-4: criar Erros.test.tsx e CobrancaErros.test.tsx cobrindo render + a interação principal (filtro/seleção
     para reprocesso), com os serviços mockados.
  5. A7-5: adicionar caso pytest para is_processed — FakeCtrl retornando existência por message_id → o e-mail é
     pulado (dedup), e ausência → é processado. Reusar o padrão de test_body_duplicate.py.
</mudancas_exigidas>

<restricoes>
  - Não alterar código de produção para "facilitar" teste além do estritamente necessário (o alvo é cobertura).
  - Manter os testes de portal-next por server rendering (renderToStaticMarkup) — não migrar aqui.
  - Não rodar test:e2e no sandbox do agente (renderer crasha) — os novos testes a11y são jsdom (jest-axe).
</restricoes>

<validacao>
  - npm test  (todos os workspaces verdes; novos testes passam)
  - py -3 -m pytest tests/ -q  (novo caso de is_processed passa)
  - npm run lint && npm run typecheck  (sem regressão)
</validacao>

<criterio_de_aceite>
  loadMore idempotente e bulk status cobertos em DataGrid e Consulta; Dashboard com a11y; ResetPasswordForm e
  as páginas Erros/CobrancaErros com teste funcional; is_processed com pytest. Suíte 100% verde.
</criterio_de_aceite>
```
