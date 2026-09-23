# Code Review — Features, working tree (2026-09-22)

## Resumo
Alvo: correção do carnê RAINHA MARIA (plano em `~/.claude/plans/buzzing-wandering-wind.md` — fora do repositório, declarado)
Modo: max (passo de ataque + verificação adversarial)
Delta: 15 arquivos alterados (+727/−57) e 4 novos (migrations 143/144, `tests/test_vision_barcode_dv.py`, `tests/test_reprocess_conferencia.py`)
Régua: `CLAUDE.md` do projeto (Regras 2 e 4, "Pipeline de extração — invariantes", "Banco de dados"), skills `pipeline-extracao` e `scripts-manutencao`, `docs/knowledge/pipeline-extracao.md`, `docs/padrao-execucao.md`
Gates: pytest **1808 passed** (+33 sobre 1775) · `npm run lint` **exit 0** · `check_deploy_parity` **32/32** · npm test (Vitest) **não executado** — delta sem TS/JS · e2e Playwright **não executado** (não roda no sandbox do agente) · ruff **não é gate deste projeto** (8 achados em arquivo não tocado = ruído preexistente)
Verificação adversarial: 6 contestações; 9 confirmados, 0 enfraquecidos, 1 refutado

A mudança corrige quatro defeitos reais e medidos do pipeline (parcela de carnê descartada, vencimento de boleto prorrogado, barcode convertido errado no Vision, nota apagada pelo builder) e repara os dados por duas migrations já aplicadas. O diagnóstico e as correções de dado resistiram ao ataque: as sondas das 143/144 conferem contra o banco, a isenção de carnê não regride LMED/Correios/SURA/Amil, e as 15 contas do e-mail ficaram com um anexo cada.

**O que NÃO resistiu é a 2ª barreira de DV no caminho visual.** Ela reintroduz, por outra porta, exatamente a classe de defeito que este trabalho existe para matar: um boleto REAL passa a chegar sem código de barras, e a 3ª impressão digital da dedup — que não tem veto por nosso número — o funde com um irmão de mesmo valor e vencimento. Há grupo real na base (fornecedor 1262, R$ 227,85, 4 documentos, 3 com DV refutado). Mais dois bloqueantes na mesma família: o vencimento **presumido** do corpo passou a ser tratado como "data impressa", e o descarte do código roda **antes** da correção pelo fator, desligando no Vision a rede que existe desde o id 435.

## Achados

### 🔴 Bloqueantes

- [skills/pdf-contas-pagar/scripts/extract_pdf.py:1556 + skills/email-reader/scripts/read_emails.py:1120] Descartar o barcode no caminho VISION quebra a premissa da 3ª impressão digital da dedup e reintroduz PERDA SILENCIOSA de pagável.
  Falha:     2º/3º boleto do mesmo fornecedor, mesmo valor e mesmo vencimento, lido por Vision com DV refutado → `barcode = None` → fp1 pulada, fp1b/fp2 não casam (números próprios distintos) e **fp3 casa o irmão**: a conta não é gravada, sem erro, sem `/erros`, e-mail `extraído`.
  Evidência: o comentário de `find_financial_duplicate` (linha 1120-1122) declara a premissa que o descarte quebra — "o documento sem linha digitável nunca é um 2º pagável legítimo"; `base3` (1109-1111) é só fornecedor+valor+vencimento, sem veto por nosso número. Grupo real medido: sk_supplier 1262, R$ 227,85, venc. 2026-07-20 — contas 648 (DV ok), 649, 650, 652 (DV refutado) ⇒ 3 contas somem, R$ 683,55. Na base há 40 grupos (fornecedor, valor, vencimento) com mais de um boleto.
  Correção:  marcar o descarte (constante canônica de nota) e, em `find_financial_duplicate`, aplicar `barcode=is.null` à fp3 também quando o documento TINHA código e ele foi descartado.
  Regra:     `CLAUDE.md` — "perda silenciosa é pior que uma linha a revisar"; dedup, impressão 3.
  Veredito:  CONFIRMADO [verificado]

- [skills/email-reader/scripts/read_emails.py:307] Vencimento PRESUMIDO (caminho do corpo) passou a ser tratado como "data impressa": o fator perde e a marca que permitiria corrigir depois é apagada.
  Falha:     e-mail de cobrança com linha digitável no corpo e boleto já vencido → a conta nasce com `due_date` = data do e-mail (futura), a marca `DUE_DATE_PRESUMED_NOTE` é removida e `apply_due_date_reminder` nunca mais a corrige. A conta fica fora do aging e da cobrança, com uma nota que afirma prorrogação que não houve.
  Evidência: reproduzido — payload do corpo com `due_date=2026-10-01` + marca presumida e barcode de fator 2026-09-21 ⇒ `due: 2026-10-01 | marca presumido ainda existe? False`. Antes da mudança o fator vencia. População viva: 6 contas `email_body` com barcode de boleto.
  Correção:  se `_has_presumed_due_marker(...)`, o fator vence incondicionalmente — presumido não é impresso.
  Regra:     skill `pipeline-extracao`, "Lembrete de vencimento — corrige a data PRESUMIDA".
  Veredito:  CONFIRMADO [verificado]

- [skills/pdf-contas-pagar/scripts/extract_pdf.py:1556] A barreira de DV roda ANTES de `apply_barcode_due_date` e joga fora um fator comprovadamente correto — desliga no Vision a rede do id 435.
  Falha:     boleto escaneado cujo código o modelo converteu errado (valor e fator intactos) e cuja data impressa o Vision leu errado → o código é anulado antes da derivação, e a data errada sobrevive sem ressalva nenhuma.
  Evidência: reproduzido — código com fator 2026-09-22 e DV refutado, data lida 2026-12-09 ⇒ `vision -> barcode: None | due: 2026-12-09`. Diferença de 78 dias, sem nota sobre o código.
  Correção:  mover o descarte de DV para DEPOIS da cadeia `apply_*` (o fator já é cross-validado por valor + emissão), mantendo o descarte só para o que vai ao banco e à dedup.
  Regra:     `CLAUDE.md` — "Vencimento é AUTORITATIVO pelo fator do código de barras".
  Veredito:  CONFIRMADO [verificado]

### 🟡 Recomendados

- [skills/pdf-contas-pagar/scripts/extract_pdf.py:564] As notas de vencimento ficam obsoletas e podem se acumular contraditórias.
  Falha:     no caminho de texto, `apply_barcode_due_date` anota com a data do LLM e `apply_text_due_date` troca o `due_date` depois; a nota permanece citando uma data que não é a do registro. Com duas passagens, saem duas notas "Vencimento IMPRESSO mantido" com datas diferentes — a mesma assinatura que a correção existe para eliminar.
  Evidência: reproduzido nas duas direções; `_append_note_once` só deduplica texto idêntico, e as notas diferem nas datas. `_without_due_date_markers` filtra apenas presumido/lembrete.
  Correção:  tratar a nota de vencimento como ESTADO, não evento: remover os segmentos com os prefixos canônicos antes de escrever o novo, nos dois escritores.
  Veredito:  CONFIRMADO [verificado]

- [scripts/reprocess_message.py:148] A conferência trata anexo EXTRA como divergência — e o teste novo congela o falso positivo como comportamento esperado.
  Falha:     conta que legitimamente acumulou a 2ª via (invariante documentado: "boleto casado por dedup TAMBÉM vincula o anexo à conta EXISTENTE") é relatada como "anexo de OUTRO documento" e o script sai com exit 3.
  Evidência: simulação sobre o acervo — **26 e-mails (~3%) sairiam com exit 3; 40 contas por "anexo extra"** (falso) contra 7 por "falta o seu" (real). Caso concreto: conta 1573. `tests/test_reprocess_conferencia.py:65` espera 1 divergência para "o seu + um extra".
  Correção:  divergência é "a conta não tem o SEU arquivo entre os anexos vivos"; anexo extra não conta. Pular conta sem `source_file` e re-especificar o teste.
  Veredito:  CONFIRMADO, com a causa corrigida — o cenário originalmente levantado (conta do corpo com anexo) tem **0 casos** hoje [verificado]

- [skills/email-reader/scripts/read_emails.py:6070] O dead-man switch da regra de VALOR é inalcançável por construção.
  Falha:     a entrada no descarte exige `not _has_own_bank_title(...)` e o switch retorna cedo a menos que `_has_own_bank_title(...)` — negação exata dos mesmos argumentos. A regra que custou R$ 150.552,00 segue 100% muda para tudo que descarta.
  Evidência: mutante — neutralizar o call site da regra de valor não deixa nada vermelho (`tests/test_fatura_boleto.py`: 29 testes OK).
  Correção:  no call site de valor, registrar quando a linha tiver qualquer sinal de pagável perdido (nosso número real **ou** `document_type='boleto'` com valor > 0).
  Veredito:  CONFIRMADO [verificado]

- [skills/pdf-contas-pagar/scripts/febraban.py:484] O teto de 180 dias converte erro de leitura "para frente" em prorrogação, e a nota afirma a prorrogação como causa.
  Falha:     data lida 78 dias à frente do fator (erro de dígito de mês) é aceita como prorrogação e gravada com ressalva que declara "boleto prorrogado/reemitido pelo beneficiário" — um fato não observado.
  Evidência: reprodução do bloqueante B3 aceitou 78 dias; os casos reais medidos ficam entre 1 e 14 dias.
  Correção:  apertar o teto para a folga medida (60 dias) e redigir a nota como divergência observada, não como causa presumida.
  Veredito:  CONFIRMADO [verificado]

- [supabase/migrations/144 — estado do banco] 7 contas afirmam "Código de barras descartado" **e** têm código de barras.
  Falha:     a coluna "Observações" — que o operador lê para decidir se confere o papel — contradiz o próprio registro nas contas 1616-1620, 1656 e 1657.
  Evidência: consulta ao banco: 7 linhas com `processing_notes ILIKE '%digo de barras descartado%'` e `barcode IS NOT NULL`.
  Correção:  limpar a nota das contas cujo código foi devolvido pela 144 (migration nova, sem reescrever as já aplicadas).
  Veredito:  CONFIRMADO [verificado]

- [apps/frontend-vite/src/components/statusBadge.variants.ts:51] O tipo de erro novo `pagavel_descartado` cai no badge neutro (cinza) da tela `/erros`.
  Falha:     um sinal de pagável possivelmente perdido aparece com a mesma cor de um estado benigno — o oposto do propósito do alerta.
  Evidência: o mapa de variantes não tem a chave; `defaultVariants: { variant: 'neutral' }` (linha 26).
  Correção:  acrescentar `pagavel_descartado: 'amber'` ao mapa (exige teste do frontend, que o delta atual não toca).
  Veredito:  CONFIRMADO [verificado]

### 🔵 Opcionais

- [supabase/migrations/143:129] Sonda P1b é quase vacuosa (só falharia onde P1 já falha) e o baseline do P4 usa faixa de id enquanto o UPDATE do Bloco 2 usa Message-ID — os conjuntos coincidiram neste caso, mas o oráculo não prova o que afirma. Lição para a próxima migration: derivar o baseline do MESMO predicado do UPDATE.
- [skills/email-reader/scripts/read_emails.py:5658] Risco residual da isenção de carnê: se o boleto real do e-mail não tiver nosso número (105 de 730 boletos da base), uma fatura que tenha um passa a ser preservada. Mitigado pela dedup (fp2/fp3 casam valor+vencimento), e o desfecho é conta duplicada visível, não perda silenciosa — bias declarado do projeto.

## Pendências (trabalho incompleto)
- [produção] `febraban.py`, `extract_pdf.py`, `read_emails.py` e `deploy-manifest.json` ainda **não** foram copiados para `C:\Sheild\API\Pagamentos` — cópia manual do usuário — **bloqueante para o efeito valer em produção**.
- [dados] 16 barcodes corrompidos históricos (`pdf_vision`) seguem na base; ids listados em `progress.md`. — recomendada
- [docs] `CLAUDE.md` e a skill citam "20 códigos" medidos; após a 143 restam 16. — opcional

## Drift código × documentação
- O plano aprovado dizia "a mesma isenção vale para a guarda de extrato"; a implementação **não** isenta o extrato (um extrato não é título) e apenas o instrumenta com o dead-man switch. Código, skill e testes estão coerentes entre si; o desvio é em relação ao plano e é deliberado — registrado aqui para decisão do usuário.

## Não coberto
- `docs/knowledge/pipeline-extracao.md` (1.942 linhas) e `progress.md` foram lidos por seções, não por inteiro — as edições do delta neles são aditivas.
- Vitest/e2e não executados (justificados no Resumo); o achado do badge `pagavel_descartado` é de leitura de código, sem execução de teste de frontend.
- Nenhuma dimensão de concorrência aplicada: o pipeline é sequencial e as migrations rodaram em transação única.

---

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| B1 | Descarte de barcode no Vision quebrava a impressão 3 da dedup ⇒ perda silenciosa | ✅ corrigido | Marca canônica (`febraban.barcode_discarded_note`/`barcode_was_discarded`) atravessa o CSV; `find_financial_duplicate` aplica `barcode=is.null` à fp3 quando o documento TINHA código. Teste: `tests/test_dup_by_supplier_id.py::BarcodeDescartadoNaImpressao3Test` (2 casos, mutante vermelho) |
| B2 | Vencimento PRESUMIDO tratado como data impressa | ✅ corrigido | `_apply_barcode_due_date`: com a marca de presumido, o fator vence incondicionalmente. Teste: `test_due_date_reminder.py::test_vencimento_PRESUMIDO_nunca_vence_o_fator` + contraprova de anti-vacuidade |
| B3 | Descarte de DV rodava ANTES da derivação pelo fator | ✅ corrigido | Extraído para `_discard_dv_refuted_barcode`, chamado no FIM de `_build_records_vision`: o código alimenta a data e só depois sai. Teste: `test_vision_barcode_dv.py::test_o_fator_do_codigo_descartado_AINDA_corrige_a_data` |
| R1 | Notas de vencimento obsoletas/contraditórias | ✅ corrigido | `strip_due_date_notes` (fonte única) nos três pontos de decisão; nota reescrita como divergência observada, não causa presumida |
| R2 | Conferência tratava anexo EXTRA como divergência (40 contas / 26 e-mails) | ✅ corrigido | Divergência = "não tem o SEU arquivo"; conta sem `source_file` é pulada. O teste que congelava o falso positivo foi re-especificado (`test_anexo_EXTRA_nao_e_divergencia`) |
| R3 | Dead-man switch inalcançável na regra de valor | ✅ corrigido | Virou PREVENÇÃO: código descartado passou a ISENTAR a linha (era metade da perda da NF 1724). O switch ficou só onde é alcançável (extrato/seguradora), com a ausência documentada no call site |
| R4 | Teto de 180 dias acolhia erro de leitura como prorrogação | ✅ corrigido | Teto em **60 dias** (4× o extremo medido) + caso novo `test_erro_de_mes_na_leitura_nao_vira_prorrogacao` |
| R5 | 7 contas afirmavam "código descartado" tendo código | ✅ corrigido | **Migration 145** aplicada (remove só o segmento da nota; P2 prova que a nota sobrevive onde é verdadeira) |
| R6 | `pagavel_descartado` caía no badge neutro em `/erros` | ✅ corrigido | `statusBadge.variants.ts` → âmbar; 18 testes do frontend passam |

Gates após a correção: **pytest 1817** (+9 sobre 1808) · **lint exit 0** · **paridade 32/32** (manifesto regravado) · Vitest do badge **18 passed** · **9 mutantes, 9 vermelhos**, todos revertidos e confirmados
Baseline (Passo 3):  pytest 1808 · lint exit 0 · paridade 32/32

Re-review do diff da correção: **1 achado novo, corrigido na hora** — a docstring de `apply_barcode_due_date` ainda citava `_append_note_once` como razão da idempotência depois que o `strip` assumiu esse papel. Verificado também: nenhuma referência órfã à função removida (`_looks_like_lost_payable`), imports sãos nos três módulos, e `strip_due_date_notes` preserva a marca de presumido e a nota de "vencimento ausente".

Não corrigido por decisão sua:
- **Drift plano × implementação** (isenção do extrato) — a doc não é sincronizada pelo review.
- 🔵 Sondas da migration 143 (P1b quase vacuosa; baseline por faixa de id) — artefato já aplicado; a lição vale para a próxima.
- 🔵 Risco residual da isenção quando o boleto real não tem nosso número.
- **Pendência de ambiente:** a cópia para `C:\Sheild\API\Pagamentos` é manual e é sua.

Nada foi commitado.

---

## Fechamento dos itens deixados em aberto (2026-09-23)

Os dois itens que o review havia deixado para decisão do usuário foram resolvidos a pedido dele.

**1. Pendência de dados — 16 barcodes corrompidos históricos: ✅ RESOLVIDA (migration 146).**
Todos os 16 são PDFs **sem camada de texto** (por isso `pdf_vision`), então a linha digitável foi
lida da imagem do documento original no bucket e submetida a três testes independentes antes de
entrar na migration: DV geral fecha, valor embutido == `amount` da conta e fator == vencimento
**impresso** no próprio boleto. Os dois primeiros viraram sonda em SQL, porque os dígitos foram
transcritos à mão — um erro de transcrição gravaria outro código inventado, que é exatamente o
defeito corrigido. A sonda **P6** é o oráculo do acervo e passou: **0 de 843** boletos da base
seguem com DV refutado. A dívida é FECHADA — desde 22/09 o pipeline descarta o código refutado em
vez de gravá-lo.

⚠️ **Achado colateral, registrado e NÃO corrigido:** em 9 dessas contas o `due_date` diverge do
vencimento impresso no boleto (conta 646: 20/07 × 07/08; conta 1572: 21/09 × 19/10; contas
649-652: 20/07 × 23/07). É consequência do mesmo defeito — com o código corrompido, o gate de valor
reprovava e o fator nunca corrigia a data. As 16 estão **pagas**; alterar vencimento de conta
fechada é decisão de negócio, não consequência de uma correção de código de barras.

**2. Drift plano × implementação — isenção da regra de EXTRATO: ✅ RESOLVIDO implementando o plano.**
A investigação mostrou que o desvio não era só formal: `_is_statement_document` julga pelo NOME DO
ARQUIVO e só se protegia sozinha enquanto a linha tinha barcode (`if _is_boleto_barcode(...):
return False`). Quando o caminho visual passou a **descartar** o código refutado pelo DV, essa
proteção caiu justamente para o boleto escaneado: um PDF chamado `relatorio_cobranca.pdf` perderia
o código e seria apagado **por causa do nome**. A isenção de `_has_own_bank_title` passou a valer
também ali; o extrato de verdade (caso Correios id 605 — sem nosso número e sem código) segue
descartado. O **dead-man switch** ficou só na regra da **seguradora**, a única que não isenta —
nas outras duas ele seria inalcançável por construção.

Testes: `test_boleto_com_NOME_de_relatorio_e_titulo_proprio_e_preservado`,
`test_extrato_SEM_titulo_proprio_segue_descartado` e
`test_seguradora_com_titulo_proprio_dispara_o_dead_man_switch` — **3 mutantes, 3 vermelhos**.

Gates: **pytest 1819** · lint exit 0 · paridade 32/32 · migrations 145 e 146 aplicadas e
idempotentes. Nada foi commitado.
