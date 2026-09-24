# Code Review — Features, working tree (2026-09-24)

## Resumo
Alvo: nenhum (review do diff completo)
Modo: max (passo de ataque + verificação adversarial)
Delta: 5 arquivos alterados, 1 novo (`tests/test_dedup_conta_quitada.py`, 165 linhas), +111/−8 linhas versionadas. O EOL está limpo: `--ignore-cr-at-eol` dá o mesmo total.
Régua: `CLAUDE.md` (seções "Pipeline de extração — Dedup" e "Regras mandatórias §2"), `.claude/skills/pipeline-extracao/SKILL.md`, `docs/padrao-execucao.md`
Gates: pytest **1836 passed** · `check_deploy_parity.py` 32/32 (o manifesto confere com o `read_emails.py` alterado) · ruff (não é gate do projeto): 84 avisos, **a mesma contagem do HEAD**, e nenhum nas linhas do diff · Vitest/ESLint/tsc não executados (o delta não toca TS)
Verificação adversarial: 2 contestações; 1 confirmado, 1 enfraquecido, 0 refutados
Revisada a guarda "conta QUITADA não é reemitida" (`_dup_is_settled_earlier_debt`), criada a partir do caso AMIL da conta 417. A guarda está correta no caso de origem. A 1680 nasceu com a nota, e os dois mutantes ficaram vermelhos (guarda removida → 4 falhas; `status_id` fora de um select → 1 falha). Há um defeito: ao disparar, a guarda **encerra a busca** em vez de vetar só o candidato quitado. Nenhum bloqueante.

## Achados

### 🔴 Bloqueantes
Nenhum.

### 🟡 Recomendados
- [skills/email-reader/scripts/read_emails.py:6349-6358] Com a guarda disparada, o call site zera o `dup` e grava uma conta nova. Só que `find_financial_duplicate` já tinha parado na impressão 2 (ou 1b) com a conta quitada. A impressão 3 nunca é avaliada, e ela casaria a conta legítima da MESMA dívida. `[verificado]`
  Falha: AMIL (sk 141). Já existe a conta do corpo de outubro (sem barcode, R$ 7.217,91, venc. 07/10, em aberto). Chega o boleto com Nº `003071000`: a impressão 2 devolve a 417 (paga, julho), a guarda dispara e nasce outra conta. O resultado são **duas contas de outubro em aberto** (risco de pagamento em dobro), onde a impressão 3 teria enriquecido a conta do corpo com o código de barras.
  Evidência: `find_financial_duplicate` retorna na L1184, antes do bloco `base3 + ["barcode=is.null"]` (L1210). A contestação confirmou, pelo código, que esse candidato casaria. Antes do diff o dano era outro (a 417 reescrita); depois dele, passa a ser uma duplicata em aberto.
  Correção: vetar o candidato quitado DENTRO de `find_financial_duplicate`, nas impressões 1b e 2 (m=None e seguir), sob um parâmetro opt-in. O call site refaz a busca com o veto e mantém a nota.
  Regra: CLAUDE.md, "Dedup — 4 impressões" e "Reemissão atualiza a conta existente, não cria outra".
  Veredito: CONFIRMADO

### 🔵 Opcionais
- [skills/email-reader/scripts/read_emails.py:6619,6636] O caminho do CORPO (`try_extract_from_body`) trata como duplicata qualquer casamento com conta quitada, então uma dívida nova de mês seguinte, vinda só pelo corpo, seria perdida. O defeito é anterior ao diff, fica fora do delta e não tem ocorrência medida: 21 e-mails do corpo apontam para conta paga, e todos chegaram perto do vencimento dela, ou seja, é a mesma dívida. `[verificado, rebaixado]` (era recomendado; ENFRAQUECIDO pela contestação)
- [skills/email-reader/scripts/read_emails.py:1091] `_find` usa `limit=1` sem `order`. Com várias contas casando a impressão 2, qual delas volta depende do plano de execução. Medido: 12 grupos (fornecedor, Nº, valor) têm mais de uma conta, só 1 mistura quitada com aberta (1019/1040), e ali o veto de nosso número já protege.

## Pendências (trabalho incompleto)
- [progress.md] Não há linha para o caso AMIL/conta 417 nem para a cópia pendente de `read_emails.py` + `deploy-manifest.json` para produção. O diff só atualizou a linha do deploy de 23/09. — recomendada
- [docs / progress.md] A correção de DADOS foi feita fora do repositório e não está registrada: a 417 foi devolvida a julho/pago (`audit_log` de 2026-09-24 13:08:02, `ator_via='servico'`), e a 1680 foi criada pelo reprocessamento do e-mail 2382 (13:08:25). Não há migration nem nota que diga como isso foi feito. — recomendada

## Drift código × documentação
- `CLAUDE.md` ("**Reemissão** (vencimento mais recente) atualiza a conta existente, não cria outra") não cita a exceção nova da conta quitada. O mesmo vale para `docs/knowledge/pipeline-extracao.md`. A skill `pipeline-extracao` foi atualizada. — decisão pendente do usuário
- A skill diz "grava conta própria com nota" sem limitar ao caminho de ANEXO, e o caminho do corpo não aplica a regra (ver o opcional acima). — decisão pendente do usuário

## Não coberto
- A camada e2e e os gates TS não foram executados, por não se aplicarem ao delta.
- A validação funcional em produção não foi feita: o arquivo ainda não foi copiado para lá.
- Os demais consumidores de `find_financial_duplicate` (`scripts/reprocess_body_emails.py`) foram lidos só no trecho do dry-run. Esse trecho não reemite, então não herda o defeito da 417.

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| R1 | A guarda da quitada encerrava a busca da dedup | ✅ corrigido | `find_financial_duplicate(..., skip_settled=True)` veta a quitada nas impressões 1b e 2 e segue até a 3. O call site refaz a busca e só grava a nota se não achar outra conta. Testes: `QuitadaNaoEscondeContaDaMesmaDividaTest` (call site) e `VetoDentroDaDedupRealTest` (dedup real, com sanidade de que a impressão 2 rodou). Validado por mutante: sem o veto → 1 falha; sem a nova busca → 2 falhas; os dois mutantes foram revertidos (`cmp`) |
| O1 | Caminho do corpo não aplica a regra | ⏸️ adiado | Rebaixado pela contestação: é anterior ao diff e não tem ocorrência medida. Levar a regra ao corpo é mudança de regra de negócio (`skip_settled` fica opt-in) |

Gates após a correção: pytest **1840 passed (+4)** · paridade 32/32 (manifesto regravado com `--update`) · EOL limpo (o diff dá 129/9 com e sem `--ignore-cr-at-eol`)
Baseline (Passo 3):    pytest 1836 · paridade 32/32
Re-review do diff da correção: 1 achado, corrigido. Uma checagem defensiva inalcançável depois da nova busca (as impressões 1b e 2 já vetam, e a 1 e a 3 não casam quitada de vencimento anterior) foi removida pela regra "no dead code". Resíduo aceito: a complexidade cognitiva de `find_financial_duplicate` já estava muito acima do limite de 15 e subiu mais um pouco com o veto. É code smell, não confiabilidade.

Não corrigido por decisão sua: drift do `CLAUDE.md`/`docs/knowledge` (exceção da conta quitada), as 2 pendências de registro em `progress.md` (cópia para produção + correção de dados da 417/1680) e os opcionais.
Nada foi commitado.
