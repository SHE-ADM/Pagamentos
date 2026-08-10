# Code Review — Features (2026-08-08)

## Resumo

**Alvo:** nenhum (review do diff completo)
**Modo:** light (sem passo de ataque, sem verificação adversarial)
**Delta:** 9 arquivos alterados, 3 novos, +392/−62 (versionado) + 411 linhas nos testes novos
**Régua:** `CLAUDE.md` (projeto) · `docs/padrao-execucao.md` · `C:\Sheild\Projetos\Claude\CLAUDE.md` (workspace) · `~/.claude/CLAUDE.md` (global)
**Gates:** `pytest 1141 passed` · `vulture 9 achados (7 FP conhecidos + 2 NOVOS)` · `npm test`: portal-next 2 OK; **frontend-vite 840 passed** em série (`--maxWorkers=1`) — a 1 falha do run paralelo era o flake de sandbox já documentado em `vitest-worker-crash-sandbox`, e o delta não toca `apps/` · `npm run lint`/`typecheck`: não executados — o delta não contém TS/JS · e2e a11y: não executado (crasha no sandbox do agente, por decisão documentada no `CLAUDE.md`)

O delta entrega três correções reais e bem instrumentadas do pipeline de extração: leitura Vision
multi-boleto (carnê escaneado), descarte de código de barras corrompido pelo OCR e detecção de
assinatura de e-mail pelo conteúdo. As três vêm com teste, medição e o "porquê" registrado. O
**defeito central deste review é de escopo da 1ª correção**: o `EXTRACTION_PROMPT` é
**compartilhado pelos dois caminhos** e passou a pedir ARRAY, mas apenas o caminho `pdf_vision`
foi ensinado a consumir array — no `pdf_text` a resposta correta do modelo é descartada por
`AttributeError` e substituída por uma extração de regex marcada como **sucesso**, com perda
silenciosa dos demais pagáveis. É exatamente a classe de falha que o próprio delta existe para
eliminar, reintroduzida pela outra porta.

---

## Achados

### 🔴 Bloqueantes

- **[skills/pdf-contas-pagar/scripts/extract_pdf.py:1258]** O novo prompt pede ARRAY para os DOIS
  caminhos, mas só o `pdf_vision` consome array; no `pdf_text` a resposta correta vira uma conta
  de regex marcada como sucesso.
  **Falha:** PDF de TEXTO com ≥2 pagáveis que `_payable_pages` não separou (caso real já
  documentado no `CLAUDE.md`: carnê HYOSUNG id 473/474, linha digitável quebrada em 3 linhas) →
  o modelo obedece a nova instrução e devolve `[{...},{...}]` → `build_record_from_json` recebe
  `list` → `AttributeError: 'list' object has no attribute 'get'` → o `except Exception` genérico
  cai no **fallback regex** → 1 registro com `supplier_name=None` e valor do regex,
  `extraction_source='pdf_text'` (= sucesso). Os N−1 pagáveis restantes somem sem erro e sem log
  de perda; o 1º sai corrompido.
  **Evidência:** sonda executada contra o código atual —
  `Extração via Claude (texto) falhou ('list' object has no attribute 'get') — fallback regex` /
  `n registros = 1` / `supplier_name = None` / `amount = 1.0` / `extraction_source = pdf_text`.
  `build_records` linha 1258 é `return [_build_record_text(...)]` — hardcoded em 1 registro.
  **Correção:** normalizar o payload do texto com `_json_records` também; com ≥2 itens (que o
  split por página não separou) devolver `_failure_record` explícito em vez do regex silencioso —
  gravar os N ali daria a **todos** o barcode do primeiro (`extract_linha_digitavel(raw)` é do
  documento inteiro), o que os faria colidir na dedup e sumir.
  **Regra:** `CLAUDE.md` § "Resposta do modelo TRUNCADA nunca vira dado" (🔴) e o comentário do
  próprio `_build_record_text`: *"o fallback regex gravaria fornecedor vazio e valor errado como
  sucesso"*.

### 🟡 Recomendados

- **[skills/pdf-contas-pagar/scripts/extract_pdf.py:1270-1277]** Truncagem no caminho `pdf_text`
  também degrada para regex — o invariante "resposta truncada NUNCA vira dado" só vale no Vision.
  **Falha:** `extract_fields_with_claude` → `_response_text` levanta `VisionTruncatedError`, que é
  capturada pelo `except Exception` genérico → `log.warning(... fallback regex)` → conta criada
  com dados de regex e `extraction_source='pdf_text'`. Alcance estreito (teto de 8000 tokens sobre
  `text[:12000]`), mas o desfecho é uma conta errada gravada como sucesso.
  **Evidência:** sonda — resposta com `stop_reason='max_tokens'` produziu
  `extraction_source = pdf_text`, `amount = 10.0`, notas *"Extração por regex (fallback)"*.
  **Correção:** capturar `VisionTruncatedError` **antes** do `except Exception` e devolver
  `_failure_record` (mesmo tratamento do caminho Vision).
  **Regra:** `CLAUDE.md` § "Resposta do modelo TRUNCADA nunca vira dado".

- **[skills/pdf-contas-pagar/scripts/extract_pdf.py:110-126]** `_is_api_unavailable` classifica
  `VisionTruncatedError` por **substring do nome do arquivo**, e o teste que promete o contrário
  observa só a string, não a classe.
  **Falha:** o nome do PDF entra na mensagem da exceção (`f"Vision ({Path(pdf_path).name})"`) e a
  heurística `_API_ERROR_HINTS` casa por substring. Um arquivo `Quota_Condominial.pdf`,
  `Permissionaria_ABC.pdf` ou `Billing_2026.pdf` cuja resposta trunque → `_is_api_unavailable` =
  True → `_api_error_record` → **circuit breaker** interrompe os demais pagáveis do PDF e o e-mail
  é logado como "API Anthropic indisponível" — diagnóstico errado, sem nada que denuncie a troca.
  **Evidência:** sonda — `Quota_Condominial.pdf → True`, `Permissionaria_ABC.pdf → True`,
  `Billing_2026.pdf → True`, `boleto.pdf → False`.
  `tests/test_vision_multi_boleto.py:66` (`test_truncada_NAO_e_confundida_com_api_indisponivel`)
  passa porque afirma sobre **uma mensagem literal** com o nome `carne.pdf`; a garantia que o nome
  do teste promete ("a truncagem nunca é confundida com API indisponível") é falsa.
  **Correção:** `if isinstance(exc, VisionTruncatedError): return False` no topo de
  `_is_api_unavailable`; e fazer o teste observar a **classe** com um nome de arquivo hostil.
  **Regra:** `CLAUDE.md` Regra mandatória 2 — *"Teste que promete uma garantia tem de entregá-la"*.

- **[skills/pdf-contas-pagar/scripts/extract_pdf.py:1261 e :1566]** Os wrappers `build_record` e
  `_extract_single` ficaram **sem consumidor de produção** — regressão do gate `vulture`.
  **Falha:** antes do delta os dois eram chamados por `process_pdf`/`_extract_image`; agora só por
  testes. `vulture` passou de **7 falsos positivos conhecidos** (rotas Flask) para **9 entradas**,
  erodindo o gate que o `CLAUDE.md` documenta. Pior: `_extract_single` devolve `recs[0]` — qualquer
  chamador futuro descarta os pagáveis 2..N em silêncio, que é o defeito que o delta corrige.
  **Evidência:** `py -3 -m vulture skills/ scripts/ server/ --min-confidence 60` →
  `extract_pdf.py:1261: unused function 'build_record'` ·
  `extract_pdf.py:1566: unused function '_extract_single'`.
  **Correção:** remover os dois e apontar os 3 call sites de teste para `build_records` /
  `_extract_records`.
  **Regra:** memória `no-dead-code` — *"não manter código antigo/morto; remover a versão antiga ao
  trocar lógica"*; `CLAUDE.md` § "Lint limpo e análise estática" (vulture).

- **[tests/test_mirrored_pdf_text.py:81]** O mock de isolamento do teste ficou **morto**: ele
  patcheia `E.build_record`, que o código sob teste não chama mais.
  **Falha:** `_extract_records` chama `build_records`; o `patch.object(E, "build_record", ...)` não
  tem efeito, então o teste passou a exercitar o extrator REAL. `test_texto_normal_nao_chama_vision`
  (que exige `vision.call_count == 0`) só continua verde porque o fixture `NORMAL` contém
  `"Valor do Documento R$ 133,94"` e o regex acha o valor; um texto sem valor dispara o fallback
  tier-2 e a Vision é chamada.
  **Evidência:** sonda — `build_record (mock) chamado: False` · `build_records REAL chamado: True`
  · com texto sem valor legível, `vision chamado: 1`.
  **Correção:** trocar o patch para `build_records` (retornando `[{...}]`).
  **Regra:** `CLAUDE.md` Regra mandatória 2, item "validação por mutante".

- **[docs/deploy/historico-deploys.md:36]** Fragmento órfão do título antigo deixado no meio do
  arquivo.
  **Falha:** a troca de `# Histórico de deploys do pipeline Python (produção)` por
  `# Histórico de deploys` + a nova seção deixou a linha solta ` do pipeline Python (produção)`
  logo acima do parágrafo de introdução, entre o `---` e o texto.
  **Evidência:** `sed -n '36p'` devolve ` do pipeline Python (produção)`.
  **Correção:** remover a linha órfã.

### 🔵 Opcionais

- [skills/pdf-contas-pagar/scripts/extract_pdf.py:1005] `_json_records` descarta elementos
  não-`dict` do array silenciosamente; e um envelope `{"documentos":[...]}` vira 1 registro vazio
  → `sem_valor`, o mesmo modo de falha que o delta combate (degrada ao comportamento antigo, não
  regride).
- [skills/pdf-contas-pagar/scripts/extract_pdf.py:1541] A guarda `len(recs) == 1` do fallback
  tier-2 é sempre verdadeira no ramo `pdf_text` (defensiva, inócua).
- [skills/email-reader/scripts/read_emails.py:4706] `_is_contact_block` reexecuta
  `_strip_accents_lower` sobre a descrição que `_is_nonpayable_visual` já normalizou na linha
  acima.

---

## Pendências (trabalho incompleto)

Nenhuma. A varredura por marcadores (`TODO|FIXME|HACK|XXX|WIP|@todo|@pendente|todo:`), stubs
(`NotImplementedError`, corpo vazio), testes pulados (`@skip`/`it.skip`) e blocos de debug
(`print(`) voltou **vazia** no diff versionado e nos 3 arquivos novos.

---

## Drift código × documentação

- **18 × 19 barcodes corrompidos.** `CLAUDE.md:2009`, `CLAUDE.md:2288` e
  `docs/deploy/historico-deploys.md:14` dizem **18 corrompidos**; `febraban.py:374`
  (*"isto refuta 19"*) e `tests/test_barcode_self_refuted.py:10` (*"19 corrompidos"*) dizem **19**.
  A aritmética da própria auditoria fecha com 19 (349 + 68 + **19** + 6 = **442**) e não com 18
  (= 441). Qual lado é o correto é decisão sua — **não sincronizado**.
- **`CLAUDE.md`** descreve *"`build_records` aceita ARRAY → N registros"* sem escopar ao caminho
  Vision; o caminho `pdf_text` **não** aceita (achado 🔴 acima). A doc descreve o estado desejado,
  o código entrega metade dele. **Não sincronizado** — a correção pertence ao código.

---

## Não coberto

- **`npm run lint` e `npm run typecheck`** não executados: o delta não contém nenhum arquivo
  `.ts`/`.tsx`/`.js` (`git diff --name-only | grep '^apps/'` = 0), então os gates não podem
  regredir por causa dele.
- **A falha única do `frontend-vite`** no `npm test` paralelo não teve a identidade do caso
  extraída (a saída capturada trouxe só o rodapé). A re-execução em série (`--maxWorkers=1`),
  recomendada pelo `CLAUDE.md` para distinguir flake de sandbox de regressão real, devolveu
  **143 arquivos / 840 testes, todos passando** — logo era flake de ambiente. Ainda assim, *qual*
  caso caiu no run paralelo não foi identificado.
- **Camada a11y em navegador (Playwright + axe)** não executada — o `CLAUDE.md` registra que ela
  crasha no sandbox do agente; validação é no CI/máquina do usuário.
- **Nenhuma chamada real à Claude API** foi feita. A frequência com que o modelo passará a
  responder ARRAY no caminho `pdf_text` sob o novo prompt é **inferida do texto do prompt**, não
  medida — o mecanismo do defeito 🔴 está provado por sonda, a taxa de ocorrência não.
- **Produção não verificável daqui.** `CLAUDE.md:2288` e `historico-deploys.md` declaram deploy em
  2026-08-07; `check_deploy_parity.py` só roda na máquina de produção, que fica em outro local
  físico. O manifesto local **confere** com os 3 arquivos (SHA-256 recalculado).
- **`CLAUDE.md` lido apenas na parte alterada** (diff de 81 linhas), não integralmente.

---

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| B1 | Prompt pede ARRAY nos dois caminhos, mas só o Vision consome — `pdf_text` perdia N−1 pagáveis e gravava conta de regex como sucesso | ✅ corrigido | `extract_pdf.py:1267` (`_build_record_text` → `_build_records_text`, normaliza com `_json_records`; ≥2 itens → `_failure_record`). Trava: `CaminhoTextoTest.test_array_no_texto_vira_falha_e_NAO_conta_de_regex`. Mutante `itens = [data]` → 2 vermelhos |
| R1 | Truncagem no `pdf_text` degradava para regex (invariante "truncado nunca vira dado" só valia no Vision) | ✅ corrigido | `except VisionTruncatedError` **antes** do `except Exception`, no mesmo ponto. Trava: `test_truncagem_no_texto_vira_falha_e_NAO_conta_de_regex`. Mutante (remover o `except`) → vermelho |
| R2 | `_is_api_unavailable` classificava `VisionTruncatedError` por substring do NOME DO ARQUIVO → circuit breaker e diagnóstico errado | ✅ corrigido | `extract_pdf.py:114` (`isinstance` antes da heurística). O teste passou a varrer a **classe** com 4 nomes hostis (`Quota_`/`Permissionaria_`/`Billing_`). Mutante (remover a guarda) → vermelho |
| R3 | Wrappers `build_record` / `_extract_single` sem consumidor de produção — vulture de 7 FP para 9 entradas | ✅ corrigido | Removidos; 3 call sites de teste apontam para `build_records`/`_extract_records`. `vulture` de volta aos 7 FP de rota Flask |
| R4 | Mock morto em `test_mirrored_pdf_text.py` (patcheava `build_record`, código chama `build_records`) | ✅ corrigido | Patch trocado para `build_records`; o teste voltou a isolar o que promete em vez de exercitar o extrator real |
| R5 | Fragmento órfão do título antigo em `historico-deploys.md:36` | ✅ corrigido | Virou o cabeçalho `## Deploys anteriores do pipeline Python (produção)` |
| — | Drift 18 × 19 barcodes corrompidos (`CLAUDE.md` × `febraban.py`/teste) | ⏸️ adiado | Qual número está certo é decisão sua; sincronizar a doc apagaria a evidência da divergência |
| — | `CLAUDE.md` descreve "`build_records` aceita ARRAY" sem escopar ao Vision | ⏸️ adiado | Doc de estado não é alterada pelo review. Com B1 corrigido o `pdf_text` **detecta** o array, mas continua não gravando N contas — a frase segue precisando de ressalva |
| — | 3 achados 🔵 opcionais | ⏸️ adiado | Opcionais não entram na correção automática (inflariam o diff a ser re-revisado) |

**Gates após a correção:** `pytest 1146 (+5)` · `vulture 7 (= baseline, só rotas Flask)` · `frontend-vite 840` (inalterado — nenhum arquivo `apps/` tocado) · manifesto de deploy regravado e conferido contra o SHA-256 real
**Baseline (Passo 3):** `pytest 1141` · `vulture 9 (7 FP + 2 novos)` · `frontend-vite 840`

**Re-review do diff da correção — 1 achado novo, meu, corrigido em 2ª rodada:**
o teste `test_multi_pagavel_no_texto_e_RECUPERADO_pelo_tier2_vision` que eu havia acabado de
escrever **passava pelo motivo errado**: o fixture `"BOLETO 1 ... BOLETO 2 ..."` tem 25 caracteres
e `_extract_records` desvia textos com menos de 80 para o fallback "texto curto", que já chama o
Vision **antes** do caminho `pdf_text` — o tier-2 nunca era exercitado. Provado por mutante
(`return vrecs[:1]` sobrevivia). Corrigido com fixture de 158 chars, asserção de sanidade do
comprimento e `vision.call_count == 1`; o mesmo mutante agora fica vermelho. **A conclusão que eu
havia tirado da sonda viciada — "o caso é recuperado pelo tier-2" — foi re-verificada com texto
acima do limiar e se confirmou** (2 contas, `pdf_vision`), então o comentário no código que a
descreve está correto.

**Não corrigido por decisão sua:** os 2 itens de drift e os 3 opcionais acima.
**Nada foi commitado.** Todas as correções estão no working tree.

---

## Drift resolvido (2026-08-08, a pedido do usuário)

### 1. 18 × 19 barcodes corrompidos → **18**, e o erro estava no "6"

Resolvido por **medição no banco**, não por escolha. Método: rodar `barcode_self_refuted` sobre
**todos os barcodes vivos** e reconstruir a decomposição da auditoria.

| Medida | Valor |
|---|---|
| Contas totais hoje | **784** — igual à prova por hash pós-limpeza ⇒ nada entrou nem saiu desde então |
| Contas com barcode hoje | **424** |
| Ainda refutados pelo gate | **0** ⇒ a limpeza pegou o conjunto exato |
| Decomposição dos 424 | 349 consistentes · 68 não-boleto · **7** só-valor-diverge |
| Apagados | 442 − 424 = **18** |

Validação do modelo contra os ids que o próprio teste documenta: **915** (fixture `BOM`) ainda tem
barcode; **916–920, 926, 927** estão com `barcode` nulo — exatamente como a doc descreve.

**Conclusão:** `349 + 68 + 7 + 18 = 442`. O número errado não era o "19" isolado — era o **"6"**
de "só o valor diverge". Com ele, `349 + 68 + 19 + 6` também fechava em 442, e foi essa falsa
consistência que sustentou o "19" em `febraban.py` e no teste. **Isto corrige o que eu havia
escrito no relatório acima**, onde apontei a aritmética como favorável ao 19: ela era, mas apoiada
num segundo número errado.

Corrigidos: `febraban.py` (18 e 7, com a soma explícita) · `tests/test_barcode_self_refuted.py`
(com nota de por que o par antigo passava despercebido) · `CLAUDE.md:2009` e
`historico-deploys.md:14` (que estavam com o 18 certo, mas **omitiam a 4ª parcela** — era a
omissão que tornava o número inconferível).

### 2. `CLAUDE.md` sobre `build_records` aceitar ARRAY

Reescrito o item 3 do bloco "Resposta do modelo TRUNCADA nunca vira dado" para descrever o que o
código faz depois do fix: N registros **só no caminho visual**; no `pdf_text` o array é detectado
e vira `_failure_record`, que — sem `amount` — cai no fallback tier-2 e acaba recuperado pelo
Vision. Inclui o porquê de não gravar N no texto (o barcode do documento inteiro contaminaria
todos) e o ponteiro para `CaminhoTextoTest`.

**Referências obsoletas às funções removidas, corrigidas junto** (mesma família de drift):
`CLAUDE.md` ×4 (`_extract_single` → `_extract_records`; `build_record` → `_build_records_text` /
`build_records`, cada uma conferida contra o call site real via AST) e
`docs/knowledge/pipeline-extracao.md:1090`.

**Gates:** `pytest 1146` · `vulture 7 (só rotas Flask)` · `test_doc_links 4` · manifesto regravado
e conferido (o `febraban.py` mudou). **Nada foi commitado.**
