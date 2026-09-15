---
name: pipeline-extracao
description: >-
  Trabalhar no pipeline de extração de contas a pagar do projeto `pagamentos` — leitura IMAP,
  download de anexo/link, extração por Claude (texto, Vision, .docx), resolução de fornecedor e
  empresa, deduplicação e o status final do e-mail. Cobre as regras que decidem se um documento
  vira conta (fatura+boleto, seguradora, CT-e, não-pagáveis), a autoridade do código de barras
  sobre o vencimento, o guard anti-SSRF do download por link e as armadilhas de robustez que já
  perderam dinheiro em silêncio. Acione SEMPRE que o usuário disser "boleto não extraiu", "e-mail
  ficou em falha", "conta duplicada", "fornecedor errado", "mexer no read_emails/extract_pdf",
  "vencimento errado", "anexo ignorado", ou citar o pipeline de e-mail — mesmo sem dizer "skill".
---

# Pipeline de extração — `pagamentos`

**Casos reais, medições e o histórico de cada regra:** [docs/knowledge/pipeline-extracao.md](../../../docs/knowledge/pipeline-extracao.md).
**Reprocessar/backfill/purga:** skill `scripts-manutencao`. **Publicar:** skill `deploy-producao`.

## Onde mexer

🔴 **`run_reader()` (`skills/email-reader/scripts/read_emails.py`) é a única fonte de verdade da
leitura** — o CLI e o `server/app.py` chamam a mesma função. Nunca duplique lógica no Flask.
`read_emails.py` carrega o `.env` da raiz; `server/app.py` insere o caminho no `sys.path`.

⚠️ **O Flask não tem auto-reload** — reinicie depois de mexer no pipeline.

## Ordem de precedência da extração

```
anexo PDF  →  anexo imagem  →  anexo .docx  →  PDF por link  →  imagem inline  →  corpo do e-mail
```

🔴 **O corpo é fallback SÓ quando o anexo não respondeu por nenhum pagável.** O gate é
`attachment_account`, que é `True` tanto para conta NOVA quanto para boleto **deduplicado**. Usar
`accounts_saved == 0` fazia o corpo criar conta espúria com vencimento divergente.

## O que vira conta (as seis regras de decisão)

| Regra | Decisão | Sinal |
|---|---|---|
| **Fatura + boleto no mesmo e-mail** | só o **boleto** vira conta | **barcode + VALOR**, nunca `document_type` |
| **Extrato/demonstrativo/relatório** junto de boleto | descartado mesmo com valor distinto | nome/descrição (`_is_statement_document`) |
| **Seguradora** | só gera conta com linha digitável válida | contexto detectado **só pelo ASSUNTO** |
| **CT-e / transporte** | só o **boleto** gera conta; CT-e sem boleto ⇒ `ignorado` | `_is_boleto_barcode`, não `document_type` |
| **NF-e / NFS-e pura** | não gera conta (`SKIP_ACCOUNT_TYPES`) | exceto **combinada com boleto** no mesmo PDF ⇒ re-rotulada `boleto` |
| **Não-pagáveis** (baixa de recebível, assinatura, marketing) | `skipped_nonpayable` ⇒ e-mail `ignorado`, não `falha` | conservador: só com `amount<=0` **e** sem barcode |

🔴 **A guarda de VALOR preserva o 2º boleto escaneado.** O descarte da fatura só vale para a linha
sem boleto próprio **cujo valor COINCIDE** com um boleto real do e-mail. Valor **distinto** é
outra dívida e é mantido mesmo sem barcode — é o que salva o boleto cujo Vision não leu a linha
digitável (caso LMED). Bias intencional: **preservar a conta**; perda silenciosa é pior que uma
linha a revisar.

🔴 **`extract_and_store_accounts` roda em DOIS PASSOS** — não regredir para o loop anexo-a-anexo,
que era cego ao resto do e-mail. Passo 1 extrai todos os anexos e coleta as linhas; Passo 2 grava,
já sabendo se existe boleto real e quais valores ele tem. Isso torna a regra **independente da
ordem** dos anexos.

🔴 **Seguradora: contexto SÓ pelo assunto.** Ampliar para `supplier_name` ou domínio do remetente
**destruiria contas que existem hoje** — "Porto Seguro" é fornecedor legítimo de vários ramos
(contas 348, 58 e 617 sobrevivem exatamente por isso).

## Vencimento — o código de barras é autoritativo, com dois gates

O fator de vencimento (posições 6–9) é escrito pelo emissor e é imune à inversão dia/mês que o
Vision comete ao ler a data impressa. Mas ele só manda quando o barcode é **confiável**:

| Gate | Regra | Caso |
|---|---|---|
| 1 | o **valor embutido** no barcode bate com o `amount` (tol. 1 centavo) | id 463: barcode embaralhado por OCR ditou uma data impossível |
| 2 | `vencimento >= emissão` | id 473/474: boleto securitizado com fator **stale** |

🔴 **No caminho `pdf_text`, a data IMPRESSA no texto vence o LLM e o fator.** O fator só volta a
mandar em PDF **escaneado** (sem texto), onde corrige a inversão do Vision.

🔴 **`ref_date` é a data LIDA DO DOCUMENTO, nunca "hoje"** — num reprocessamento histórico o fator
legítimo fica a mais de 2 anos de hoje e o código bom seria descartado. **Fator 0 = boleto à
vista**, legítimo.

🔴 **Barcode que se REFUTA é DESCARTADO** (`barcode_self_refuted`). O OCR de scan desloca dígitos:
o código mantém 44 caracteres — passa no filtro de comprimento — mas sai com valor **10×** e fator
impossível. O gate exige que **os DOIS** testes falhem (valor × `amount`, e fator × data
plausível): um `amount` mal lido ainda tem fator bom, e vice-versa. Isto é proteção **contra
duplicata**: código corrompido não casa o boleto real na 2ª via, e nasce conta duplicada. Medido:
18 corrompidos, **100% `pdf_vision`**. Releitura **não** recupera — não tente reconstruir dígitos.

## Lembrete de vencimento — corrige a data PRESUMIDA (`apply_due_date_reminder`)

Fatura cujo e-mail não traz data nasce com vencimento = emissão **e** com a marca
`DUE_DATE_PRESUMED_NOTE` em `processing_notes` (a coluna "Observações" de `/consulta`). Um lembrete
posterior que **não gerou conta** ("vence em N dias na data de DD/MM/AAAA", "vence hoje/amanhã")
corrige o vencimento — decisão do usuário em 2026-09-14 (caso Leadster).

- 🔴 **Só conta com a marca PRESUMIDA é movida** — vencimento lido de rótulo, tabela ou código de
  barras nunca é sobrescrito por um aviso; e a conta de data lida que **já vence** na data anunciada
  absorve o lembrete (a data não muda), para ela não cair numa presumida vizinha. Se a conta que já
  vence ainda é **presumida**, o lembrete a CONFIRMA (troca a marca, mantém a data) — senão o
  lembrete da fatura seguinte a moveria. `_explicit_body_due_date` é a fonte única das fontes
  explícitas; parcela com data própria, `_apply_barcode_due_date` e a **dedup do anexo** (reemissão
  ou boleto que enriquece) **retiram** a marca — nesta, via `update_financial(..., nullable=...)`,
  porque a marca que era a única nota vira `None` e o filtro de `None` a descartaria.
- 🔴 **Fornecedor por `find_supplier_by_email` (consulta pura)**, nunca `resolve_supplier`, que cria
  cadastro pelo auto-insert.
- 🔴 **Candidato ÚNICO** na janela da emissão (+62 dias). Os lembretes reais **não trazem valor**:
  o valor só filtra quando aparece. Dois elegíveis ⇒ nada muda. 🔴 **Data já CONFIRMADA por
  lembrete nunca é movida** — só reconhece o lembrete repetido; senão o lembrete da fatura
  seguinte (ainda sem conta) moveria a anterior em aberto. O PATCH é condicionado ao
  `due_date` lido, com `return=representation`; lista acima do teto ⇒ não decide.
- ⚠️ Assunto com `lembrete` é ignorado **antes** do download (decisão anterior) e não passa aqui.
- ⚠️ Entre a fatura e o 1º lembrete a conta tem vencimento = emissão, e o batch diário a marca
  `vencido` nesse intervalo.

## Deduplicação — 4 impressões, nesta ordem

Todas escopadas por `sk_supplier` (resolvido **antes** da dedup), nunca por texto de fornecedor.

1. **barcode**
2. **nosso número** — 🔴 com guarda de título (`_same_title`): o campo que o LLM extrai às vezes é
   o código agência/conta do cedente, igual em todos os boletos do fornecedor; `invoice_number`
   que é cópia do nosso número (contas anteriores a 2026-09-15) sai da comparação
   (`_own_document_number`)
3. nº do documento (≥6) + valor — 🔴 ignora número **sintético**; 🔴 nossos números reais e
   **diferentes** vetam (`_distinct_nosso_numero`) — parcelas de carnê repetem Nº e valor
4. **valor + vencimento** — 🔴 **não** exige `document_type` igual (o tipo varia entre os
   documentos que descrevem a mesma dívida)

🔴 **`invoice_number` de boleto é o "Nº do Documento" da ficha — nunca o Nosso Número** (este só
na falta do campo; tem coluna própria). O número impresso vence o modelo
(`apply_boleto_document_number`): lido da linha "Data do Documento | Nº do Documento | Espécie",
só quando todas as leituras concordam; no visual, só com 1 pagável. Contas antigas:
`scripts/reprocess_document_number.py`.

🔴 **A consulta de dedup RE-TENTA em falha de rede.** Um hiccup faria `find_financial_duplicate`
devolver "sem duplicata" e o pipeline **gravaria conta duplicada**. Resultado vazio não é erro.

**Reemissão** (vencimento mais recente) atualiza a conta existente. **Dedup que descarta tudo do
PDF ⇒ status `duplicidade`**, nunca `extraído` — é o que torna a perda auditável.

🔴 **Boleto casado por dedup TAMBÉM vincula o anexo à conta EXISTENTE** (`register_attachment` no
bloco de dedup, não só no de conta nova). O PDF já está no Storage desde o Passo 1; sem o vínculo,
a conta ficava sem nenhum comprovante — sem erro, sem status distinto (achado 2026-09-04,
fornecedor ALKO — contas 1238/1239/1240 sem PDF por dois dias).

## Resolução de fornecedor e empresa

**Ordem da RPC `resolve_supplier_id`:** CNPJ → CPF → nome normalizado → **e-mail exato** →
auto-insert.

- 🔴 **Identificador forte que não casou ⇒ fornecedor NOVO** (migration 109). Sem isso, o endereço
  de uma **plataforma** (`no-reply@sswsistemas.com.br`, compartilhado por dezenas de
  transportadoras) atribuía a conta ao primeiro fornecedor que casasse.
- 🔴 **FALHA da RPC NÃO cai no pagador** (`SupplierResolutionError`). `resolve_supplier` tem três
  desfechos: id · `None` **só** para a recusa "nenhum identificador valido" ou o Supabase
  indisponível · exceção para qualquer
  falha (4xx definitivo não re-tenta; rede/5xx re-tentam). Antes tudo virava `None`: o 22001 do
  auto-insert (nome > 60 caracteres — a migration 138 corta) lançava o boleto do sindicato sob a
  OTIMOTEX com o plano dela (contas 895/1396). Agora a conta vai a `/erros` com o motivo.
- 🔴 **A sondagem do pagador NÃO leva o `sender_email`** — a RPC anexa o e-mail recebido ao
  cadastro que resolveu, e o de terceiro passava a sequestrar contas pelo passo de e-mail (139).
- 🔴 **Guia de tributo com CNPJ de uma PAGADORA:** o CNPJ (do CONTRIBUINTE) sai **sempre** —
  mantido, casaria a OTIMOTEX no passo de CNPJ da RPC, antes do nome. O **nome** sai só se for o
  contribuinte (`_is_contribuinte_name`: razão social exata · token de MARCA · repete o
  `payer_name` · similaridade ≥ `CONTRIBUINTE_NAME_SIMILARITY`); senão é **favorecido real e
  VENCE**. A GNRE imprime grafia própria ("CONFEC**ES**") que a guarda exata não pega (13 guias
  em apelidos, migration 140). Marca e similaridade são complementares; marca sai da `company`
  (palavra na razão social E no fantasia). **Só em guia:** num boleto o CNPJ da LE BLANC vale.
- 🔴 **Fora de guia, BENEFICIÁRIO = a própria pagadora ⇒ sk 1** (`_beneficiary_is_own_payer`,
  conta 933 / migration 141). Três condições cumulativas: CNPJ com a raiz do **sk 1** (não a da
  LE BLANC), nome reconhecido como a pagadora e **pagador TERCEIRO identificado por documento**. O
  pagador é o que separa do bloco do DESTINATÁRIO copiado no fornecedor (MOVVI, onde o pagador é a
  OTIMOTEX). Pagador ausente ⇒ a regra não dispara. **Não herda** o default do sk 1 (RH / Vale
  Alimentação, o plano errado de 895/1396): a conta nasce com o sentinela 0.
- 🔴 **O CNPJ da própria empresa pagadora nunca é o fornecedor** — comparação pela **raiz de 8
  dígitos** (filiais compartilham a raiz).
- 🔴 **A RAZÃO SOCIAL da própria pagadora também não** (`_is_own_company_name`, em
  `_finalize_supplier`) — vale para o nome extraído **e** para os derivados (âncora de sigla do
  assunto, remetente encaminhado, assunto sem âncora). Caso: "Empresa: Têxtil E Confecções
  Otimotex Ltda" no corpo da Leadster casava o sk 4 e impunha o plano ICMS-ST (contas 1020/1474,
  migration 136). **Só razão social, nunca fantasia** ("LEBIANCO" é fantasia da empresa 2 e
  fornecedor legítimo) e **igualdade exata normalizada** — "Confirmação de Títulos TEXTIL … LTDA"
  não é pego, de propósito.
- 🔴 **Só o sk 1 (OTIMOTEX) pode ter a razão social de uma pagadora** (a migration 137 limpou o
  404). A guarda acima não cobre o fallback 6 (`_resolve_supplier_by_payer`), que manda o nome da
  pagadora à RPC **de propósito**; com dois cadastros assim, o passo por nome (`LIMIT` sem
  `ORDER BY`) escolhe qualquer um.
- 🔴 **Tipo de documento ou forma de pagamento nunca vira fornecedor** — "GUIA GNRE" não pode
  criar o fornecedor "GNRE".
- **Fallback quando nada foi extraído:** assunto ancorado em sigla societária → remetente ORIGINAL
  do bloco encaminhado → pagador. A ordem importa: o assunto é sinal do próprio e-mail.
- 🔴 **Guia de imposto sem favorecido ⇒ `OTIMOTEX_SK_SUPPLIER` (1)** — o credor é o Fisco.

**Empresa pagadora (`sk_company`) — a ORDEM é a regra:**

1. menção a **LE BLANC** (`_LE_BLANC_RE`: "le blanc", "leblanc", "le_blanc", "le-blanc") em
   assunto/corpo/remetente/anexo (texto **e** nome do arquivo)/descrição/pagador/**fornecedor**, ou
   `payer_cnpj` com a raiz `20584679` → **4 LE BLANC** — **vence a ester** (decisão 2026-09-11)
2. remetente `ester@otimotex.com.br` (endereço **exato**) → **3 FARDOS** — vence o domínio e a
   menção a lebianco
3. referência a "lebianco" (assunto/corpo/anexo/remetente/domínio) → **2 LEBIANCO** — **vence o
   CNPJ**
4. nada disso → **1 TECIDOS** (default)

⚠️ **`OTIMOTEX_SK_SUPPLIER` (=1) ≠ `SK_COMPANY_DEFAULT` (=1)** — tabelas diferentes, mesmo valor.
Nunca find-replace nos dois (há teste travando).
🔴 **`supplier_name`/`supplier_cnpj` ficam FORA da varredura de lebianco** — a LEBIANCO pode ser o
FORNECEDOR, e aí quem paga é a OTIMOTEX.
🔴 **Assimetria deliberada: o fornecedor LE BLANC CLASSIFICA** (o usuário decidiu que toda menção
vale). O sinal é capturado por `_le_blanc_supplier_signal` **antes** de `_finalize_supplier`, que
remove as colunas de fornecedor — depois dele a fornecedora lida só pelo Vision some em silêncio.
🔴 **A fronteira à direita do regex não se remove** — sem ela "LEBLANCO" (OCR de LEBIANCO) casaria.
Lookaround, não `\b`: o `\b` trata `_` como letra e perderia `BOLETO_LEBLANC_.pdf`.
🔴 **"LE BIANCO" (com espaço) vale só no ASSUNTO** — no corpo aparece na assinatura do grupo.
⚠️ **"LE BLANC" vale em TODA fonte, inclusive o corpo** — se a assinatura do grupo passar a citá-la,
toda conta vira 4 (o mesmo modo de falha da conta 167). Testes: `tests/test_sk_company_le_blanc.py`.

## Boleto por link — o guard anti-SSRF não se remove

Conteúdo de remetente desconhecido controla a URL. `_is_safe_download_url` bloqueia scheme ≠
http(s), porta malformada e host que resolve para IP **interno**; `_SafeRedirectHandler`
**revalida cada redirect**; os PDFs são contidos em `PDF_INBOX` (`_is_within_inbox`).

- 🔴 **NÃO há allowlist de portas — e não reintroduzir.** Ela barrava o boleto das seguradoras
  (redirect para `mdi.li:7000`, host público). A proteção real é o teste de **IP interno**.
- 🔴 **`_PinnedHTTPSHandler` não pode referenciar `self._check_hostname`** — atributo removido no
  Python 3.12+; sob o 3.14 (produção) quebrava **todo** download HTTPS.
- 🔴 **Erro de código não se disfarça de "link inacessível"**: `_fetch_url` separa falha de **rede
  esperada** (`log.info`, silencioso) de erro **inesperado** (`log.exception` com traceback). Um
  `except Exception` mudo escondeu o bug do 3.14 por dias.
- **Links suspeitos são ignorados** (redirecionadores ofuscados, SafeLinks, Proofpoint).
- **SSW:** preferir o link de **FATURA** (`F`) e descartar os DACTE (`D`/`E`/`X`) — o 1º byte do
  `id` em hex→ASCII indica o tipo.

## Robustez — o que já congelou ou perdeu dado

| Proteção | Sem ela |
|---|---|
| **IMAP com timeout** (`IMAP_TIMEOUT`, 120 s) | um `fetch` que estanca **congela o run síncrono para sempre** |
| **IMAP com retry/backoff** (connect+select+search como unidade) | falha transitória derruba o run inteiro |
| **IMAP fechado em `try/finally`** | exceção deixa a conexão aberta |
| **Claude API com timeout** (`CLAUDE_API_TIMEOUT`, 90 s) | o SDK usa ~10 min/request; um request travado congela o pipeline |
| **Extração IN-PROCESS** (`extract_to_csv`, sem subprocess) | `rc=0xC0000142` — 100% das extrações falhavam quando o spawn partia do Flask |
| **`_rfc822_from_fetch`** | `imaplib` intercala respostas e `data[0][1]` devolve um `int` → crash intermitente |

🔴 **Resposta do modelo TRUNCADA nunca vira dado.** Boleto escaneado de 6-8 páginas vai numa única
leitura Vision e o modelo responde um **ARRAY**; cortado no teto, o JSON não parseava, virava
registro vazio e o e-mail era logado como `sem_valor` — a falha do EXTRATOR disfarçada de
"documento sem valor". Custou 3 e-mails, 21 boletos, **R$ 315.556,57**. Três correções, todas
necessárias: `VISION_MAX_TOKENS` (8000), `_response_text` recusa `stop_reason='max_tokens'`, e
`build_records` aceita ARRAY → N registros.

🔴 **N registros só no caminho VISUAL.** No `pdf_text` o pós-processamento é do documento inteiro e
daria a todos o barcode do primeiro; ali o array vira `_failure_record`, que cai no fallback
tier-2 (Vision) — o caminho que aceita array.

## Status final do e-mail (`status_for_result`)

🔴 **CONTA GRAVADA ⇒ STATUS QUE DECLARA CONTA.** Prioridade: conta do PDF (`extraído`) → **conta
do corpo (`recebido`)** → NF-e pura → não-pagável → CSV do PDF → **duplicidade** → anexo sem conta
(`pendente`) → notificação → `falha`.

Nenhum sinal que descreve o **ANEXO** (`pure_nfe`, `nonpayable`, `csv_generated`) pode ser
avaliado antes dos dois sinais de conta — nenhum deles refuta uma conta que existe no banco.
`body_created` subiu para o 2º lugar em 2026-08-17: estava abaixo de `nonpayable`, e um anexo NF
pulado mandava para `ignorado` e-mail cuja conta o CORPO havia gravado (**13 e-mails, ~R$ 80 mil**
escondidos atrás do card "Ignorados"; backfill = migration 130).

A guarda é o **invariante exaustivo** (2^8 combinações) em `InvarianteContaGravadaTest`, com
anti-vacuidade dupla, mais `ProcessMessageAnexoNaoPagavelComCorpoTest`, que **executa**
`process_message`.

⚠️ **Ao contar contas de um e-mail, casar `gmail_message_id` com `LIKE '<id>#%'`** — múltiplos
pagáveis recebem sufixo `#N`. E **nunca** `LIKE message_id || '%'`: Message-ID contém `_`, que é
curinga no LIKE (62 dos 1.462 têm).

## Filtro de assunto

🔴 **`run_reader` registra TODOS os e-mails** em `email_control` — a keyword decide **o que
extrair**, não o que registrar.

- 🔴 **`match_keyword` casa acrônimo de tributo por PALAVRA INTEIRA** (`das`, `iss`, `gru`, `dae`)
  — substring pegaria "ca**das**tro", "em**iss**ão", "**gru**po".
- **Filtros FORTES** (antes do match): remetente de sistema, **confirmação de pagamento**
  (particípio no passado) e `lembrete`. 🔴 A forma NEGADA inverte: "**não** recebemos o seu
  pagamento" é COBRANÇA.
- **Filtro FRACO** (`notification`) só produz `ignorado` quando não houve anexo/CSV/conta. 🔴
  `email_sem_conteudo_extraivel` exige **AUSÊNCIA de link** — com link, o download fracassou e
  isso continua sendo `falha`.

## Testes

```powershell
py -3 -m pytest tests/ -q          # a suíte inteira após mexer no pipeline
```

Arquivos-chave: `test_fatura_boleto.py`, `test_vision_multi_boleto.py`,
`test_barcode_self_refuted.py`, `test_ssrf_guard.py`, `test_status_for_result.py`,
`test_email_sem_pagavel.py`, `test_doc_type_domain_consistency.py`, `test_docx_*.py`.

🔴 **Guarda de wiring por TEXTO não cobre o call site EXECUTADO** — ela prova que a chamada
existe, não que funciona (não vê escopo, ordem de atribuição, exceção nem tipo). Acrescente
sempre um caso que **execute a função de topo** por caminho estrutural.
