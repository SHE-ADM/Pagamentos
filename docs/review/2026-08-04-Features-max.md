# Code Review — Features (2026-08-04)

## Resumo

Alvo: "Pendências e Achados" — **não resolvido** (nenhum documento de plano com esse nome; o termo
casa apenas docs genéricos). Review do **diff completo**, conforme Passo 0 item 2.
Modo: **max** (passo de ataque + verificação adversarial)
Delta: 9 arquivos alterados, 2 novos, +661/−32 linhas
Régua: `CLAUDE.md` (raiz) + `.claude/rules/` do workspace Sheild
Gates: pytest **1066** · vitest frontend **748**/141 arq. · api-backend **523**/50 arq. · portal-next **2**
· lint **0/0** · typecheck **OK** · ts-prune **0** · vulture limpo · check_deploy_parity **27/27**
· e2e **não executado** (exige navegador — proibido no sandbox pelo CLAUDE.md)
Verificação adversarial: **3 contestações; 1 confirmado, 1 enfraquecido, 1 refutado**

O delta cobre duas correções de pipeline (fornecedor pelo corpo rotulado; guia de arrecadação com
total a recolher + data-limite) e um ajuste de exibição do fornecedor no frontend. O passo de ataque
enumerou 4 vetores contra a base real e **o código resistiu aos 4** — nenhum bloqueante. O único
achado que sobreviveu à contestação é uma lacuna de garantia de teste: a coluna alterada não tem
teste que trave o comportamento novo.

## Achados

### 🔴 Bloqueantes

Nenhum.

O vetor de ataque mais forte foi medido e resistiu: o id 375 é um **boleto bancário real** (moeda
`9`) cujo código de 44 dígitos começa com `8`, e portanto é aceito por `arrecadacao_44`. Se passasse,
`amount_from_arrecadacao` leria as posições 5-15 (que num boleto são fator+valor) e **sobrescreveria
um valor correto com lixo**. Medido: o DV de arrecadação o refuta **e** o valor embutido
(R$ 577.545.900,02) cai fora da faixa `0 < v < 5.000.000`. Duas barreiras independentes.
Complementarmente, dos 8 códigos refutados na base **nenhum** tem valor embutido plausível
(R$ 946 mi, R$ 694 mi, …) — são leituras truncadas do Vision, corretamente rejeitadas; o DV **não**
é falso negativo.

### 🟡 Recomendados

- [apps/frontend-vite/src/hooks/useGridColumns.test.ts:44-50] O teste da coluna "Fornecedor" não
  trava o comportamento novo do wiring — uma regressão no render passaria despercebida.
  Falha:     a coluna passou a renderizar `fmtSupplierName(r.supplier)`, mas nenhuma fixture de
             teste usa `trade_name` e `legal_name` divergentes contra ela. Alguém "simplificar" o
             render de volta para só o nome fantasia não quebra nada — e o fornecedor cadastrado com
             marca ("PEGAMIL" para ITW PPF) volta a ficar irreconhecível no grid, em silêncio.
  Evidência: mutante `fmtSupplierName(r.supplier).split(' · ')[0]` — que restaura exatamente o
             comportamento antigo mantendo o import usado — passa **748/748 testes E typecheck
             limpo**. (O mutante mais ingênuo, `r.supplier?.trade_name ?? '—'`, é pego pelo `tsc`
             com TS6133 por deixar o import órfão; isso detecta "símbolo órfão", não "a célula
             perdeu a razão social" — por isso a evidência decisiva é o mutante que mantém o import.)
             `getConsultaColumns` tem só 2 consumidores: o próprio teste e `Consulta.tsx:573`.
             `format.test.ts` (8 casos) testa a função **pura** e segue verde sob o mutante.
  Correção:  acrescentar ao teste da coluna um caso com nomes divergentes
             (`PEGAMIL` / `ITW PPF BRASIL ADESIVOS LTDA` → `PEGAMIL · ITW PPF BRASIL ADESIVOS LTDA`),
             validado por mutante.
  Regra:     CLAUDE.md §2 — "Teste que promete uma garantia tem de entregá-la" / "validação por
             mutante: teste que não falha quando o defeito existe não é teste, é decoração".
  Veredito:  **CONFIRMADO** [verificado]

### 🔵 Opcionais

- [useGridColumns.ts:467 · Emails.tsx:635-637] `fmtSupplierName` não aplicado na superfície
  adjacente (coluna Fornecedor do drill-down de `/dashboard_despesas` e lista de contas de
  `/emails`) — o mesmo fornecedor aparece de formas diferentes conforme a tela.
  **[verificado, rebaixado]** — era 🟡; a contestação mostrou que a régua adotada é **por
  superfície**, não universal (no CSV a razão social virou coluna própria em vez de concatenação,
  por ser planilha), que existe superfície onde aplicar seria **errado**
  (`services/supabase.ts:853` `supplierName` é **chave de agregação** do ranking do dashboard —
  mudá-la trocaria a identidade do balde) e que o pedido do usuário foi específico ao grid de
  `/consulta`. O defeito de consistência existe, mas é decisão de produto por tela.
- [Consulta.tsx:1063] O cabeçalho do painel ("Detalhes — {trade_name}") mostra só o fantasia,
  enquanto o campo "Fornecedor" logo abaixo já traz fantasia + razão social — divergência
  intra-tela. Informação não se perde (está no campo abaixo); é preferência de UI.
- [Consulta.tsx:62] `fmtSupplier` compara o retorno do helper com o literal `'—'`; se o sentinela
  do helper mudar, o detalhe passa a exibir `1193 - —` sem nada acusar.
- [read_emails.py:_body_supplier_identity] usa `search` (primeiro rótulo do corpo). Se o bloco do
  PAGADOR vier antes do bloco do fornecedor, a guarda de raiz descarta o CNPJ e a função devolve
  `(None, None, None)` — degrada para o comportamento anterior, não corrompe.

## Pendências (trabalho incompleto)

Nenhuma. Varredura com o padrão do rito (marcador em caixa alta com fronteira de palavra + formas
`@todo`/`todo:`) sobre diff versionado **e** untracked: 0 `TODO`/`FIXME`/`HACK`/`XXX`/`WIP`,
0 stubs (`NotImplementedError`, corpo vazio), 0 testes pulados (`@skip`, `it.skip`, `it.fails`),
0 blocos de debug. As duas ocorrências de `print(` no diff são os comandos de validação de deploy
documentados no CLAUDE.md.

## Drift código × documentação

- `CLAUDE.md:146` afirma que o `npm test` "soma **1.231** no Node"; medido nesta execução:
  **1.273** (frontend 748 + api-backend 523 + portal 2). Divergência de +42, da qual só +8 vêm
  deste delta — o restante já estava defasado. Decisão pendente do usuário (o rito proíbe
  sincronizar doc durante o review, sob pena de apagar a evidência da divergência).

## Não coberto

- **e2e (Playwright + axe)** não executado: exige navegador; o CLAUDE.md registra que o renderer do
  Chromium crasha no sandbox do agente. Deve rodar no CI (`.github/workflows/a11y.yml`).
- **`CLAUDE.md`** (253 linhas do diff) revisado pelos hunks alterados, não relido por inteiro — é
  documentação, e o drift acima foi buscado por consulta dirigida.
- **Contaminação de uma contestação (erro de método deste review, declarado):** disparei os três
  subagentes em paralelo e instruí um deles a aplicar mutante em `useGridColumns.ts` — o mesmo
  arquivo que outro subagente estava lendo. O segundo leu o estado transitório e concluiu que a
  coluna não usava o helper. Verifiquei depois: o arquivo está íntegro
  (`render: (r) => fmtSupplierName(r.supplier)`) e `npx eslint` sai com **exit 0**. A refutação de
  R2 por essa via **não procede**; o veredito de R2 acima foi apurado apenas pelos argumentos
  independentes da premissa falsa. **Lição: contestação que muta arquivo precisa rodar isolada** —
  em série, ou sobre cópia.
- **Camada de dados**: as correções de dado desta sessão (31 guias GNRE, conta 822) não estão no
  diff e não foram re-verificadas aqui; foram conferidas no momento da aplicação.
