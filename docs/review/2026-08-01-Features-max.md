# Code Review — Features / Onda 3 (documentos fiscais) — 2026-08-01

## Resumo

**Alvo:** `onda 3` (`docs/roadmap-enriquecimento-dados.md` § "ONDA 3 — Documentos fiscais: camada 1"
+ § 7.3 "o que a execução ensinou")
**Modo:** max (passo de ataque + verificação adversarial)
**Delta:** 12 arquivos alterados, 7 novos, +498/−50 linhas (1.229 linhas nos arquivos novos)
**Régua:** `CLAUDE.md` (raiz do projeto) · `docs/roadmap-enriquecimento-dados.md` §3 (protocolo) e §8
(guardrails) · `docs/padrao-execucao.md`
**Gates:** pytest 835 passed · api-backend 506 (49 arquivos) · frontend-vite 705 (134) ·
portal-next 2 (1) = 1.213 Node · lint 0/0 · typecheck OK · prune 0 · vulture sem achado no código
novo · advisors Supabase sem achado novo · e2e Playwright **não executado** (exige navegador) ·
baseline próprio **não estabelecido** (números de partida vêm do §7.3 do roadmap, não de medição
minha em HEAD limpo)
**Verificação adversarial:** 6 contestações sobre 4 achados — o bloqueante desdobrou-se em dois
porque as lentes divergiram por metade. Placar: **3 confirmados, 1 enfraquecido (rebaixado),
1 refutado (descartado)**.

A onda entrega o que o plano prometia: tabela append-only sem valor monetário (a barreira contra
dupla contagem é **estrutural**, não documental), parser determinístico em módulo próprio com cinco
camadas independentes de validação, gancho no Passo 1 do reader com degradação silenciosa mas
avisada, purga consultando a terceira fonte, e a 9ª tool com `total_encontrado` antes do LIMIT.
Verifiquei no banco real: `total_encontrado` = 172 = controle; CT-e 80 = controle; tipo fora do
domínio devolve vazio; RLS com o papel `authenticated` real dá ester (Comercial) **0** × barbara
(Financeiro) **172**.

O defeito que domina o review não está na lógica da onda — está numa função auxiliar de duas linhas
repetida em dois scripts: `_rest()` não pagina, e o teto de 1.000 linhas do PostgREST **já está
ativo neste projeto**. Ele corrompeu 40% do acervo fiscal em silêncio, e o dado gravado não se
auto-corrige.

---

## Achados

### 🔴 Bloqueantes

- [scripts/backfill_fiscal_documents.py:54] `_rest()` faz um único GET sem paginar, e o teto de
  1.000 linhas do PostgREST truncou `email_control` — 68 dos 172 documentos fiscais (**40%**) foram
  gravados sem proveniência.

  **Falha:** `_provenance_index()` é montado de
  `_rest("email_control?select=message_id,sender_email,subject,received_at")`. A tabela tem 1.158
  linhas e a chamada devolve 1.000, sem erro (HTTP 200). Os documentos cujo PDF veio dos 158
  e-mails invisíveis foram gravados com `sender_email`, `gmail_message_id` e `received_at` **NULL**.
  Como `analytics.documentos_fiscais` filtra por `received_at` (`p_date_from`/`p_date_to`) e
  `NULL >= date` é NULL, essas 68 linhas **somem de qualquer consulta com recorte de data** — que é
  exatamente a pergunta sugerida no painel ("Quantos CT-e recebemos neste mês?"). O modelo
  responderia um número 40% menor com naturalidade, e o `ORDER BY received_at DESC NULLS LAST` as
  empurra para depois do LIMIT.

  **Evidência (medida, não deduzida):**
  - `Content-Range: 0-999/1158` na chamada literal do script; estável em 3 execuções (é teto, não
    flutuação).
  - `fiscal_document`: 172 linhas, 68 com `sender_email`/`gmail_message_id`/`received_at` nulos.
  - Reconstruí `_provenance_index` duas vezes com o `safe_filename` real: com o índice **truncado**
    casam **0 de 68**; com o índice **paginado** casam **68 de 68**. A hipótese alternativa (prefixo
    que não casa) está descartada — a truncagem é a causa única.
  - Recorte de data que engloba todo o histórico devolve 104 de 172; os 14 CT-e ausentes são de 80.
  - `_storage_list()`, no mesmo arquivo, **pagina corretamente** — a assimetria é acidental.

  **Agravante:** o dano **não se auto-corrige**. `novo = chave not in ja_registradas` pula a chave
  já gravada e o INSERT usa `on_conflict=access_key` + `resolution=ignore-duplicates`, que ignora em
  vez de atualizar. Corrigir `_rest` e reexecutar o backfill **não** preenche as 68 linhas.

  **Correção:** paginar `_rest` com `Range`/`offset` até esgotar (o laço de `_storage_list` no mesmo
  arquivo é o molde) **e** um UPDATE dirigido para as 68 linhas já gravadas, com a proveniência
  resolvida pelo índice completo.

  **Regra:** `docs/roadmap-enriquecimento-dados.md` §8 guardrail 3b ("olhe o dado depois de gravar")
  — a mesma lição do achado O6 desta onda, que pegou o falso positivo de 1991 por um `min()`.

  **Veredito:** CONFIRMADO `[verificado]` — 2 lentes (correção lógica, reprodução) não conseguiram
  refutar; a de reprodução mediu 0/68 × 68/68 de forma independente.

### 🟡 Recomendados

- [scripts/purge_orphan_attachments.py:64] O mesmo `_rest()` sem paginação alimenta as **quatro**
  consultas que decidem o que apagar do bucket — e nas três que compõem `referenciados` a falha é
  invertida e em massa.

  **Falha:** para `emails` (1.158 linhas), truncar significa **perder proteção**: 4 e-mails em
  `falha` caem fora da janela e seus anexos deixam de ser preservados. Para `anexos` (394),
  `sources` (398) e `fiscais` (172), truncar significa o oposto — um objeto legitimamente
  referenciado vira **falso órfão** e é apagado, num run que reporta "órfãos removidos" com
  naturalidade. As três estão entre 17% e 40% do teto e crescem a cada conta lançada.

  **Evidência:** simulei o script byte a byte contra o bucket e o banco reais, com e sem paginação:
  `objetos=516 orfaos=78 APAGAR=67` nos dois casos → **0 objetos apagados a mais hoje**. Os 4
  e-mails em `falha` fora da janela têm **0 objetos no bucket** (coerente: `falha` costuma ser o
  e-mail que não produziu PDF). Os 2 objetos que a regra do prefixo preserva também são pegos pela
  regra independente de `email_processing_errors` (33 linhas, longe do teto).

  **Correção:** a mesma da B1 — paginar `_rest`. Um `assert` de `Content-Range` completo já
  detectaria a condição.

  **Veredito:** ENFRAQUECIDO `[verificado, rebaixado]` — entrou como bloqueante e caiu para
  recomendado. Duas lentes mediram **0 de dano corrente**, e três fatos independentes derrubam
  "irreversível": o backup diário do bucket (skill `backup-supabase`, 02:00, retenção 30 dias), a
  ausência de qualquer execução automática (`grep` não acha o script em `scheduler/*.ps1` nem em
  `.github/workflows/`) e o fato de ele **não estar** no `deploy-manifest.json` — não existe na
  máquina de produção. A redundância que hoje salva tudo é **empírica, não estrutural**.

- [scripts/retry_extraction.py:295] O gancho fiscal novo é alimentado, por este call site, com um
  contexto que não tem `sender_email` nem `received_at`.

  **Falha:** `email_ctx = {"message_id": msg_id, "subject": subject}` viaja intacto até
  `err_ctx` (`read_emails.py:4515`) e daí para `register_fiscal_document`, que lê
  `ctx.get("sender_email")` e `ctx.get("received_at")` → **NULL** no payload; as colunas são
  nullable e sem DEFAULT. Todo documento fiscal registrado por este caminho nasce fora de qualquer
  consulta com recorte de data — a mesma consequência do B1, por outra porta.

  **Evidência:** `fetch_pending()` (linha 78) nem seleciona as colunas —
  `select=id,message_id,subject,attachment_names`. Não é só o dict, o dado não é buscado. Os outros
  três call sites de produção (`retry_extraction.py:196`, `reprocess_link_emails.py:88`,
  `read_emails.py:5289`) passam os quatro campos. E este é o **pior caso**, não um caminho raro: o
  modo padrão processa `pdf_extracted=false AND attachment_saved=true` — PDFs salvos cuja extração
  falhou —, que é exatamente a população que o gancho, rodando antes do `run_extraction`, existe
  para capturar.

  **Correção:** incluir `sender_email,received_at` no `select` de `fetch_pending` e nos campos do
  dict, alinhando com o que a linha 196 já faz.

  **Veredito:** CONFIRMADO `[verificado]` — a contestação não refutou a cadeia (verificada ponta a
  ponta) e só enfraqueceu a consequência de RLS, que é latente: o único grupo restrito é o
  Comercial, que já vê 0 documentos fiscais. A consequência do filtro de data permanece intacta.

- [tests/test_fiscal_document_consistency.py:54] A guarda que a própria docstring chama de "a mais
  importante da onda" não observa a garantia que promete.

  **Falha:** as três asserções verificam que a string `fiscal_document?select=storage_key` aparece
  no source, que `referenciados` menciona `fiscais` e que `orfaos` deriva de `referenciados`.
  Nenhuma observa se a consulta devolve o conjunto **completo**. O defeito do achado 🟡 acima passa
  verde por ela — e passaria também quando `fiscal_document` cruzar 1.000 linhas, que é o cenário
  contra o qual o teste foi escrito.

  **Evidência:** `grep -rl "purge" tests/` devolve só este arquivo; `grep -rln
  "max-rows|Range|offset|limit=1000" tests/` devolve zero. Sem redundância em outro teste.

  **Correção:** acrescentar, no mesmo estilo de parsing do arquivo, uma asserção de que o corpo de
  `_rest` contém `Range`/`offset`/`while`, mais a sanidade correspondente sobre `_storage_list`
  (que já pagina) — sem banco real.

  **Regra:** `docs/roadmap-enriquecimento-dados.md` §8 guardrail 4b; `CLAUDE.md` §1 ("teste que
  promete uma garantia tem de entregá-la").

  **Veredito:** CONFIRMADO `[verificado]` — com um sub-item enfraquecido: a terceira asserção prova
  mais do que "menciona" (fecha a cadeia conjunto→preservação); o que falta é só a completude do
  conjunto.

### 🔵 Opcionais

- [supabase/migrations/108_tool_documentos_fiscais.sql:92] `p_emitente` entra no `LIKE` sem escapar
  `%`/`_` — medido: `p_emitente => '%'` devolve todos os 172. É o padrão de 4 das 9 tools
  (`buscar_emails`, `gasto_por_fornecedor`, `listar_contas`), então é consistência do projeto, não
  regressão desta onda.
- [scripts/retry_extraction.py:279] `subject = rec.get("subject", "")[:60]` — truncado para log e
  reaproveitado como dado; por esse caminho `fiscal_document.subject` nasce cortado em 60 chars.
  (O `TypeError` latente com `subject` NULL não é alcançável hoje: 0 linhas com subject nulo.)
- [skills/email-reader/scripts/read_emails.py:4575] `storage_key` é gravado mesmo quando
  `ctrl.upload_attachment()` falhou (retorno ignorado), deixando a linha apontando para objeto
  inexistente.

### ❌ Retirado pela contestação

- ~~`_insert` do backfill sem `return=representation` reportaria "gravado" para duplicata~~ —
  **REFUTADO.** A guarda `novo = chave not in ja_registradas` faz o curto-circuito do `and` avaliar
  `novo` primeiro, então `_insert` **nunca** é chamado para chave já registrada; numa reexecução o
  log diria `GRAVADOS: 0`, que é a verdade. O contador é decorativo (não decide exit code nem
  ramificação) e a idempotência é garantida no banco pela UNIQUE. A assimetria com o reader é
  justificada: lá não existe conjunto pré-carregado, e o booleano decide a linha `[FISCAL] …
  registrado` do log de produção.

---

## Pendências (trabalho incompleto)

- [supabase — dado gravado] As 68 linhas de `fiscal_document` sem `sender_email`/`gmail_message_id`/
  `received_at` exigem UPDATE dirigido; a reexecução do backfill não as alcança (append-only +
  `ignore-duplicates`) — **bloqueante**.
- [produção] Item 3.7 do plano: `read_emails.py` (alterado) e `fiscal_key.py` (novo) ainda não
  copiados para `C:\Sheild\API\Pagamentos`. Declarado no `CLAUDE.md`; cópia é do operador —
  **recomendada**.
- [Onda 4] ~115 CT-e cujo PDF a purga de 15/07 já levou só são recuperáveis pelo IMAP. Escopo
  deliberado do plano, não lacuna — **opcional**.

Nenhum marcador `TODO`/`FIXME`/`HACK`/`WIP` no delta (as 3 ocorrências que o padrão pegou são
"TODO anexo" em português — falsos positivos). Nenhum stub, teste pulado ou bloco de debug.

---

## Drift código × documentação

- `supabase/migrations/107_fiscal_document.sql:47` cita
  `tests/test_fiscal_key_domain_consistency.py` como o teste cross-layer do domínio de modelo. Esse
  arquivo **não existe** — o real é `tests/test_fiscal_document_consistency.py`. Migration já
  aplicada (artefato imutável); decisão do usuário sobre corrigir só o comentário.
- `CLAUDE.md` afirma, no bloco DEPLOY 2026-08-01, que o verificador em produção "deve acusar
  exatamente esses dois" (`read_emails.py` e `fiscal_key.py`) e que copiar o `extract_pdf.py` "é
  opcional". O `deploy-manifest.json` do delta traz o hash **novo** de `extract_pdf.py`
  (`442d839…` → `b575672…`), então o verificador acusará **três** divergências — e um alerta que
  grita para sempre é o que o próprio `CLAUDE.md` diz que faz a verificação ser ignorada.
  Além disso, "opcional" é falso por dependência: confirmei por mutante (arquivo renomeado e
  restaurado) que o `extract_pdf.py` novo **quebra com `ModuleNotFoundError: fiscal_key`**. Qual dos
  dois lados corrigir — a instrução ou o manifesto — é decisão sua.

---

## Não coberto

- **e2e / a11y em navegador** (Playwright + axe): não executado — exige navegador, e o renderer
  crasha no sandbox do agente. O delta não toca UI além de uma entrada no array de sugestões do
  `AiChatPanel`.
- **SonarCloud:** não consultado — não há PR aberto para este diff, e a análise CI roda por PR.
- **Baseline próprio dos gates:** não estabelecido. Não rodei os gates num worktree de `HEAD` limpo
  (o rito proíbe mexer no working tree para medir), então a comparação "791 → 835 pytest" vem do
  §7.3 do roadmap, não de medição minha.
- **Backfill não reexecutado** — a verificação foi por consulta ao estado gravado, não por nova
  execução.
- **`CLAUDE.md` e o roadmap** foram lidos como régua e plano; não auditei os dois documentos linha a
  linha, só as seções pertinentes ao alvo.
- **Custo de `_pdf_text` em anexos de imagem:** a leitura passou a rodar em todo anexo, inclusive
  os que não são PDF (falha e devolve `""`). Não medi o impacto em lote grande — o §7.3 do roadmap
  assume o custo como irrelevante perto de IMAP + Claude API, e não contestei essa premissa.

---

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| B1 | `_rest()` sem paginação no backfill — 68/172 documentos sem proveniência | ✅ corrigido | `scripts/backfill_fiscal_documents.py:55` — `_rest` pagina por `order=id&limit&offset` até esgotar. Medido depois: `email_control` 1000 → **1158**. **O dado já gravado NÃO foi tocado** — ver a linha B1-dados abaixo. |
| B1-dados | As 68 linhas já gravadas com `sender_email`/`gmail_message_id`/`received_at` NULL | ⏸️ adiado | Exige **UPDATE dirigido em produção**, e a reexecução do backfill não as alcança (`ignore-duplicates` ignora em vez de atualizar). Escrita em banco é decisão sua — o SQL é um `UPDATE ... FROM` casando o prefixo `{sender_tag}_{subject_tag}_{YYYYMMDD}_` do `storage_key`, que é a mesma ligação que o `_provenance_index` faz. |
| R1 | `_rest()` sem paginação na purga (falha invertida: anexo válido vira falso órfão) | ✅ corrigido | `scripts/purge_orphan_attachments.py:66`, mesmo fix. **Desvio declarado da regra:** este achado ficou `ENFRAQUECIDO` e, pelo contrato da skill, iria para adiado. Corrigi assim mesmo por três razões: o mecanismo foi **medido**, não é premissa duvidosa (só o impacto corrente caiu a zero); é literalmente o mesmo fix do B1, em cópia da mesma função; e deixá-lo de fora tornaria a asserção nova do R3 **vermelha**. Dry-run após o fix: 78 órfãos / 11 preservados / 67 a apagar — mesmo desfecho, agora com o conjunto completo. |
| R2 | `retry_extraction.py` alimentava o gancho sem `sender_email`/`received_at` | ✅ corrigido | `scripts/retry_extraction.py:78` (as 2 colunas entram no `select`) e `:298` (o dict passa os 4 campos). De quebra, o `subject` gravado deixou de ser a versão cortada em 60 chars do log. |
| R3 | Guarda da purga não observava completude da consulta | ✅ corrigido | `tests/test_fiscal_document_consistency.py` — `test_rest_pagina_ate_esgotar` na purga **e** classe nova `BackfillPaginaTest`, mais `test_sanidade_do_parser_de_paginacao` (ancorada em `_storage_list`, que já paginava). +4 testes. |
| R4 | `_insert` do backfill sem `return=representation` | ❌ retirado | A contestação provou que a guarda `novo = chave not in ja_registradas` faz o curto-circuito do `and` avaliar `novo` primeiro: `_insert` **nunca** é chamado para duplicata, e numa reexecução o log diria `GRAVADOS: 0`, que é a verdade. O contador não decide nada e a idempotência é garantida pela UNIQUE no banco. |

**Validação por mutante** (4 rodadas, todas revertidas com `diff -q` confirmando):

1. `_rest` da purga de volta ao GET único → `PurgaPreservaDocumentoFiscalTest::test_rest_pagina_ate_esgotar` **FALHOU** ✅
2. `_rest` do backfill de volta ao GET único → `BackfillPaginaTest::test_rest_pagina_ate_esgotar` **FALHOU** ✅
3. Regex do parser cegado (`def _rest\(` → `def _NAOEXISTE\(`) → **os dois FALHARAM** ✅ (a guarda não vira `0 == 0` em silêncio)
4. Repetida a nº 1 após relaxar o regex para `offset|Range` → ainda **FALHOU** ✅

```
Gates após a correção: pytest 839 (+4) · api-backend 506 · frontend-vite 705 · portal-next 2
                       · lint 0/0 · typecheck OK · vulture sem achado
Baseline (Passo 3):    pytest 835     · api-backend 506 · frontend-vite 705 · portal-next 2
                       · lint 0/0 · typecheck OK · vulture sem achado
```

**Re-review do diff da correção: 1 achado novo, corrigido na mesma rodada.**
A primeira versão do teste-guarda travava o literal `offset`, o que reprovaria uma implementação
igualmente correta por header `Range` — a guarda passaria a observar a *implementação* em vez da
*garantia*. Relaxado para `offset|Range` e revalidado por mutante (rodada 4). Segunda passada sobre
esse ajuste: sem achado novo.

**Achado que o re-review levantou e NÃO foi corrigido:** `main()` de
`backfill_fiscal_documents.py` tem complexidade ciclomática **D (22)** e o de
`purge_orphan_attachments.py`, **C (19)** — SonarLint S3776. Ambos são **pré-existentes à correção**
(medido com `radon`: minha edição vive em `_rest`, que é **A (4)**). Não corrigido por ser
refatoração ampla, e porque o `CLAUDE.md` registra que S3776 neste projeto se trata função a função,
com A/B sobre dado real, nunca em sweep de review.

**Não corrigido por decisão sua:**
- Os dois itens de **drift** (comentário da migration 107 apontando teste inexistente; `CLAUDE.md` ×
  `deploy-manifest.json` sobre quantos arquivos o deploy acusa). O rito não sincroniza documentação
  durante a correção — fazê-lo apagaria a evidência da divergência, e qual lado está certo é sua
  decisão.
- Os **3 achados opcionais**.
- A **cópia para produção** (item 3.7 do plano) e o **UPDATE das 68 linhas**.

**Nenhum arquivo corrigido está no `deploy-manifest.json`** (`scripts/` fica fora dos `DEPLOY_GLOBS`
— é exatamente o achado O9 do §7.3), então a correção **não exige** `check_deploy_parity.py
--update`. Verificado: 27/27 conferem.

**Nada foi commitado.**

---

## Adendo — drift `CLAUDE.md` × `deploy-manifest.json` resolvido a pedido (2026-08-01)

Este item constava como `⏸️ adiado` acima, porque o rito não sincroniza documentação durante a
correção automática. Foi resolvido depois, por pedido explícito do usuário.

**Lado corrigido: a documentação.** O `extract_pdf.py` mudou de fato (o reexport do `fiscal_key`) e
é arquivo de deploy legítimo — coberto por `DEPLOY_GLOBS`, roda em produção. Tirá-lo do manifesto
mascararia uma alteração real; o manifesto estava certo, o texto é que estava desatualizado.

| Arquivo | O que dizia | O que diz agora |
|---|---|---|
| `CLAUDE.md` §"COMO SABER SE PRODUÇÃO ESTÁ ATUALIZADA" | "falta copiar `read_emails.py` e `fiscal_key.py`… acusar exatamente esses **dois**" | **três** — `read_emails.py`, `extract_pdf.py`, `fiscal_key.py` — e o resultado exato: **2 `DIVERGENTE` + 1 `FALTANDO`** |
| `CLAUDE.md` bloco DEPLOY 2026-08-01 | "copiar **DOIS** arquivos"; "o `extract_pdf.py` … copiá-lo é **opcional**" | copiar **TRÊS de uma vez**, com a tabela em ordem de cópia e o aviso 🔴 de que `extract_pdf.py` sem `fiscal_key.py` derruba **toda** a extração de PDF |
| `docs/roadmap-enriquecimento-dados.md` item 3.7 | "`read_emails.py` + `purge_orphan_attachments.py` + `--update`" | os **três juntos**; a purga sai da lista (não é arquivo de deploy) |
| idem, parágrafo do item 3.4 | "É arquivo de deploy (`scripts/`), portanto exige `--update`" | nota de correção explicando o achado **O9**: `DEPLOY_GLOBS` não cobre `scripts/` |

Acrescentei em cada ponto **por que** o erro aconteceu, não só o número certo: contou-se o que a
*feature* precisa (2 arquivos — e de fato ela funciona com 2) em vez do que *mudou* (3). O manifesto
guarda hash, não intenção, então o `extract_pdf.py` seguiria acusando `DIVERGENTE` depois de uma
cópia "completa" segundo a doc antiga — e alarme permanente é alarme ignorado, que é exatamente o
que a paridade existe para evitar.

**Verificação:** simulei o verificador com produção = `HEAD` e manifesto = working tree →
`DIVERGENTE: read_emails.py, extract_pdf.py` + `FALTANDO: fiscal_key.py` = **3**, batendo com o
texto novo. Gates: pytest **839**, `check_deploy_parity` 27/27 no dev. O roadmap também repetia a
mesma classe de erro em dois pontos; corrigi junto, senão o drift voltaria pela outra porta.

**Continua pendente:** o drift da **migration 107:47** (cita `test_fiscal_key_domain_consistency.py`,
inexistente) — não tocado, por ser artefato imutável já aplicado.

---

## Adendo 2 — B1-dados resolvido a pedido: as 68 linhas foram corrigidas (2026-08-01)

Constava como `⏸️ adiado` (escrita em produção é decisão do usuário). Resolvido por pedido
explícito.

**Como:** estendi o próprio `scripts/backfill_fiscal_documents.py` com o modo `--fix-provenance`,
em vez de criar um script novo. Motivo: a reconstrução do prefixo
`{sender_tag}_{subject_tag}_{YYYYMMDD}_` já vive em `_provenance_index`/`_match_email`; duplicá-la
criaria a segunda fonte de verdade que o resto do projeto combate. O modo não baixa PDF nenhum —
lê o índice (agora paginado), casa pelo `storage_key` e faz `PATCH` só dos 4 campos de proveniência.

**Verificação ANTES de escrever** — dois oráculos independentes:

1. **Cobertura:** 68 de 68 casaram um e-mail; **0** sem correspondência.
2. **Coerência temporal** (oráculo externo ao casamento): para cada linha, comparei o `AAMM` da
   chave de acesso — escrito pelo emissor, não pelo nosso código — com a data do e-mail casado.
   **172 de 172 coerentes** (e-mail recebido de 0 a 6 meses após a emissão), **0 incoerências**.
   Os 104 que já tinham proveniência entraram como grupo de controle e também passaram.

**Resultado medido:**

| | Antes | Depois |
|---|---|---|
| Linhas sem `sender_email`/`gmail_message_id`/`subject`/`received_at` | 68 | **0** |
| Visíveis num recorte de data que engloba todo o histórico | 104 | **172** |
| CT-e visíveis com recorte de data (controle: 80) | 66 | **80** |
| `access_key` distintas (integridade) | 172 | 172 |
| `storage_key` nulos (integridade) | 0 | 0 |

**Idempotência:** reexecutado logo em seguida → `linhas sem proveniencia: 0`, `CORRIGIDAS: 0`.
**Visibilidade por grupo inalterada:** ester (Comercial) continua vendo **0** — os 17 remetentes
distintos são todos externos, então preencher `sender_email` não abriu acesso a ninguém. Isso
importa porque a policy da 107 casa exatamente esse campo: o reparo poderia ter mudado a política de
acesso sem querer, e não mudou.

**Guarda de regressão (+3 testes, `FixProvenanceEConservadorTest`):** um UPDATE numa tabela
append-only é a operação mais perigosa deste script, então as duas invariantes que o mantêm um
*reparo* e não uma *reescrita* estão travadas — só alcança linha com `sender_email IS NULL`, e o
payload **nunca** toca identidade (`access_key`/`model`/`emitter_cnpj`/`storage_key`/`doc_number`).

> ⚠️ **O primeiro mutante que escrevi passou verde — e o teste estava certo.** A substring que usei
> como alvo existe em `_insert` **e** em `_patch_provenance`, e o `replace(..., 1)` mutou a primeira,
> que não é a função sob teste. Refeito mirando `_patch_provenance` pelo mesmo regex do teste: aí
> **falhou**, como devia. Vale registrar porque o modo de erro é traiçoeiro — um mutante que erra o
> alvo produz exatamente o sinal de "teste é decoração", e a conclusão apressada seria jogar fora um
> teste bom. Ambos os mutantes finais (identidade no payload; filtro conservador removido) reprovam.

**Gates:** pytest **842** (+3) · vulture limpo · working tree sem resíduo de mutante.
`fix_provenance` é **C (11)** e `_patch_provenance` **A (2)**; `main()` foi de D(22) a **D(23)** pelo
`if` do novo modo — não refatorei, pelo mesmo motivo já registrado.

**Documentação:** acrescentei o modo à seção "Comandos" do `CLAUDE.md`, com a causa, o número e a
lição ("consulta REST cujo resultado vira dado gravado precisa paginar — o corte vem com HTTP 200").
Isso não é sincronizar drift preexistente: é documentar capacidade que **eu** acabei de criar.

**Nada foi commitado.** O único item da lista original ainda em aberto é o **deploy em produção**
(cópia dos três arquivos), que é seu.

---

## Adendo 3 — drift da migration 107 resolvido a pedido (2026-08-01)

Constava como `⏸️ adiado` por ser artefato imutável já aplicado. Resolvido por pedido explícito.

**A tensão e como foi resolvida.** A regra do projeto é "nunca alterar migration existente". Mas há
**precedente explícito** no próprio `CLAUDE.md`: na migration 073, o bloco de VERIFICAÇÃO foi
reescrito depois de aplicada, com a justificativa *"a migration já estava aplicada; comentário não
afeta reprodutibilidade"*. É exatamente o caso — a alteração é num comentário `--` dentro do
`CREATE TABLE`, que o PostgreSQL ignora. Ponto adicional: a 107 ainda está **untracked**, então não
há nem histórico a preservar. Verifiquei que o bloco editado é 100% comentário e que a linha
`model SMALLINT NOT NULL CHECK (...)` ficou intacta.

**Varredura antes de corrigir** (para não consertar só o que eu tinha visto): varri **todas** as
migrations por referências a arquivo de teste, nos dois sentidos. Resultado: **1 referência, e ela
era a quebrada** — a 107 é a primeira migration do projeto a citar um teste-guarda pelo nome, e
nasceu apontando para o lugar errado. No sentido inverso (testes que citam migrations), 1 válida e 0
quebradas. Depois da correção: **1 válida, 0 quebradas**.

**Além de corrigir o nome, tornei o ponteiro auto-verificável.** Um comentário corrigido à mão
volta a apodrecer no próximo rename — foi assim que ele quebrou (o arquivo ganhou a 2ª guarda, a da
purga, mudou de nome, e o comentário ficou para trás). O teste novo
`test_a_migration_aponta_para_ESTE_arquivo` usa **`Path(__file__).name`**, não o literal, então
passa a falhar nas **duas** direções.

**Validado por dois mutantes:**

1. Migration de volta ao nome errado → **FALHOU** ✅
2. Arquivo de teste renomeado (copiei para `test_renomeado_zz_tmp.py` e rodei só ele) → **FALHOU** ✅
   — é o que prova que a garantia vem do `__file__` e não de uma string feliz. Cópia removida.

**Gates:** pytest **843** (+1) · working tree sem resíduo.

**Por que isto não é cosmético:** um ponteiro quebrado é pior que nenhum. Quem for conferir a
invariante do domínio de modelo segue o caminho, não acha o arquivo e conclui que a guarda não
existe — quando ela existe e funciona.

---

## Adendo 4 — varredura de fechamento da Onda 3 (2026-08-01): 2 achados NOVOS

Revisão focada em "o que ainda está aberto", medindo o estado real em vez de reler o plano. Os dois
achados abaixo **não** estavam no review original.

### 🟡 N1 — a purga apaga PDF que CONTÉM documento fiscal, quando a chave veio de outro objeto

A preservação da purga é por **`storage_key`** — o objeto de onde a chave foi lida. Mas a mesma
chave costuma chegar por **dois** objetos (o PDF consolidado da transportadora e o individual), e a
UNIQUE de `access_key` só registra o primeiro. O segundo não consta em `fiscal_document`, vira
órfão e é apagado, mesmo sendo um DACTE legítimo.

**Medido:** dos **78** órfãos atuais, **11 contêm chave fiscal válida** (19 documentos ao todo).
Destes, **4 seriam apagados de fato** — os outros sobrevivem por acaso, pela regra independente de
`email_processing_errors`. O caso mais caro é
`cobranca_DACTEs_e_XMLs_das_Faturas_FT_F_20260716_…pdf`, que carrega **6 DACTEs**.

**Não há perda de DADO** — as 6 chaves estão registradas (verifiquei uma a uma: 6/6). O que se
perde é o **PDF**, que é exatamente o que a onda existe para parar de perder. O invariante escrito
("a purga passou a preservar o PDF fiscal") tem, portanto, uma exceção não documentada.

**Correção possível (não aplicada — muda regra de negócio):** ou a purga passa a abrir o PDF órfão
e preservá-lo se contiver chave (caro: pdfplumber em cada órfão), ou `fiscal_document` deixa de ter
1 `storage_key` por chave e ganha uma tabela de ocorrências (mudança de modelo). Ambas são decisão
de escopo, não conserto.

### 🟡 N2 — 4 documentos fiscais no bucket ainda não registrados, e são de HOJE

O `--dry-run` do backfill sobre o bucket inteiro (515 objetos) encontrou **210 chaves**, das quais
**4 novas**: `lidiane_LE_BIANCO_-_PAGAMENTO_GNRE_20260801_GNRE_-_*.pdf` — NF-e referenciadas em
guias GNRE, chegadas **depois** do backfill desta manhã.

Isto não é a lacuna conhecida da Onda 4 (PDFs que a purga já levou, só recuperáveis por IMAP):
**o PDF está no bucket agora** e é capturável com uma execução do backfill. É também a **prova
concreta de que o deploy pendente já custa dados** — o reader de produção não registrou esses
documentos porque ainda não foi copiado.

### Estado dos itens do plano

| Item | Estado |
|---|---|
| 3.1 tabela · 3.2 parser · 3.3 gancho · 3.4 purga · 3.5 backfill · 3.6 tool | ✅ |
| **3.7 deploy** | ⏳ **pendente** — medido: `fiscal_key.py` FALTANDO + `extract_pdf.py` e `read_emails.py` DIVERGENTE |
| **Versionamento** | ⏳ **7 arquivos untracked** — migrations 107/108, `fiscal_key.py`, `backfill_fiscal_documents.py` e os 3 testes. A onda não existe no repositório até serem commitados |

### Verificados e OK (não são pendência)

- **Guarda painel × bateria de regressão** existe e é robusta: `regression.test.ts` **lê o
  `AiChatPanel.tsx` real** e falha se houver sugestão sem cobertura. A sugestão da Onda 3 está
  coberta.
- **O parser rejeita boleto corretamente** — investiguei 3 "candidatos perdidos" e os 3 eram linha
  digitável de 44 dígitos (`00190019…`), rejeitada como deveria.
- **Cobertura do backfill:** 210 chaves no bucket × 172 registradas — a diferença são duplicatas da
  mesma chave em objetos distintos, mais as 4 do N2. Nenhuma chave válida foi perdida por defeito
  do parser.
- **87 objetos sem texto** (imagem ou PDF cifrado) — limitação já documentada: `_pdf_text` roda
  antes do `run_extraction`, que é quem descriptografa.

---

## Adendo 5 — review de ROBUSTEZ sobre os itens em aberto (2026-08-01)

Review focado: passo de ataque sobre o código dos achados/pendências não resolvidos, incluindo **o
que eu mesmo escrevi nas correções**. Tudo medido.

### 🟡 A1 — `except HTTPError` não pega falha de REDE: um timeout derruba o lote inteiro

`_insert` e `_patch_provenance` (`backfill_fiscal_documents.py`) capturam **apenas**
`urllib.error.HTTPError`. `HTTPError` é subclasse de `URLError`, mas **não o contrário** — então
timeout, DNS e conexão recusada **propagam** e matam o script no meio do laço.

**Confirmado por execução:** `raise URLError('timed out')` dentro de `except HTTPError` → não é
capturado.

**Falha concreta:** um blip de rede no 300º dos 515 downloads do backfill (ou no 30º dos 68 PATCHes
do reparo) aborta tudo com traceback. Os `_rest`/`_storage_list`/`_storage_remove` das duas
ferramentas também não tratam nada — propagam.

**Atenuante honesto:** o dano é **interrupção, não corrupção** — as duas operações são idempotentes
(`ignore-duplicates`; `sender_email IS NULL`), então reexecutar completa. E na purga, propagar
**antes** de apagar é o lado seguro. Por isso 🟡 e não 🔴.

**Autocrítica:** o `_patch_provenance` é código meu, escrito nesta sessão, e **herdou o padrão do
`_insert` sem questioná-lo**. Copiar a forma do vizinho é exatamente como um defeito de robustez se
propaga — e o review anterior não pegou porque olhou o que o código *faz*, não o que ele *deixa de
tratar*.

**Correção:** trocar por `except (urllib.error.URLError, OSError, TimeoutError)` nos dois pontos de
gravação (mantendo o ramo `HTTPError` antes, que lê o corpo do erro), e envolver o laço do backfill
para que um item ruim não derrube os demais — como o `_storage_get` já faz.

### 🟡 A2 — a premissa documentada de `_provenance_index` é FALSA em 27% das colisões

O comentário afirma: *"Prefixo repetido (mesmo remetente, mesmo assunto, mesmo dia) fica com o
primeiro: são reenvios da mesma thread, e a proveniência é equivalente na prática."*

**Medido: não são.** Dos **1.015** prefixos, **82 colidem** (143 e-mails absorvidos). Desses 82,
**60 são reenvio real** (assunto idêntico) — mas **22 têm assunto DIFERENTE**, e a diferença é
material:

```
LE BIANCO - PAGAMENTO FORNECEDOR   |  LE BIANCO - PAGAMENTO FORNECEDOR (DOIS M)
LE BIANCO - ... (ADM - EFE DI      |  ... (NYBC)          <- fornecedores distintos
Renovação do domínio mudetextil.com|  ...mudetextil.com.br
```

A causa é o truncamento: `safe_filename(subject, 30)` corta o assunto em 30 chars, então dois
e-mails de fornecedores diferentes colapsam no mesmo prefixo.

**Dano hoje: ZERO** — 0 dos 172 documentos fiscais tem proveniência vinda de prefixo ambíguo. E o
`received_at` **nunca** erra de dia, porque a data faz parte do prefixo; logo o filtro temporal da
tool não é afetado nem no pior caso. O que pode sair errado é `gmail_message_id`/`subject`,
apontando para o e-mail irmão. Risco latente, e a premissa escrita não deve seguir afirmando o que
a medição desmente.

### 🟡 A3 — `fix_provenance` não valida o casamento; a validação existiu só no meu console

Antes de aplicar o reparo das 68 linhas, conferi por oráculo externo que a data do e-mail era
coerente com o `AAMM` da chave (172/172 coerentes). **Essa checagem não está no código.** Uma
reexecução futura — num acervo maior, onde A2 já morda — atribuiria proveniência sem nenhuma
barreira, e `_match_email` devolve **o primeiro prefixo que casar**, sem desempate.

**Correção:** mover o oráculo para dentro de `fix_provenance` — rejeitar (e relatar) casamento cujo
`received_at` seja anterior ao mês de emissão ou muito posterior. É a diferença entre uma verificação
que aconteceu **uma vez** e uma garantia que vale **sempre**.

### 🔵 A4 — `_rest` paginado sem teto de iterações

O laço que escrevi sai por `len(page) < REST_PAGE`. Se o servidor ignorasse `offset` e devolvesse
sempre 1.000, o laço rodaria para sempre acumulando memória. Exige bug do PostgREST — por isso
opcional —, mas um teto (`while offset < 100_000`) custa uma linha e transforma travamento em erro.
Mesma observação para `order=id`: se algum dia um `path` já trouxer `order=`, a query fica com dois
e o comportamento é do servidor. Nenhuma chamada atual tem.

### 🔵 A5 — `nome in erros_txt` é substring no JSON inteiro

A purga decide preservar por `nome in erros_txt`, sobre o JSON serializado de
`email_processing_errors`. Um nome que seja substring de outro produz **falso positivo** — preserva
a mais, lado seguro. O lado inseguro exigiria escape divergente, e não ocorre porque
`safe_filename` já reduz os nomes a ASCII. Fica registrado como fragilidade, não defeito.

### Itens não resolvidos que este review CONFIRMA sem alteração

| Item | Estado |
|---|---|
| **N1** — purga apaga PDF com chave registrada por outro objeto | 4 objetos · 9 documentos · sem perda de dado |
| **N2** — 4 GNRE de 01/08 no bucket sem registro | o deploy **não** resolve (dedup por `message_id`); precisa de `backfill` |
| **N3** — manifesto não copiado para produção | código já validado em prod (`True True 4`); falta a régua |
| **7 arquivos untracked** | a Onda 3 roda em produção e **não existe no repositório** |
| `p_emitente` LIKE sem escape · `storage_key` com upload falho · S3776 | inalterados; opcionais do review original |

**Gates:** pytest 843 · working tree inalterado por este review (nenhuma correção aplicada).

---

## Adendo 6 — A1/A2/A3 + menores corrigidos, com a raiz estrutural (2026-08-01)

| # | Achado | Desfecho | Como |
|---|---|---|---|
| A1 | `except HTTPError` não pega falha de rede | ✅ corrigido | `NETWORK_ERRORS = (URLError, OSError, TimeoutError)` no módulo novo; `rest_write` **devolve `(ok, motivo)` em vez de lançar**, para que uma falha não derrube os itens seguintes do laço |
| A2 | premissa "colisão = reenvio" falsa em 27% | ✅ corrigido | `_provenance_index` guarda a **lista**, não o primeiro; comentário reescrito com o número medido |
| A3 | oráculo de plausibilidade só no console | ✅ corrigido | `_emissao_plausivel` (AAMM da chave × data do e-mail) entrou no código e **desempata** prefixo ambíguo; `issue_yearmonth` acrescentado ao `select` — sem ele o oráculo é cego |
| A4 | `_rest` sem teto de iterações | ✅ corrigido | `MAX_PAGES`; servidor que ignora `offset` **levanta** em vez de travar. `order=` duplicado também tratado (o do `path` prevalece) |
| A5 | `nome in erros_txt` (substring no JSON) | ✅ corrigido | `_erro_source_files` lê a **chave** `source_file`. Medido antes: as duas formas preservam os **mesmos 12 objetos**, então a troca é exata |

### A raiz estrutural — e o defeito que ela revelou (A6)

O mesmo bug de paginação precisou ser corrigido **duas vezes, em dois arquivos, no mesmo dia**.
Isso não é coincidência, é sintoma: `_rest`/`_storage_list` eram **cópias**. Extraí
`scripts/supabase_rest.py` (mesmo motivo do `febraban.py`).

**A unificação achou um defeito que nenhuma leitura tinha pego:** as cópias **divergiam**. A do
backfill filtrava `id` nulo — placeholder de pasta —, a da purga **não**. Resultado: a entrada
**`manual`** (a pasta dos anexos manuais da migration 079) era listada como objeto, não tinha linha
em tabela nenhuma, virava órfã e **entrava na lista de APAGAR**. Confirmado na execução: os órfãos
caíram de **78 → 77** e o "a apagar" de **67 → 66**, e a diferença é exatamente `manual`.

Duas cópias da mesma função, uma certa e outra não — com a errada apontada para uma operação
destrutiva.

### O mutante que expôs a minha própria guarda

A primeira versão do teste checava a presença da palavra `offset` no corpo de `_rest`. Rodei seis
mutantes; **um passou**: trocar `offset={pagina * PAGE_SIZE}` por `offset=0` **quebra a paginação
de verdade** e mantém a palavra. A guarda era textual demais — exatamente o defeito que o
guardrail 4b do roadmap descreve.

Substituída por `RestGetFuncionalTest`, que prova a garantia pelo **comportamento**: um servidor
falso com 2.350 linhas, e a asserção conta as linhas recebidas e os offsets pedidos. Revalidado:

| Mutante | Antes | Agora |
|---|---|---|
| `offset` não avança | ⚠️ **passava** | ✅ falha |
| para na 1ª página | — | ✅ falha (2 testes) |
| falha de rede vira lista vazia | — | ✅ falha |
| sem `MAX_PAGES` | ✅ falha | ✅ falha |
| só `HTTPError` | ✅ falha | ✅ falha |
| oráculo não passado ao casamento | ✅ falha | ✅ falha |

**Gates:** pytest **851** (+8) · vulture limpo · `check_deploy_parity` 27/27 · comportamento real
inalterado (purga: 515 objetos / 77 órfãos / 11 preservados / 66 a apagar; `--fix-provenance`
idempotente em 0). O módulo novo fica em `scripts/`, **fora** dos `DEPLOY_GLOBS` — não altera o
deploy, como esperado para ferramenta que roda no dev.

**Não alterado:** `main()` do backfill segue **D (23)** e o da purga **C (20)** — não toquei na
estrutura deles (refatoração ampla; o `CLAUDE.md` registra que S3776 se trata função a função). As
funções novas são A/B.
