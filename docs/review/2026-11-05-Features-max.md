# Code Review — Features, working tree (2026-11-05)

## Resumo
Alvo: nenhum (review do diff completo)
Modo: max (ataque + adversarial)
Delta: 8 arquivos alterados, 4 novos, +412/−29 linhas versionadas + 893 linhas novas
Régua: CLAUDE.md, docs/padrao-execucao.md, skills pipeline-extracao e testes-e-gates
Gates: pytest 2016 · Vitest shared 53, api 620, frontend 926 (--maxWorkers=1) · lint 0 · typecheck OK · prune OK · vulture 9 itens, nenhum em read_emails.py do pipeline · paridade 32/32 · e2e não executado (exige navegador) · SonarCloud não executado (só no CI)
Verificação adversarial: 9 contestações; 6 confirmados, 1 enfraquecido, 0 refutados

Revisadas as três regras novas do pipeline (conversa da cobrança, pedido interno com anexo, cadeia de reembolso) e a migration 148, já aplicada. O caminho principal funciona: os casos 2215, 2227 e 2247 estão cobertos, o estado do banco confere com a 148 e 15 de 16 mutantes morreram. Os defeitos estão nas bordas dos desvios: um descarte silencioso por assunto e leitura da cadeia encaminhada onde a regra promete ler só o texto próprio. Nenhum deles ocorreu no histórico medido. A exceção dos honorários não cobre as três contas que a motivaram, e isso exige uma decisão sua.

Duas hipóteses caíram por medição antes da contestação: nenhuma trigger atual grava `supplier.email` a partir de `sender_email`, e o reenvio de boleto quitado com o mesmo barcode continua deduplicado.

## Achados

### 🔴 Bloqueantes

- [skills/email-reader/scripts/read_emails.py:6847] A exceção dos honorários libera o e-mail, mas o Passo 2 descarta a linha do anexo pelo mesmo assunto. `[verificado]`
  Falha:     interno, "RES: COBRANÇA LEBIANCO", corpo "Segue a baixa.", valor só no PDF com "Honorários" → `ignorado`, 0 contas, 0 erros, PDF no Storage sem vínculo. Vale também para boleto com barcode válido.
  Evidência: execução por `process_message`: HEAD = `extraído`, 1 conta; working tree = `ignorado`, 0 contas. `_is_receivable_notice` no HEAD devolve False para LEBIANCO e True no working tree. Para `OTIMOTEX TECIDO` já era True no HEAD: a regressão é só em LEBIANCO, e a lacuna da exceção vale para os dois.
  Correção:  com a marca `_OWN_THREAD_CLEARED_KEY`, o Passo 2 ignora o sinal de assunto, porque a decisão sobre a conversa já foi tomada.
  Regra:     CLAUDE.md, "perda silenciosa"; SKILL pipeline-extracao, "resposta interna só segue se citar honorários no corpo ou no texto do anexo".
  Veredito:  CONFIRMADO (2 de 3 lentes). A lente de impacto recomendou rebaixar: 0 respostas internas a "COBRANÇA LEBIANCO" no histórico.

### 🟡 Recomendados

- [skills/email-reader/scripts/read_emails.py:7124] O desvio valida o valor no texto próprio, mas grava o valor lido no corpo inteiro. `[verificado]`
  Falha:     "Valor: R$ 100,00" acima e "Valor total: R$ 999,00" na cadeia, com anexo → conta de R$ 999,00. No HEAD, com anexo, gravava 100,00.
  Evidência: `_extract_body_amount` devolve 999.0; execução por `process_message` confirma. Dos 72 e-mails históricos que qualificam, nenhum diverge, e só 1 tem cadeia.
  Correção:  no pedido desviado, o valor sai do texto acima da cadeia quando existir ali.
  Regra:     docs/knowledge/pipeline-extracao.md: "a guarda olha só o texto escrito pelo remetente".
  Veredito:  CONFIRMADO

- [skills/email-reader/scripts/read_emails.py:5035] `_internal_request_representative` lê frase e rótulo no corpo inteiro. `[verificado]`
  Falha:     pedido interno com "Representante: Fulano Vendedor" só na cadeia → o nome vai à `resolve_supplier`, vence e-mail cadastrado e assunto ancorado, e pode criar fornecedor por auto-insert.
  Evidência: execução: no HEAD o nome nunca chegava à RPC, com ou sem anexo. Dos e-mails internos com o rótulo, só a 2227 aciona a regra. O auto-insert em si não foi exercido: o mock prova a chamada à RPC.
  Correção:  restringir frase e rótulo ao texto acima da cadeia.
  Regra:     CLAUDE.md, "Resolução de fornecedor" e fallback 1b: quem aparece no e-mail não vira fornecedor por inferência.
  Veredito:  CONFIRMADO

- [skills/email-reader/scripts/read_emails.py:6412] A pré-validação do desvio não considera confirmação de pagamento encaminhada. `[verificado]`
  Falha:     pedido interno sobre cadeia com "Assunto: Confirmação de pagamento" → `BODY_IGNORED`: `ignorado`, 0 contas, 0 erros, sendo que sem o desvio o anexo gerava a conta.
  Evidência: execução: `ignorado`/0 no código atual; `extraído`/1 com o desvio desligado. Nenhum dos 139 e-mails internos históricos aciona a guarda. O mesmo corpo sem anexo também vira `ignorado`.
  Correção:  incluir `body_forwards_payment_confirmation` na pré-validação.
  Regra:     comentário do próprio código: "sem isto o desvio trocaria uma conta do anexo por nada".
  Veredito:  CONFIRMADO

- [tests/test_internal_request_body_wins.py:184] Nenhum teste trava a pré-validação "o corpo precisa responder de fato". `[verificado]`
  Falha:     remover a pré-validação não deixa teste vermelho; com "Valor: R$ 0,00", a conta do anexo vira 0 contas, 1 erro.
  Evidência: o mutante `return bool(True or body and ...)` sobreviveu aos testes novos e à suíte da cópia, e não é equivalente.
  Correção:  caso em `NaoDesviaTest` com valor zero no corpo.
  Regra:     CLAUDE.md, regra 2: validação por mutante.
  Veredito:  CONFIRMADO

- [tests/test_own_collection_thread.py:58] A paridade com a rotina de cobrança cobre os assuntos, não a frase do corpo. `[verificado]`
  Falha:     mudar a frase em `template.py` desliga a detecção de resposta com assunto reescrito, sem teste vermelho, e a resposta volta a virar conta.
  Evidência: `_OWN_COLLECTION_BODY_RE` (read_emails.py:6326) só é exercida contra o literal `CORPO_2247`; nenhum teste lê o template.
  Correção:  o teste de paridade passa a ler `template.py`.
  Regra:     CLAUDE.md, regra 2: guarda que compara duas camadas precisa ler a outra camada.
  Veredito:  CONFIRMADO

### 🔵 Opcionais

- [skills/email-reader/scripts/read_emails.py:6360] `[verificado, rebaixado]` Era recomendado. A exceção dos honorários não se comprova nos casos 161, 166 e 182: executada com o `email_body_excerpt` real, a regra ignora os três. Rebaixado porque ignorá-los parece correto: os corpos dizem "baixada" e "desconsidere", e o PDF da 166 é um "Cancelar (Baixar)" do Itaú, sem honorários. Decisão sua, abaixo.
- [skills/email-reader/scripts/read_emails.py:6844] O comentário ainda cita "COBRANCA OTIMOTEX" como exemplo de recebível, e esse assunto agora é justamente o caso que segue.
- [skills/email-reader/scripts/read_emails.py:6687] Quando nenhum anexo gera linha, o pedido interno cai no fallback do corpo sem vincular os arquivos. Reproduzido com 1 foto sem linha: 1 conta, 0 anexos. Comportamento anterior ao diff, é o mesmo sintoma da 1ª foto da 2227.
- [skills/email-reader/scripts/read_emails.py:6721] O comentário "o trigger alinha supplier.email" está obsoleto: nenhuma trigger atual da fato toca `supplier`. Fora do delta.

## Pendências (trabalho incompleto)
- [progress.md] Copiar para produção e reiniciar o Flask; regras não exercitadas em produção — recomendada
- [scheduler/deploy-manifest.json] Regravar o manifesto após qualquer correção em read_emails.py — bloqueante para o deploy
- Marcadores TODO/FIXME no diff e nos arquivos novos: nenhum

## Drift código × documentação
- read_emails.py diverge de docs/knowledge/pipeline-extracao.md, SKILL pipeline-extracao, docs/db/historico-migrations.md e migration 148: citam 161, 166 e 182 como honorários preservados pela exceção, mas a regra nova ignoraria esses e-mails — decisão pendente do usuário
- read_emails.py diverge de CLAUDE.md: o CLAUDE.md numera 4 impressões, com valor + vencimento na 4ª, e o código e a skill a chamam de "impressão 3". "Desliga a impressão 3" lido pelo CLAUDE.md apontaria para nº do documento + valor, que continua ativa — decisão pendente do usuário
- read_emails.py diverge de CLAUDE.md: "`DUE_DATE_FIXED_KEY` desliga a reemissão" vale só para barcode igual ou ausente; barcode novo ainda atualiza a conta, e há teste travando isso — decisão pendente do usuário

## Não coberto
- e2e e SonarCloud não executados.
- read_emails.py lido nos trechos do diff e nos call sites, não por inteiro.
- A caixa IMAP deste ambiente não guarda junho: a análise de 161, 166 e 182 usa `email_body_excerpt` (759–823 caracteres) e só o PDF da 166. Os PDFs da 161 e da 182 não foram lidos.
- Backtests contam só e-mails com `body_full`; os antigos têm apenas `body_preview` de 500 caracteres.
- `scripts/retry_extraction.py` e `reprocess_link_emails.py` não passam corpo a `extract_and_store_accounts`: a cadeia de reembolso só vale ali para remetente imediato. Comportamento declarado como opt-in, não exercido.
- Migration 148 não reexecutada: conferido só o estado final no banco.
- Risco declarado na documentação e não reavaliado: qualquer elo "De:" do Dr. Ricardo captura a conta, inclusive as 3 que os usuários deixaram fora do sk 1262.

---

## Correções aplicadas (bloco posterior ao relatório)

Decisão do usuário em 2026-11-05: citar honorários no assunto ou no corpo gera conta; as contas 161, 166 e 182 são honorários, confirmado por Rose e Bárbara.

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| B1 | Descarte pelo assunto | ✅ corrigido | Passo 2 respeita a conversa liberada |
| R1 | Confirmação encaminhada | ✅ corrigido | Pré-validação do desvio |
| R2 | Valor da cadeia | ✅ corrigido | Valor do texto próprio, agora exigido para desviar |
| R3 | Representante da cadeia | ✅ corrigido | `_text_above_forward_chain` |
| R4 | Pré-validação sem teste | ✅ corrigido | Caso de valor zero |
| R5 | Paridade da frase | ✅ corrigido | Teste lê `template.py` |
| R6 | Exceção dos honorários | ✅ corrigido | Critério do usuário; contas mantidas; e-mails delas não citam a palavra |
| O1–O4 | Opcionais | ✅ corrigido | Comentários; anexo sem linha agora se vincula |
| N1 | Citação barrada por filtros e pelo download | ✅ corrigido | `run_reader`, guardas do corpo |
| N2 | E-mail 1720: sem identificador, sem conta e sem erro | ✅ corrigido | Consulta pura com desempate por histórico; sk 1 com nota; dead-man switch |
| N3 | Assunto livre viraria fornecedor pelo auto-insert | ✅ corrigido | Regressão da própria regra, achada na revisão integral |
| N4 | Honorários sem credor colidiam na dedup | ✅ corrigido | Veto em valor + vencimento |
| N5 | Latin-1 sem charset escondia a citação | ✅ corrigido | `_decode_body_part` |
| N6 | Dr. Ricardo barrado por contexto de seguro/transporte | ⏸️ adiado | Regra de negócio; população medida = 0 |

Gates após a correção: pytest 2060 (+44) · paridade 32/32 · vulture 9 · mutantes 32 de 32 mortos
Baseline (Passo 3):    pytest 2016 · paridade 32/32 · vulture 9
Não reexecutados: Vitest, lint, typecheck e prune, porque nenhum TypeScript mudou.
Re-review do diff da correção: revisão integral de read_emails.py achou N3 a N6; sem achado aberto depois deles.
Prova real, só leitura: `find_honorarios_supplier_by_name("Wesley")` = 1188 contra o banco; reexecução da 148 em ROLLBACK = 0 linhas e sondas verdes.

Não coberto que permanece: e2e (nenhuma tela mudou) e SonarCloud (só roda no PR). A caixa IMAP começa em 22/10 e os PDFs da 161 e da 182 não existem no Storage.
Nada foi commitado.

---

## Correções aplicadas — 2ª rodada (bloco posterior)

Decisões do usuário em 2026-11-05: e-mail do Dr. Ricardo sempre gera conta; a conta do e-mail 1720 é lançada
por migration, vencendo no dia do lançamento e com observação de atraso; a conta falsa 2343 é cancelada.

| # | Item | Desfecho | Observação |
|---|---|---|---|
| N6 | Dr. Ricardo barrado por contexto de seguro/transporte | ✅ corrigido | Era adiado; resolvido pela regra `_forces_account`, que também cobre NF, cobrança, lembrete e confirmação |
| N7 | E-mail 1720 sem conta | ✅ corrigido | Migration 149: conta 2346, R$ 450,00, primeira na ordem padrão de `/consulta` (provado pela sonda) |
| N8 | Conta falsa 2343, gravada pela versão anterior ao deploy | ✅ corrigido | Migration 150: cancelada; achada na conferência pós-deploy |
| N9 | Instrução de "reiniciar o Flask" em produção | ✅ corrigido | Produção não tem Flask; doc e skill passam a dizer "só no DEV" |

Gates após a 2ª rodada: pytest 2072 · mutantes 38 de 38 mortos · paridade 32/32 · vulture 9
Produção: hash do `read_emails.py` igual ao do repositório e `LastTaskResult` 0, conferidos pelo usuário.
Migrations 149 e 150: ensaio em ROLLBACK antes; a 150 teve um erro de sintaxe na sonda, barrado no ensaio sem gravar nada.
Nada foi commitado.
