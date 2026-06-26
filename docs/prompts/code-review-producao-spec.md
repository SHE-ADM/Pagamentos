# Code Review completo — gate de produção (pagamentos)

> Prompt para Claude Code. Modelo recomendado: **claude-opus-4-8** (análise cross-layer,
> muitos arquivos). Rodar na branch `Features`, a partir da raiz do monorepo
> `C:\Sheild\Projetos\Claude\Contas a pagar\Pagamentos`.
> Entrega: **relatório `.md`** + **prompts XML de correção separados por área**.
> Esta sessão NÃO altera código de produção — só lê, executa validações e ESCREVE
> arquivos dentro de `docs/review/`.

```xml
<task>
  Faça um code review completo e profissional (nível sênior) do monorepo `pagamentos`,
  cobrindo TODAS as camadas: frontend-vite, api-backend (Next), pipeline Python
  (server + skills), SQL/migrations e a suíte de testes. O objetivo final é deixar o app
  À PROVA DE FALHAS e 100% pronto para produção, com o gate:
  lint + typecheck + test + prune + vulture TODOS limpos (0 erro / 0 warning).

  Trabalhe em DUAS FASES, nesta ordem. NÃO pule a Fase 1.
</task>

<hard_rules>
  - NÃO altere nenhum arquivo de produção nesta sessão. A única escrita permitida é
    dentro de `docs/review/` (relatório + prompts XML de correção).
  - Leia os arquivos REAIS antes de afirmar qualquer coisa. Proibido inferir
    comportamento sem abrir o arquivo. Toda afirmação do relatório cita
    `caminho/arquivo.ts:linha`.
  - Respeite as regras do CLAUDE.md como FONTE DE VERDADE das convenções. Um "desvio"
    só é achado se contraria o CLAUDE.md ou quebra em produção — decisões já
    documentadas (ex.: extração in-process, manualChunks como função, ESLint 9/10
    carve-out, dual-mode dos lookups, cancelado no grid mas fora dos KPIs) NÃO são bugs.
  - Severidade obrigatória em todo achado: BLOCKER | CRÍTICO | ALTO | MÉDIO | BAIXO.
    BLOCKER/CRÍTICO = impede produção. Justifique a severidade.
  - Não invente vulnerabilidade nem reporte falso positivo conhecido (rotas Flask no
    vulture, exports de barrel no ts-prune do shared, `useReactTable` bail-out do React
    Compiler). Liste-os numa seção "Falsos positivos esperados".
</hard_rules>

<read_first>
  <!-- Convenções e contexto -->
  - CLAUDE.md   (autoridade de convenções — ler integralmente)
  - README.md
  - package.json (scripts da raiz: dev, test, typecheck, lint, prune)

  <!-- Contrato de tipos compartilhado -->
  - packages/shared/src/**  (todos os *.schema.ts e o barrel index.ts)

  <!-- Next API: repository → service → route + infra -->
  - apps/api-backend/lib/response.ts
  - apps/api-backend/lib/auth.ts
  - apps/api-backend/lib/supabase-admin.ts
  - apps/api-backend/lib/lookups.ts
  - apps/api-backend/lib/suppliers.ts
  - apps/api-backend/lib/contas.ts
  - apps/api-backend/lib/cost-centers.ts
  - apps/api-backend/lib/banks.ts
  - apps/api-backend/lib/financial-accounts.ts
  - apps/api-backend/lib/chart-accounts.ts
  - apps/api-backend/lib/chart-account-groups.ts
  - apps/api-backend/lib/chart-account-subgroups.ts
  - apps/api-backend/lib/users.ts
  - apps/api-backend/middleware.ts
  - apps/api-backend/app/api/**/route.ts   (todas as rotas e seus *.test.ts)

  <!-- Frontend: serviços, hooks, grid, forms, páginas -->
  - apps/frontend-vite/src/services/**     (supabase.ts, contas.ts, suppliers.ts, lookups.ts, dataApi.ts, cobrancaService.ts, emailReader.ts, etc.)
  - apps/frontend-vite/src/lib/**          (cn, authStorage, supabaseClient, chunkReload, featureFlags, getErrorMessage)
  - apps/frontend-vite/src/hooks/**        (useGridPreferences, useGridColumns, useContainerBreakpoint, useIdleLogout)
  - apps/frontend-vite/src/contexts/AuthContext.tsx
  - apps/frontend-vite/src/components/organisms/**  (DataGrid, ContaForm, CrudTablePage, todos os *Form.tsx)
  - apps/frontend-vite/src/components/molecules/**  (SupplierSelect, CostCenterSelect, ChartAccountSelect, GridToolbar, ColumnVisibilityMenu)
  - apps/frontend-vite/src/pages/**        (Consulta, Emails, Erros, ContasNovaPage, SuppliersPage, Dashboard, tabelas/*, cobranca/*)
  - apps/frontend-vite/src/App.tsx
  - apps/frontend-vite/vite.config.ts

  <!-- Pipeline Python -->
  - server/app.py
  - skills/email-reader/scripts/read_emails.py
  - skills/pdf-contas-pagar/scripts/extract_pdf.py
  - skills/cobranca-vencidos/scripts/*.py   (run, send_core, resend, db_firebird, email_sender, supabase_log, template, failure_notify)
  - scripts/*.py                            (retry_extraction, reprocess_*)
  - server/requirements.txt

  <!-- Banco -->
  - supabase/migrations/*.sql               (001→054 — varrer RLS, CHECK, FKs, triggers, GRANTs)

  <!-- Testes existentes -->
  - tests/**.py                             (pytest do pipeline)
  - apps/frontend-vite/tests/**, e2e/**
  - **/*.test.ts, **/*.test.tsx, **/*.a11y.test.tsx
</read_first>

<phase_1_diagnostico>
  Produza `docs/review/RELATORIO-CODE-REVIEW.md`. NÃO escreva código de correção aqui;
  só diagnóstico. Estruture EXATAMENTE assim:

  ## 0. Sumário executivo
  - Veredito de produção (PASSA / NÃO PASSA) + contagem de achados por severidade.
  - Tabela: área × nº de BLOCKER/CRÍTICO/ALTO/MÉDIO/BAIXO.

  ## 1. Resultado das validações (executar e COLAR a saída real)
  Rode na raiz e registre status + trecho relevante de cada um:
  - `npm run lint`        (frontend-vite + api-backend + portal-next + packages/shared)
  - `npm run typecheck`
  - `npm test`            (Vitest — todos os workspaces)
  - `npm run prune`       (ts-prune nos 3 apps — deve ser 0)
  - `py -3 -m pytest tests/ -q`
  - `py -3 -m vulture server/ skills/ scripts/ --min-confidence 60`
  Para CADA falha/warning: arquivo:linha, causa raiz, e se entra no gate.

  ## 2. Auditoria dos CRUDs (um bloco por recurso)
  Recursos: suppliers, contas, cost-centers, banks, financial-accounts, chart-accounts,
  chart-account-groups, chart-account-subgroups, users/auth.
  Para cada um, verifique e marque OK/ACHADO:
  - **Contrato REST**: status codes corretos (201 vs 200 no create; 409 em UNIQUE 23505 e
    em FK/em-uso; 404; 422 Zod; 400 id inválido); envelope `{success,...}` consistente;
    verbo↔ação correto.
  - **Camadas**: Repository → Service → Route sem vazamento (service_role nunca no path
    do anon; nenhuma query crua escapando do service).
  - **Validação Zod**: schema de input bate com o CHECK/NOT NULL do banco; campos
    derivados (status_id, sk_supplier, *_id IDENTITY, created/updated_at) NÃO aceitos no
    corpo; selects obrigatórios vazios normalizados (NaN→0) antes do safeParse.
  - **Dual-mode** (cost-centers, chart-accounts, banks, groups, subgroups): `?page`=CRUD
    vs sem page=lookup — confirmar que o caminho de lookup ficou INTOCADO e a cascata
    centro→plano não regrediu.
  - **Delete**: soft vs hard correto; bloqueio 409 por FK cobrindo TODAS as referências;
    sentinela id 0 protegido; DELETE removido da UI mas rota preservada.
  - **Write-back de classificação** (contas→supplier): só quando cc>0 E ca>0; best-effort
    (falha não derruba a resposta); não roda no path da extração Python.
  - **Race/duplicação**: alteração de status em lote (id=in.(...)), criação concorrente,
    código único validado na app (sem UNIQUE no banco) — janela de corrida?

  ## 3. Frontend — qualidade e desperdício
  - **Requisições desnecessárias / N+1**: refetch por tecla (debounce form vs applied),
    duplo-fire de loadMore (loadingMoreRef), poll redundante, fetch em effect sem cleanup,
    chamadas que poderiam ser 1 (lookups repetidos por render).
  - **Código morto / redundância**: helpers/format duplicados entre Consulta.tsx e
    useGridColumns.ts; componentes/exports órfãos; `key`/`prefillNonce` indevidos;
    variantes CVA não usadas.
  - **React Compiler**: `useMemo`/`useCallback`/`React.memo` manuais proibidos remanescentes;
    set-state-in-effect; impureza no render (Date.now no escopo de render).
  - **Tailwind v4**: cor default usada para estado semântico (deveria ser token status-*);
    classe concatenada quebrando o JIT (`bg-x-${var}`); `style` inline com token disponível.
  - **DataGrid**: measureElement em detail rows; persistência de preferências com chave
    obsoleta (gridId/stale keys); virtualização (scrollRect stale) regredida; seleção
    `__select__` vazando para as prefs.
  - **Acessibilidade**: control sem nome acessível/id; contraste de TEXTO abaixo de AA
    (lembrar que jsdom não pega; cruzar com contrast-usage + e2e).

  ## 4. Pipeline Python — robustez (não-regressão)
  Confirme as 8 proteções do CLAUDE.md ainda presentes (in-process, IMAP timeout+retry,
  Claude API timeout, _rfc822_from_fetch, dedup message_id, dedup conteúdo por sk_supplier,
  _finalize_supplier antes do INSERT, bloqueio de domínio interno). Verifique status_for_result,
  prioridade anexo→link→corpo, classificação de doc_type, e o exit code da cobrança
  (DADO não reprova, OPERACIONAL reprova). Aponte exceções engolidas silenciosamente,
  except amplo demais, e qualquer `subprocess.run([... extract_pdf.py])` (proibido).

  ## 5. SQL / migrations
  - RLS: toda tabela com RLS habilitado tem policy (sem default-deny acidental como o caso
    pré-049); leitura `TO authenticated`, escrita `TO service_role`; GRANTs por coluna
    (reviewed_at; has_invoice/has_bank_slip) corretos.
  - CHECK constraints alinhados 1:1 com os z.enum do shared; FKs e sentinela id 0
    consistentes; triggers de status/supplier sem efeito colateral inesperado.
  - Idempotência/ordem das migrations (aplicação manual 001→054).

  ## 6. Código morto, redundância e dependências (cross-cutting)
  - ts-prune e vulture consolidados com classificação (remover vs ignore-next justificado).
  - Dependências não usadas em package.json/requirements.txt; imports órfãos.
  - Duplicação de lógica entre Flask e Next que deveria ser fonte única.

  ## 7. Plano de ataque priorizado
  Lista ordenada (BLOCKER→BAIXO) com esforço estimado (S/M/L) e a qual prompt XML da
  Fase 2 cada item pertence.

  ## 8. Falsos positivos esperados
  Itens que NÃO devem ser "corrigidos" (decisões documentadas + ruído de ferramenta).
</phase_1_diagnostico>

<phase_2_prompts_de_correcao>
  Com base no relatório, gere prompts XML de correção SEPARADOS POR ÁREA, um arquivo por
  prompt, em `docs/review/prompts/`. NÃO aplique as correções — só escreva os prompts,
  prontos para eu rodar depois no Claude Code. Crie apenas os prompts cujas áreas tiveram
  achados (não gere prompt vazio):

  - `01-next-api-cruds.md`        (contrato REST, status codes, Zod↔banco, dual-mode, delete/409)
  - `02-frontend-grid-forms.md`   (DataGrid, ContaForm/cascata, requisições desnecessárias, React Compiler)
  - `03-frontend-design-a11y.md`  (tokens Tailwind v4, contraste AA, código morto de UI)
  - `04-python-pipeline.md`       (robustez/não-regressão, except amplo, exit codes)
  - `05-sql-migrations.md`        (RLS, CHECK↔enum, FKs — se exigir migration nova, numerar a partir de 055)
  - `06-dead-code-deps.md`        (ts-prune, vulture, deps órfãs, duplicação)
  - `07-test-coverage.md`         (testes novos que fecham o gate — ver abaixo)

  CADA prompt XML deve conter, no mínimo:
  <objetivo>, <read_first> (arquivos REAIS do achado), <achados> (com arquivo:linha e
  severidade), <mudancas_exigidas> (passo a passo), <restricoes> (o que NÃO mexer —
  citar os falsos positivos), <validacao> (comandos abaixo) e <criterio_de_aceite>
  (gate verde + comportamento esperado).

  O prompt `07-test-coverage.md` deve especificar testes que PROVEM o app:
  - Vitest api-backend: para cada CRUD, casos 201/200/400/401/404/409/422 co-locados em
    `app/api/**/route.test.ts`; service-level para 409 de FK/em-uso e código único.
  - Vitest frontend: render + interação principal de cada *Form e do DataGrid (seleção,
    bulk status, loadMore idempotente, cascata reset).
  - pytest: cobrir status_for_result, dedup, _rfc822_from_fetch, exit code da cobrança,
    classificação de doc_type — completando lacunas que o relatório apontar.
  - a11y: *.a11y.test.tsx para toda página/forma nova sem cobertura.
</phase_2_prompts_de_correcao>

<comandos_de_validacao>
  Gate de produção (TODOS devem sair limpos — 0 erro / 0 warning):
  - npm run lint
  - npm run typecheck
  - npm test
  - npm run prune
  - py -3 -m pytest tests/ -q
  - py -3 -m vulture server/ skills/ scripts/ --min-confidence 60
  Cobrança (sem enviar e-mail): py -3 skills\cobranca-vencidos\scripts\run.py --dry-run
  NÃO rodar `npm run test:e2e` neste ambiente (o renderer do Chromium crasha na SPA;
  validar no CI / máquina do usuário).
</comandos_de_validacao>

<entregaveis>
  1. docs/review/RELATORIO-CODE-REVIEW.md
  2. docs/review/prompts/0X-*.md  (apenas os necessários)
  Ao final, imprima no chat um resumo: contagem por severidade, veredito de produção e a
  ordem recomendada para aplicar os prompts da Fase 2.
</entregaveis>
```
