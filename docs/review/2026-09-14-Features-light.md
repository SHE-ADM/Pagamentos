# Code Review — Features, working tree (2026-09-14)

## Resumo
Alvo: nenhum (review do diff completo)
Modo: light (sem passo de ataque, sem verificação adversarial)
Delta: 13 arquivos (10 alterados, 3 novos staged: migration 136 + 2 testes), +1440/−14 linhas; sem untracked; sem ruído de EOL (`--ignore-cr-at-eol` idêntico)
Régua: CLAUDE.md (raiz) §Pipeline de extração, §Regra 2 (testes), §Banco; docs/padrao-execucao.md via CLAUDE.md; skill pipeline-extracao
Gates: pytest 1681 passed (exit 0) · ruff (não é gate do projeto, sem config) delta +1 BLE001 +2 DTZ007 em read_emails.py e 2 RUF100 nos testes novos · vulture exit 3 igual ao baseline (itens de 60% já existentes, nenhum novo) · manifesto de deploy: SHA-256 de read_emails.py confere · npm test/lint/typecheck/prune: não executados (o delta não tem TS/JS) · e2e: não executado (exige navegador) · migration 136: não reaplicada nem conferida no banco (exige credencial; o doc afirma que foi aplicada)

Revisados: a guarda "razão social da pagadora não é fornecedor" (`_is_own_company_name`), o lembrete de
vencimento que corrige data presumida (`apply_due_date_reminder` + marca `DUE_DATE_PRESUMED_NOTE`), a
migration de dados 136, os testes e as docs. O código está bem guardado: há teste de call site
executado, anti-vacuidade e PATCH condicional. Há dois buracos no invariante novo "data lida/confirmada
nunca é movida": a marca de presumido não sai em dois caminhos que confirmam a data.

## Achados

### 🔴 Bloqueantes
Nenhum.

### 🟡 Recomendados

- [skills/email-reader/scripts/read_emails.py:6325] Lembrete que CONFIRMA a data de uma conta presumida (ação ALREADY) não troca a marca de presumido pela de confirmado.
  Falha:     Conta 1474: a migration 136 grava 27/09 com a marca de presumido "para que o próximo lembrete confirme". Os lembretes de setembro ("27/09") caem em ALREADY e a marca continua presumido. Em 17/10, com a 1474 ainda em aberto: (a) se a fatura de outubro gerou conta presumida, duas presumidas ⇒ AMBIGUOUS e a conta de outubro nunca é corrigida; (b) se não gerou, a 1474 é a única presumida e o vencimento 27/09 (já confirmado pelo fornecedor) é MOVIDO para 27/10, sem erro nenhum. É exatamente o cenário que a regra "data confirmada nunca é movida" existe para impedir.
  Evidência: `if action == REMINDER_ALREADY: log.info(...); return None`, sem escrita; o comentário da migration 136 (linhas 36-38) promete a confirmação.
  Correção:  No ALREADY, se o alvo tiver a marca de presumido, gravar só a marca de confirmado (PATCH condicional com o mesmo `due_date`).
  Regra:     docs/knowledge/pipeline-extracao.md § LEMBRETE DE VENCIMENTO ("data confirmada nunca é movida"); migration 136 § Decisões por conta.

- [skills/email-reader/scripts/read_emails.py:5837] O caminho de dedup/reemissão do anexo reescreve `due_date` (ou confirma a data via barcode) numa conta presumida sem tirar a marca.
  Falha:     Conta do corpo presumida (vencimento = emissão). Chega o boleto em PDF da mesma dívida, que casa pela impressão 2 (nº do documento + valor) com vencimento mais novo ⇒ `update_financial` grava o vencimento LIDO do boleto e mantém "Vencimento presumido" nas Observações. Um lembrete posterior do fornecedor (outra fatura, candidata única) move uma data lida de código de barras. O ramo `elif new_barcode` (impressão 3, mesma data) tem o mesmo defeito. Viola "vencimento lido de rótulo/tabela/barcode nunca é sobrescrito", que o delta aplicou em `_apply_barcode_due_date` e nas parcelas, mas não neste 3º escritor de `due_date`.
  Evidência: patches das linhas 5838-5844 e 5854-5859 sem `processing_notes`; `_find` seleciona só `id,due_date,barcode`, então nem é possível saber se a dup tem a marca.
  Correção:  Incluir `processing_notes` no select da dedup e, nos dois patches, remover a marca quando a dup a tiver.
  Regra:     CLAUDE.md § Caminho email_body, "LEMBRETE DE VENCIMENTO corrige só data PRESUMIDA".

- [skills/email-reader/scripts/read_emails.py:2553] O fallback 6 (`_resolve_supplier_by_payer`) ainda manda a razão social da pagadora à RPC, e o cadastro 404 (CDI) continua com essa razão social.
  Falha:     Boleto sem fornecedor extraível, com `payer_name = "TEXTIL E CONFECCOES OTIMOTEX LTDA"` e sem `payer_cnpj` de 14 dígitos ⇒ a RPC casa por nome com LIMIT sem ORDER BY entre os sk 1 e 404 ⇒ a conta pode ir para a CDI e herdar a classificação dela. É o mesmo ímã, pela outra porta.
  Evidência: linhas 2352-2356 (`probe["supplier_name"] = payer_name`), fora da guarda; historico-migrations.md afirma "a guarda Python impede que o nome chegue à RPC".
  Correção:  Decisão sua: limpar a `legal_name` do 404 numa migration nova, ou fazer o fallback 6 resolver a pagadora por `sk_supplier` fixo em vez do nome.
  Regra:     CLAUDE.md § Resolução de fornecedor.

### 🔵 Opcionais
- [pagamentos.code-workspace:6] Configuração pessoal de editor (`terminal.integrated.allowChords`) misturada ao delta da feature; o arquivo segue sem newline no fim.
- [requirements-dev.txt:6] `ruff~=0.16` entrou sem configuração no repo e sem gate em CI/scripts. Rodado sem config, ele acusa centenas de itens já existentes e 2 RUF100 (`# noqa: E402` sem efeito) nos testes novos.
- [supabase/migrations/136_fornecedor_pagadora_e_leadster.sql:925] A 2ª nota da 1474 ("27/09/2026 inferido…; o próximo lembrete confirma ou corrige") sobrevive à troca de marca e fica desatualizada depois da confirmação.
- [skills/email-reader/scripts/read_emails.py:6140] `_REMINDER_EXPLICIT_DUE_RE` casa "vence em DD/MM/AAAA" em qualquer e-mail sem conta, inclusive boleto de outra fatura com extração falha. O efeito é mitigado pelo candidato único presumido; é risco residual aceito pelo desenho.
- [skills/email-reader/scripts/read_emails.py:447] Falha transitória na leitura de `company` deixa a guarda por nome desligada pelo resto do run (cache vazio). O padrão já existia para o CNPJ; o log é só warning.

## Pendências (trabalho incompleto)
- [progress.md:91] Deploy de `read_emails.py` + `deploy-manifest.json` na máquina de produção — recomendada (ação manual sua).
- [requirements-dev.txt:6] ruff adicionado sem integração a gate nem configuração — opcional.

## Drift código × documentação
- `read_emails.py` (`_resolve_supplier_by_payer`) diverge de `docs/db/historico-migrations.md` (§136, "a guarda Python impede que o nome chegue à RPC"): o fallback 6 envia o nome da pagadora à RPC. Decisão pendente sua.
- `read_emails.py` (ALREADY sem confirmar) diverge de `supabase/migrations/136…sql` (cabeçalho: "mantido com a marca de PRESUMIDO para que o próximo lembrete do fornecedor o confirme"). A correção de código resolve; o texto da migration não muda.
- `docs/knowledge/pipeline-extracao.md` afirma "12 mutantes validados": não reverificado neste review.

## Não coberto
- Estado real do banco depois da 136 (contas 29/337/497/978/1474, sk 4, sk 404): sem consulta ao Supabase.
- A RPC `resolve_supplier_id` (ordem CNPJ → nome, LIMIT sem ORDER BY) foi tomada pelo que o doc descreve, sem ler o SQL.
- Os ~6700 linhas de `read_emails.py` foram lidas só nos hunks e nos vizinhos diretos: dedup, `_finalize_supplier`, `_company_cnpj_map`, call site em `process_message`.
- Outros escritores de `due_date` fora de `read_emails.py` (Next API/PATCH manual, scripts de reprocessamento) não foram conferidos. Uma edição manual do vencimento mantém a marca de presumido, e um lembrete posterior pode mover a data que o operador corrigiu à mão.
- Suítes TS e e2e não executadas (o delta não toca TS).

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| R1 | Lembrete ALREADY não confirma a data presumida | ✅ corrigido | `apply_due_date_reminder`: ALREADY sobre conta presumida grava a marca de confirmado (PATCH condicional, mesma data) e a nota do e-mail diz "confirmado". Testes `test_lembrete_que_repete_a_data_presumida_a_confirma` (inclui a prova de que o lembrete de 27/10 deixa de mover a 1474) e `test_lembrete_repetido_de_data_ja_confirmada_nao_escreve`. Mutante M1 vermelho |
| R2 | Dedup/reemissão não retira a marca de presumido | ✅ corrigido | `processing_notes` entrou no SELECT da dedup (impressões 1, 1b e 3); os dois patches retiram a marca; `update_financial` ganhou `nullable` porque descartava o `None`. 4 testes novos + 1 asserção; mutantes M2 a M7 vermelhos |
| R3 | Fallback 6 envia a razão social da pagadora à RPC (sk 404) | ⏸️ adiado | Código fora do delta; exige decisão sua: migration nova limpando a `legal_name` do 404, ou fallback 6 por `sk_supplier` fixo |

Gates após a correção: pytest 1687 (+6) · ruff em read_emails.py sem item novo · vulture exit 3 idêntico · manifesto regravado (SHA-256 confere) · EOL limpo
Baseline (Passo 3):    pytest 1681 · ruff delta +1 BLE001 +2 DTZ007 · vulture exit 3 · manifesto conferido
Re-review do diff da correção: a rodada 1 tinha defeito. `update_financial` descarta `None`, então a marca que era a única nota nunca saía em produção, e o teste de enriquecimento só passava porque o FakeControl não filtra: era falso guarda. Corrigido na rodada 2 com `nullable` e com um teste que executa o filtro real. O mutante M7 (sem `nullable` no call site da reemissão) sobreviveu e foi fechado com asserção. Nenhum achado novo depois da rodada 2.

Mudança de comportamento a registrar: um lembrete que confirma data presumida agora marca o e-mail como `ignorado` (`reminder_applied`), igual ao lembrete que atualiza.

Não corrigido por decisão sua:
- Drift criado pela R1: `docs/knowledge/pipeline-extracao.md` § LEMBRETE ("Se qualquer uma já vence na data anunciada ⇒ nada a fazer") e `.claude/skills/pipeline-extracao/SKILL.md` ("absorve o lembrete (nada muda)") não mencionam a confirmação da conta presumida.
- Os drifts já listados no relatório, os opcionais e os avisos S9081 do SonarLint nas lambdas de `mock.patch` em `tests/test_due_date_reminder.py` (`_roda`, código do delta original).
- Deploy manual: copiar `read_emails.py` + `deploy-manifest.json` (o manifesto mudou de novo nesta correção).

Nada foi commitado.

## Adendo — R3 resolvido por decisão do usuário (2026-09-14)

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| R3 | Fallback 6 envia a razão social da pagadora à RPC (sk 404) | ✅ corrigido | O usuário escolheu limpar o cadastro. Migration `137_limpa_razao_social_pagadora_cdi.sql` aplicada via psql: `legal_name` do 404 → NULL. Cadastros que casam a razão social de pagadora: `{1,404}` → `{1}`. Ensaio duplo em ROLLBACK e mutante sem o UPDATE (vermelho em P1) antes de aplicar. pytest 1687 |

Drift correspondente fechado no `historico-migrations.md` (entrada da 137). A entrada da 136 fica como estava, por ser histórico.

Drift criado pela R1/R2 fechado a pedido do usuário. `docs/knowledge/pipeline-extracao.md`, `.claude/skills/pipeline-extracao/SKILL.md` e `CLAUDE.md` passaram a descrever três pontos: a confirmação da conta presumida pelo lembrete, a retirada da marca na dedup (com `nullable`) e a regra "só o sk 1 pode ter a razão social de uma pagadora" (137).
