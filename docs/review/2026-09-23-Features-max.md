# Code Review — Features, working tree (2026-09-23)

## Resumo
Alvo: nenhum (review do diff completo)
Modo: max (passo de ataque + verificação adversarial)
Delta: 17 arquivos alterados (+1033/−65) e 6 novos (migrations 143–146, `tests/test_vision_barcode_dv.py`, `tests/test_reprocess_conferencia.py`). O relatório de 2026-09-22 (untracked) ficou fora da varredura, que é o procedimento do rito
Régua: `CLAUDE.md` do projeto (Regra 2, "Pipeline de extração — invariantes", "Dedup — 4 impressões", "Banco de dados"), skills `pipeline-extracao` e `scripts-manutencao`, relatório `docs/review/2026-09-22-Features-max.md` (o que já tinha sido corrigido)
Gates: pytest **1819 passed** · `npm run lint` **exit 0** · `check_deploy_parity` **32/32** · Vitest do badge: 5 arquivos/53 testes verdes (rodados pela contestação, com mutante) · e2e Playwright **não executado** (não roda no sandbox do agente)
Verificação adversarial: 5 contestações; 3 confirmados, 0 enfraquecidos, 0 refutados (placar do B1: 2 CONFIRMADO × 1 ENFRAQUECIDO)

O review de ontem já tinha revisado a maior parte deste delta. Este passa de novo pelo diff inteiro, incluindo o código das correções de ontem e a migration 146, que ninguém havia revisado. As migrations 143–146 resistiram: sondas por predicado, oráculo de linha inteira, DV e valor recalculados em SQL. O que **não** resistiu foi a correção B1 de ontem na dedup. Ela fecha só metade da porta: dois boletos irmãos com código descartado ainda se fundem, e um boleto íntegro se funde com o irmão descartado e grava o próprio código na conta dele. O caso concreto está no banco: contas 1582/1583/1584 da RAINHA MARIA, do **mesmo** e-mail, com o mesmo valor, o mesmo vencimento impresso e 100% `pdf_vision`.

## Achados

### 🔴 Bloqueantes

- [skills/email-reader/scripts/read_emails.py:1152-1160] Na impressão 3 da dedup, documento com código DESCARTADO exige do candidato só `barcode=is.null`, mas o IRMÃO descartado também tem barcode nulo. Resultado: os dois se fundem, e um boleto de código íntegro se funde com o irmão descartado.
  Falha:     lote com 2+ boletos do mesmo fornecedor, valor e vencimento lidos por Vision, com DV refutado em pelo menos um. O 1º é gravado com barcode nulo. O 2º casa o 1º (`dup_matches += 1`), **não é gravado** e tem o PDF vinculado à conta errada. O e-mail fica `extraído`, sem nada em `/erros`. Se o 2º tem código íntegro, o ramo de enriquecimento (≈6302) grava o código DELE na conta do 1º, que passa a descrever outro título.
  Evidência: `find_financial_duplicate` real executado contra um PostgREST simulado. A tabela tem a conta 649 descartada. O payload 650 descartado, com nosso número distinto, devolve 649; o payload com código íntegro também devolve 649. No banco, 6 grupos (fornecedor, valor, vencimento) têm >1 boleto `pdf_vision`, e 1582/1583/1584 (R$ 29.949,43, venc. 2026-09-25) são do mesmo e-mail, posições #1-#3. Taxa histórica de DV refutado em `pdf_vision`: 20 de ~129 códigos. O teste `BarcodeDescartadoNaImpressao3Test` promete proteger o grupo 1262, mas só afirma que a URL contém `barcode=is.null`: a tabela simulada devolve `[]` sempre, e a garantia nunca é observada (Regra 2).
  Correção:  quando o candidato da impressão 3 também foi descartado, vetar o casamento se os títulos forem provadamente distintos (`_distinct_nosso_numero` ou Nº de documento próprio diferente, os mesmos helpers de 1b/2). O teste passa a simular uma tabela com o irmão gravado.
  Regra:     `CLAUDE.md` — "Dedup — 4 impressões" e "perda silenciosa é pior que linha a revisar".
  Veredito:  CONFIRMADO [verificado]. A lente de impacto (ENFRAQUECIDO) acertou num ponto: a correção **originalmente** proposta, um filtro por texto na URL, criaria duplicata na 2ª via do mesmo título e, sem `quote`, desligaria a impressão 3 em silêncio (`InvalidURL` engolido). Por isso a correção acima foi trocada pelo veto de título distinto, que preserva a 2ª via.

### 🟡 Recomendados

- [skills/email-reader/scripts/read_emails.py:~342] A rede do `register_financial` apaga a nota "Vencimento corrigido pelo código de barras" que o extrator acabou de escrever: a troca de vencimento chega ao banco sem rastro.
  Falha:     boleto (texto ou Vision) com código íntegro e data lida anterior ao fator. O extrator corrige e anota; na gravação, `cur == bc_due`, o `_strip_due_date_notes` roda antes do `return` e nenhuma nota é reescrita → `processing_notes = None`. É a regressão exata do defeito nº 4 que este delta declara ter corrigido.
  Evidência: execução: `_build_records_vision` → nota presente; `_apply_barcode_due_date(rec)` → `None`. No `HEAD` só `_without_due_date_markers` rodava ali, e a nota sobrevivia. `NotaDoBuilderSobreviveTest` promete que "a nota tem de chegar ao registro", mas exercita só o builder (Regra 2: testar a função pura não cobre o call site). Banco: 4 contas carregam essa nota hoje.
  Correção:  com `cur == bc_due`, preservar só a nota "corrigido" cuja data de destino é a do próprio registro e remover as demais notas de decisão. Teste pelo caminho extrator → gravação.
  Veredito:  CONFIRMADO [verificado]

- [apps/frontend-vite/src/components/statusBadge.variants.ts:65] `pagavel_descartado: 'amber'` entrou sem nenhum teste que a observe.
  Falha:     remover a linha devolve o alerta de pagável descartado ao badge cinza (`neutral`), indistinguível de estado benigno, e nada fica vermelho.
  Evidência: mutante aplicado (linha removida): `StatusBadge.test.tsx`, `StatusBadge.a11y.test.tsx`, `Erros.test.tsx`, `Emails.test.tsx` e `contrast-usage.a11y.test.ts` → 53 testes verdes. Arquivo restaurado e conferido.
  Correção:  caso em `StatusBadge.test.tsx` afirmando a variante âmbar para `pagavel_descartado`.
  Regra:     `CLAUDE.md` Regra 2 (todo componente alterado tem teste; validação por mutante).
  Veredito:  CONFIRMADO [verificado]

### 🔵 Opcionais

- [skills/email-reader/scripts/read_emails.py:~5753] `_has_own_bank_title` testa a marca de descarte ANTES da comparação de nosso número. O docstring afirma que "uma fatura que repita o nosso número do boleto NÃO é isentada", mas uma 2ª cópia escaneada do mesmo boleto, com código descartado e o mesmo nosso número, é isentada. O desfecho é o mesmo de antes do delta (conta duplicada visível, não perda) e a dedup 1b a pega quando o nosso número foi lido. Inverter a ordem alinharia código e docstring.
- [apps/frontend-vite/src/pages/Erros.tsx:13] `pagavel_descartado` não está no `ERROR_TYPES` do filtro de `/erros`: o alerta aparece na lista e no total, mas não é filtrável. `pdf_protegido` segue o mesmo padrão.
- [supabase/migrations/146:2049] O comentário diz "só onde o código atual É o corrompido (DV refutado)", mas o predicado é `IS DISTINCT FROM bc_certo`. As sondas P4/P6 são globais, então uma reexecução futura pode abortar por dado novo. A migration já está aplicada; a lição fica para a próxima.

## Pendências (trabalho incompleto)
- [produção] `febraban.py`, `extract_pdf.py`, `read_emails.py` e `deploy-manifest.json` ainda não foram copiados para `C:\Sheild\API\Pagamentos` (cópia manual sua) — **bloqueante para o efeito valer em produção**, e agora devem ir **depois** da correção do B1.
- [dados] 9 contas pagas com `due_date` divergente do vencimento impresso (registradas na 146) aguardam sua decisão — opcional.
- Varredura de marcadores: 1 ocorrência, falso positivo ("TODO codigo" = "todo código", na 144). Nenhum `skip`, stub ou print de debug.

## Drift código × documentação
- `docs/knowledge/pipeline-extracao.md:607` (texto do próprio delta) diz que o fator vence quando a data lida está "a mais de **180 dias** depois". O código (`_DUE_DATE_EXTENSION_MAX_DAYS = 60`), o `CLAUDE.md` e a skill dizem 60 — decisão pendente do usuário.
- `docs/knowledge/pipeline-extracao.md:593` diz que "as três regras de descarte ganharam **dead-man switch**". O código e a skill o mantêm só na seguradora (nas outras seria inalcançável) — decisão pendente do usuário.

## Não coberto
- `read_emails.py` e `extract_pdf.py` foram lidos por hunk mais as funções vizinhas tocadas (`find_financial_duplicate`, os helpers de título e a condição do descarte por auto-refutação), não por inteiro. `docs/knowledge/pipeline-extracao.md` e `progress.md`, por hunk.
- As migrations 143–146 já estão aplicadas: revisadas por leitura, sem reexecução.
- Concorrência não exercida: o pipeline é sequencial e as migrations rodam em transação única.
- Residual conhecido, **fora do delta**: dois boletos irmãos SEM código lido (nunca houve código, logo não descartado) e com nossos números distintos continuam casando pela impressão 3 ampla. O comportamento é preexistente e não entra na correção.

---

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| B1 | Irmãos com código descartado se fundiam na impressão 3 da dedup | ✅ corrigido | `read_emails.py` `find_financial_duplicate`: candidato **também descartado** + título provadamente distinto (`_distinct_nosso_numero` ou Nº próprio diferente, mesmos helpers de 1b/2) ⇒ não deduplica. Sem filtro de texto na URL, o que evita os dois problemas levantados pela contestação. Teste `IrmaosDescartadosNaImpressao3Test` com **tabela simulada de verdade** (4 casos, incl. 2ª via do mesmo título ainda deduplica e conta do corpo ainda é casada); mutante → 2 vermelhos |
| R1 | Gravação apagava a nota "Vencimento corrigido" do extrator | ✅ corrigido | `febraban.strip_due_date_notes(..., keep_corrected_to=)` preserva só a correção cujo destino é a data do registro; nota obsoleta segue saindo. Testes pelo call site extrator → gravação (`test_nota_do_vencimento_chega_ao_BANCO`, `test_nota_OBSOLETA_ainda_sai_na_gravacao`); mutante → vermelho |
| R2 | Badge `pagavel_descartado` sem teste | ✅ corrigido | Caso novo em `StatusBadge.test.tsx`; mutante (linha removida) → vermelho |

Gates após a correção: **pytest 1825** (+6) · **lint exit 0** · **paridade 32/32** (manifesto regravado: `read_emails.py` e `febraban.py`) · Vitest `StatusBadge.test.tsx` **14 passed** · **3 mutantes, 3 vermelhos**, todos revertidos e confirmados
Baseline (Passo 3):  pytest 1819 · lint exit 0 · paridade 32/32

Re-review do diff da correção: **sem achado novo**. Conferido: os dois callers do extrator mantêm a assinatura (parâmetro com default); a grafia antiga `->` é reconhecida; nenhum arquivo fora do previsto mudou. ⚠️ Risco residual de **deploy**: `read_emails.py` novo com `febraban.py` antigo levanta `TypeError` na gravação — os dois vão **juntos** (o manifesto já trava isso).

Não corrigido por decisão sua:
- **Drift** em `docs/knowledge/pipeline-extracao.md` (180 × 60 dias; dead-man switch "nas três regras") — o review não sincroniza doc.
- 🔵 Opcionais (ordem da isenção em `_has_own_bank_title`, filtro de `/erros`, comentário da 146).
- **Pendência de ambiente:** cópia para `C:\Sheild\API\Pagamentos` é manual e é sua.

Nada foi commitado.
