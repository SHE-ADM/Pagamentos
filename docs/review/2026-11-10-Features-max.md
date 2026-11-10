# Code Review — Features, working tree (2026-11-10)

## Resumo
Alvo: nenhum (review do diff completo)
Modo: max (ataque + adversarial)
Delta: 12 arquivos alterados, 11 novos (fora o review anterior), +881/−106 linhas versionadas + 2.100 linhas novas
Régua: CLAUDE.md, docs/padrao-execucao.md, skills pipeline-extracao e testes-e-gates, review max de 2026-11-05
Gates: pytest 2096 · vulture 9 (os mesmos falsos positivos de rota Flask do baseline) · manifesto: o SHA-256 de `read_emails.py` bate com o arquivo · Vitest, lint, typecheck e prune não executados (nenhum TypeScript mudou) · e2e não executado (exige navegador) · SonarCloud não executado (só roda no CI)
Verificação adversarial: 2 contestações; 1 confirmado, 1 enfraquecido, 0 refutados

O delta soma as rodadas de 05/11 (cobrança, pedido interno, reembolso e honorários, já revisadas e corrigidas naquele review) e as mudanças de 07 a 09/11: o CPF de chave PIX, a NF curta, o filtro de família do `unique_invoice_number` e as migrations 151 e 152. O ataque se concentrou nas mudanças novas.

Três hipóteses caíram por medição:
- O `like` entre aspas casa a família no PostgREST real: `57` → `57(3)`, `11` → `11(2)`.
- A NF curta não afeta a dedup: só nasce no corpo, sem barcode, e a impressão por nº exige 6 dígitos ou mais.
- A varredura dos 2.002 corpos reproduz exatamente as 9 contas da 152.

O defeito real é outro: a regra do PIX também descarta o CPF próprio de um fornecedor pessoa física, e o exemplo citado no código é justamente um caso desses.

## Achados

### 🔴 Bloqueantes
Nenhum.

### 🟡 Recomendados

- [skills/email-reader/scripts/read_emails.py:5068] A regra do PIX descarta o CPF próprio de fornecedor pessoa física quando há rótulo de nome. `[verificado]`
  Falha:     e-mail 2385 (conta 1677): "NOME: DR.FLAVIO PRADO (ADVOGADO) / PIX CPF 298.479.198-36". O CPF é o do cadastro sk 1432 e agora é descartado, então a RPC recebe só o nome. O passo por nome da RPC compara `lower(unaccent())` por igualdade. Um próximo pedido grafado "DR. FLAVIO PRADO" não casa e cria fornecedor duplicado pelo auto-insert. Antes da mudança, o passo de CPF resolvia para o sk 1432 com qualquer grafia.
  Evidência: execução de `_resolve_body_supplier_identity` sobre o corpo real devolve `('DR.FLAVIO PRADO (ADVOGADO)', None, None)`. O `supplier.cpf` do sk 1432 é `29847919836`. Os casamentos por nome estão em `138_resolve_supplier_nome_longo.sql:70-88` e `008:12`. Das 5 contas cujo CPF de PIX passou a ser descartado, a 1677 é a única em que o CPF pertence ao próprio fornecedor; nas outras 4 (868, 2373, 2374 e 2396) a chave é de terceiro. O docstring (linhas 5053-5054) e o `docs/knowledge/pipeline-extracao.md` citam a 1677 como o caso "sem nome nem CNPJ, a chave segue valendo". É falso: o corpo real tem `NOME:`. O teste `test_chave_pix_sem_nome_nem_cnpj_continua_identificando` usa um corpo sintético sem essa linha.
  Correção:  decisão de negócio. Uma opção é manter o CPF quando ele já pertence a um cadastro cujo nome bate com o rotulado, e descartá-lo só quando houver CNPJ ou quando o CPF apontar para outro cadastro. Depois, corrigir o docstring, a doc e o teste com o corpo real da 1677.
  Regra:     CLAUDE.md, "Resolução de fornecedor: CNPJ → CPF → nome" e "Identificador forte que não casou ⇒ fornecedor NOVO". Regra 2: teste que promete garantia.
  Veredito:  CONFIRMADO. O impacto é moderado: hoje a grafia é idêntica ao cadastro e o sk 1432 tem uma única conta.

### 🔵 Opcionais

- [supabase/migrations/151_pix_cpf_mecanico_fornecedores.sql] `[verificado, rebaixado]` Era recomendado. O sk 1326 (JACACAR) mantém o CPF `02179782152`, que é a chave PIX de um terceiro (Eliezer Nogueira; e-mail 1302: "o pix não bate com o CNPJ da nota"). É o mesmo padrão que a 151 corrigiu no sk 1497. A RPC casaria por esse CPF, mas nenhum corpo do histórico o traz sem nome rotulado nem CNPJ. A correção custaria `UPDATE supplier SET cpf = NULL WHERE sk_supplier = 1326 AND cpf = '02179782152'`, numa migration nova.
- [skills/email-reader/scripts/read_emails.py:3556] O descarte depende de "pix" aparecer até 25 caracteres ANTES do CPF. Num texto como "CPF 021.797.821-52 (PIX)", a chave de terceiro continua valendo como identidade.
- [skills/email-reader/scripts/read_emails.py:5065] Só o primeiro CPF do corpo é avaliado. Um CPF de PIX descartado esconde um "CPF:" do fornecedor que apareça depois. População medida: 0.

## Pendências (trabalho incompleto)
- [progress.md, docs/deploy/historico-deploys.md] O deploy da NF curta e do filtro de família não está registrado, nem como feito nem como pendente — recomendada. O manifesto foi regravado às 17:12 de 09/11, depois da cópia registrada naquele dia, cuja verificação cita pytest 2081 e só o teste funcional do PIX. A suíte atual tem 2096 testes (2081 + os 15 da NF curta). Se a cópia foi anterior, a produção roda sem a regra e o `check_deploy_parity` de lá acusa divergência.
- Marcadores TODO/FIXME no diff e nos arquivos novos: nenhum.

## Drift código × documentação
- O docstring de `_resolve_body_supplier_identity`, o `docs/knowledge/pipeline-extracao.md` (e a skill) e o `historico-deploys` citam a conta 1677 como caso de chave PIX "sem nome nem CNPJ". O corpo real tem `NOME:` e o CPF é descartado. Decisão pendente do usuário, ligada a R1.
- Continuam valendo os três itens de drift do review de 05/11 sobre o CLAUDE.md (numeração das impressões de dedup e reemissão com vencimento fixado). Não foram reavaliados aqui.

## Não coberto
- Regras de 05/11 (cobrança, pedido interno, reembolso, honorários): revisadas e corrigidas no review daquele dia. Aqui foram só relidas no diff e cobertas pela suíte. Não houve novo passo de ataque sobre elas.
- `read_emails.py` foi lido nos trechos do diff e nos call sites, não por inteiro.
- As migrations 151 e 152 não foram reexecutadas, nem em ROLLBACK. Foi conferido só o estado final das famílias de número e dos cadastros.
- Não foi possível verificar o hash do `read_emails.py` em produção, porque a máquina fica em outro local.
- Achado lateral, fora do delta, levantado na contestação: o cadastro sk 1424 (sem razão social, CPF do titular da Liftec) duplica a Liftec sk 1210. As contas 1553 e 1562 ficaram divididas entre os dois cadastros. Pede curadoria.

---

## Correções aplicadas (bloco posterior ao relatório)

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| R1 | CPF próprio de PF descartado (1677) | ⏸️ adiado | Muda quem o pipeline decide ser o fornecedor (regra de negócio). Docstring, doc e teste dependem da mesma decisão |
| O1 | CPF de terceiro no sk 1326 | ⏸️ adiado | Enfraquecido; exigiria migration nova |
| P1 | Registro do deploy da NF curta | ⏸️ adiado | Doc de estado; depende de você confirmar se a cópia de produção é posterior às 17:12 de 09/11 |

Nenhuma correção automática aplicável: o único achado confirmado é decisão de negócio.
Gates: inalterados (pytest 2096 · vulture 9).
Nada foi commitado.

---

## Correções aplicadas — 2ª rodada (bloco posterior)

Pedido do usuário em 2026-11-10: resolver todos os achados e pendências, no código e nas estruturas.
Regra adotada para R1: a chave PIX com nome rotulado volta a identificar **só** quando o cadastro
confirma que o CPF já é daquele fornecedor.

| # | Item | Desfecho | Observação |
|---|---|---|---|
| R1 | CPF próprio de pessoa física descartado (1677) | ✅ corrigido | `_confirmed_pix_key_cpf` em `_finalize_supplier`, ponto único dos dois caminhos: exige um único cadastro, ativo e com o nome compatível (`_supplier_names_match`). Consulta pura `find_supplier_by_cpf`, com timeout, nova tentativa e falha que não confirma |
| D1 | Docstring, doc e teste citando a 1677 como "sem nome" | ✅ corrigido | Teste com o corpo real da 1677; o docstring e o `pipeline-extracao.md` descrevem a regra nova |
| O1 | CPF de terceiro no sk 1326 | ✅ corrigido | Migration 153: o CPF sai e a `pix_key1` fica |
| O2 | Marca PIX depois do número | ✅ corrigido | `_BODY_PIX_KEY_SUFFIX_RE`; não vale para "PIX:" (rótulo de outra chave) |
| O3 | Só o 1º CPF era avaliado | ✅ corrigido | Todos os CPFs; o CPF de identidade vence a chave PIX |
| L1 | Liftec duplicada (sk 1424 × 1210) | ✅ corrigido | Migration 153: conta 1562 → 1210, CPF e chave PIX → 1210, sk 1424 removido e sem identificadores (a RPC ignora `deleted_at`) |
| P1 | Registro do deploy da NF curta | ✅ corrigido | `progress.md`: deploy pendente declarado, com o hash do reader e o escopo que a verificação de 11-09 não cobriu |

Gates após a correção: pytest 2110 (+14) · vulture 9 · manifesto regravado (1 linha, EOL preservado)
Baseline (Passo 3):    pytest 2096 · vulture 9
Mutantes: 5 de 5 mortos (sem resgate, sem conferir o nome, sem ambiguidade/removido, sem sufixo,
ordem dos CPFs). O 5º sobreviveu à primeira bateria e ganhou um caso próprio.
Regressão no acervo (só leitura, versão anterior reconstruída e provada pelo SHA-256 do manifesto
antigo): 2.011 corpos, 0 mudanças de identidade. Resgate depois da 153: 1677 = CPF próprio;
ELG e JACACAR = descartado.
Migration 153: o 1º ensaio foi barrado por `chk_supplier_has_identifier`, sem gravar nada; corrigida
com nome-marcador. Mutante da sonda abortou em P1. Aplicada com 4 UPDATEs; reexecução = UPDATE 0.
Re-review do diff da correção: sem achado novo. A falha de consulta não confirma o CPF, que só chega
à RPC quando já está no cadastro, e a guia de tributo fica fora.

Pendente, fora do alcance do agente: cópia para produção (`read_emails.py` + `deploy-manifest.json`),
feita por você.
Nada foi commitado.
