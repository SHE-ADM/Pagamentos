# Code Review — Features, working tree (2026-09-29)

## Resumo
Alvo: nenhum (review do diff completo)
Modo: max (passo de ataque + verificação adversarial)
Delta: 20 arquivos alterados, 3 novos (testes, 423 linhas); +504/−67 no versionado (sem ruído de EOL)
Régua: CLAUDE.md (raiz, workspace, global), skills `pipeline-extracao`, `deploy-producao`, `testes-e-gates`
Gates: pytest 1917 passed · check_deploy_parity 32/32 (exit 0) · vulture: 3 achados, todos preexistentes e fora do diff · lint/typecheck/vitest não executados (o diff não toca TS) · SonarCloud não executado (só roda no CI)
Verificação adversarial: 2 contestações; 1 confirmado, 1 enfraquecido, 0 refutados

O diff reúne quatro frentes:
1. Leitura de e-mails com a API fora do ar: os e-mails financeiros passam a ser adiados em vez de interromper o lote; o run sai com exit 3; o `erro_api` é gravado uma vez por e-mail e limpo quando o e-mail conclui; o faulthandler só roda quando o script é executado diretamente.
2. Guia de tributo: a data-limite legal impressa deixa de ser sobrescrita pelo fator do código de barras.
3. Cobrança: um título por linha, domínio de e-mail com erro de digitação vira e-mail inválido, e o aviso de falha só vai para CC de vendedor interno.
4. Documentação.

O código está correto e bem coberto nos caminhos de topo. Não há achado bloqueante. Há uma lacuna de teste nos dois métodos HTTP novos, e o mutante sobreviveu à suíte.

## Achados

### 🔴 Bloqueantes
Nenhum.

### 🟡 Recomendados
- [skills/email-reader/scripts/read_emails.py:773-818] `SupabaseControl.has_error` e `delete_errors` nunca são executados por nenhum teste. Todos os testes usam dublês. [verificado]
  Falha:     se `delete_errors` perder o filtro `&error_type=eq.…`, cada e-mail concluído apaga todo o seu histórico em `email_processing_errors`, inclusive `falha_processamento`, por exemplo depois de `reprocess_message.py`. A suíte continua verde. As ~40 linhas também ficam sem cobertura para o gate de código novo do SonarCloud, que já reprovou o PR #259 por esse motivo.
  Evidência: mutante numa cópia, com o filtro removido: os 5 arquivos que exercitam o fluxo deram `100 passed`. `grep` em tests/ só encontra dublês.
  Correção: teste com `SupabaseControl.__new__` + `urlopen` patchado (o padrão já existe em `test_body_full.py:113`), afirmando método HTTP, os dois filtros, o quoting e os ramos fail-open e best-effort.
  Regra:     CLAUDE.md §2 ("Testar a função PURA não cobre o CALL SITE"; validação por mutante)
  Veredito:  CONFIRMADO

### 🔵 Opcionais
- [skills/pdf-contas-pagar/scripts/extract_pdf.py:572 × read_emails.py:2801/369] O extrator decide `tax_guide` com o tipo do documento no momento da extração. Se só o ASSUNTO reclassificar o documento para guia (PDF lido como 'boleto' ou 'outro'), o extrator já terá gravado o fator, e a camada de gravação sai em `cur == bc_due` sem recuperar o prazo legal. [verificado, rebaixado: 0 ocorrências medidas; as 13 DAS com barcode bancário já são 'das' na extração, inclusive a 1757; o prompt e o `classify_document` reconhecem o DAS]
- [read_emails.py:7936 / run_reader.ps1:185] A mensagem do exit 3 e do Event Log 1002 diz "crédito/autenticação/limite, verifique os créditos". Os `erro_api` medidos no banco incluem 529 overloaded e 500, que são transitórios; um soluço da API vira evento de erro com diagnóstico enganoso.
- [read_emails.py:815] `delete_errors` chama `urlopen` sem `with`, e a resposta não é fechada. O padrão é o mesmo do `register_error`, que é preexistente.
- [db_firebird.py:81] Entre duplicatas, o dedup prefere a linha com e-mail, mas não a linha com e-mail VÁLIDO. Quando as duas têm e-mail, prevalece a primeira, mesmo que seja a errada. A divergência é logada.

## Pendências (trabalho incompleto)
- Deploy manual em produção de 8 arquivos (`run_reader.ps1`, `db_firebird.py`, `failure_notify.py`, `run.py`, `send_core.py`, `read_emails.py`, `extract_pdf.py`, `febraban.py`). O manifesto já foi regravado. **`febraban.py` precisa ir junto com `read_emails.py`**: sem `is_tax_guide`, a função `_apply_barcode_due_date` sai cedo e desliga em silêncio toda a correção de vencimento pelo fator. Recomendada.
- Registro em `historico-deploys.md` e `progress.md` após o deploy. Recomendada.
- Limpeza pontual dos 3 `erro_api` históricos de e-mails que já estão em `email_control`. O código novo só limpa ao reprocessar, e esses e-mails não serão reprocessados. Opcional.

## Drift código × documentação
- CLAUDE.md § Pipeline, "O FATOR É AUTORITATIVO … vence se a data lida … é anterior … ao próprio fator": o texto não cita a exceção de guia de tributo (`tax_guide`), que agora vale nos dois call sites. A skill `pipeline-extracao` foi atualizada; o CLAUDE.md não. Decisão pendente.
- progress.md: "Título 246580-D veio duplicado na query (… origem não investigada)". A origem agora está identificada (UNION ALL das duas views) e há deduplicação em `_dedupe_by_document_id`. Decisão pendente.
- apps/frontend-vite/src/pages/Emails.tsx:195: o aviso da tela diz "Processamento interrompido por limite da API", mas agora o lote não é interrompido: os financeiros são adiados e os demais são registrados. O resumo já expõe `deferred`, que a tela não usa. Decisão pendente.

## Não coberto
- `read_emails.py` (~8.000 linhas) foi lido só nos hunks e no contexto adjacente (`register_error`, o final de `process_message`, `run_reader`, o override pelo assunto), não por inteiro.
- SonarCloud não foi executado (só roda no CI); o risco de cobertura está descrito no Recomendado.
- Fora do delta: `_is_api_unavailable` (extract_pdf.py:122) classifica qualquer `anthropic.APIError` como API fora do ar, inclusive um 400 de um PDF específico. Com a regra "uma recusa por run basta", um documento-veneno adiaria todos os financeiros do run enquanto estiver na janela `--days 1`. Isso já existia com o `break`, e o banco não tem nenhum `erro_api` 400.
- DEV_MODE e o reenvio manual (`resend.py`, que agora também barra domínio com erro de digitação) foram avaliados por leitura, não executados.

---

## Correções aplicadas (Passo 8 + pedido de 2026-09-30: "resolva os achados")

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| R1 | `has_error`/`delete_errors` sem teste | ✅ corrigido | `ErroApiHttpRealTest` (4 casos). Mutante sem o filtro de tipo → vermelho |
| O1 | Guia reclassificada só pelo ASSUNTO perdia o prazo legal | ✅ corrigido | `febraban.due_date_corrected_from` lê a nota canônica "corrigido X → fator" (mesmo módulo que a escreve); `read_emails._restore_tax_guide_deadline` devolve X quando o tipo final é guia e a MESMA política (`supersedes`, tax_guide=True) aceita X. Presumido e origem recusada seguem com o fator. 8 casos, incluindo a cadeia real extrator → reclassificação → gravação. Mutante sem a chamada → vermelho |
| O2 | Exit 3 dizia "verifique os créditos" também para 529/500 | ✅ corrigido | `summary["api_error"]` guarda o motivo literal e a linha "Saindo com exit 3" o traz; `run_reader.ps1` usa redação neutra e aponta para essa linha no log do dia. Mutante → vermelho |
| O3 | `delete_errors` não fechava a resposta | ✅ corrigido | `with urlopen(...)` |
| O4 | Dedup preferia e-mail presente, não e-mail válido | ✅ corrigido | `fetch_titulos_vencidos(is_sendable=...)`: o run injeta `validate_email`, e a camada de banco não depende do módulo de envio (default: presença). Um teste no banco e um de wiring no `run.main`. Mutantes → vermelho |

Gates após a correção: pytest 1932 (+11 sobre 1921) · paridade 32/32 com o manifesto regravado · vulture: +1 falso positivo (`due_date_corrected_from`, despachada por nome via `_febraban_fn`, o mesmo padrão já aceito do `barcode_was_discarded`) · EOL: sem ruído de CRLF.
Baseline (Passo 3): pytest 1917 · paridade 32/32.
Re-review do diff da correção: sem achado novo.

Não corrigido (decisão sua): os três itens de drift e as pendências de deploy. A skill `pipeline-extracao` ainda não descreve a restauração do O1.
Nada foi commitado.
