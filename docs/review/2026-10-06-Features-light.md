# Code Review — Features (2026-10-06)

## Resumo
Alvo: nenhum (review do diff completo)
Modo: light (sem passo de ataque, sem verificação adversarial)
Delta: 8 arquivos alterados, 1 novo (`tests/test_browser_print_guia.py`, 210 linhas), +258/−27 linhas
Régua: CLAUDE.md · .claude/skills/pipeline-extracao · .claude/skills/testes-e-gates · docs/knowledge/pipeline-extracao.md
Gates: pytest 1956 passed · vulture 9 avisos, todos falsos positivos já conhecidos (rotas Flask, reexports de `febraban`), 0 em `extract_pdf.py` · ruff não é gate do projeto (o passivo de 38 avisos em `extract_pdf.py` é anterior ao delta) · npm test/lint/typecheck não executados (o delta não toca TS)
Revisado: correção do vencimento da guia DAMSP impressa pelo navegador (conta 1863) — moldura do navegador fora da medição de texto, tier 2b por vencimento, descarte e releitura do código de arrecadação no Vision — mais a documentação e o manifesto. Veredito: a correção está certa e travada por teste (5 mutantes vermelhos). Há 1 achado recomendado: o tier 2b dispara em excesso.

## Achados

### 🔴 Bloqueantes
Nenhum

### 🟡 Recomendados
- [skills/pdf-contas-pagar/scripts/extract_pdf.py:2086] O tier 2b decide pela marca `DUE_DATE_ABSENT_NOTE`, mas a marca SOBREVIVE quando o próprio texto depois corrige a data (`apply_text_due_date` / `apply_arrecadacao_deadline` não a retiram).
  Falha:     GNRE digital: o modelo não devolve `due_date`, `ensure_due_date` grava "hoje" com a marca e o regex da data-limite corrige para 31/07. A marca continua, o motivo vira "vencimento" e um Vision pago é chamado sem necessidade. O registro de texto, que estava correto, é trocado pelo do Vision.
  Evidência: execução de `build_records` com texto de GNRE e "Documento Válido para pagamento 31/07/2026" → `due_date=2026-07-31`, notas "Vencimento ausente … | … data-limite da guia de arrecadação: 2026-10-06 → 2026-07-31", `_text_read_incomplete` → "vencimento".
  Correção:  o tier 2b exige também que o TEXTO não tenha data determinística (`extract_due_date_from_text` e `extract_payment_deadline_from_text` nulos sobre `doc_text`).
  Regra:     CLAUDE.md § Chat de IA / custo e skill pipeline-extracao — chamada paga só quando o texto não respondeu; "texto disponível VENCE o campo do modelo".

### 🔵 Opcionais
- [extract_pdf.py:1162] O 3º padrão de moldura (`^\d+\s*/\s*\d+$`) também casa uma linha isolada de competência ("09/2026"). Afeta só a medição, e na direção segura (no máximo empurra o PDF para o Vision).
- [extract_pdf.py:1716] O descarte de arrecadação refutada passa a valer também em `image_vision`/`docx_vision`, sem a releitura (`_try_barcode_vision` só aceita PDF). É coerente com a política do bancário, mas essas contas passam a nascer sem o código.
- [extract_pdf.py:1550] A marca "Vencimento ausente" fica obsoleta nas observações quando o texto corrige a data depois. É anterior ao delta, mas aparece na coluna "Observações".

## Pendências (trabalho incompleto)
- [produção] Copiar `extract_pdf.py` + `scheduler/deploy-manifest.json` e conferir com `check_deploy_parity.py` — recomendada (feito pelo usuário)
- [banco] Conta 1863: vencimento 05/10 → 13/10, corrigido manualmente pelo usuário no app — recomendada
- [git] Nada commitado — opcional (decisão do usuário)

## Drift código × documentação
Nenhum — CLAUDE.md, a skill, docs/knowledge e progress.md foram atualizados no mesmo delta e descrevem o comportamento implementado.

## Não coberto
- `docs/deploy/historico-deploys.md` e `pagamentos.code-workspace`: alterações do usuário anteriores a esta tarefa. Lidas, mas sem régua de conteúdo além da coerência com o `git log` (PR #261/#262 conferem).
- Camada e2e/Playwright e suítes Node: não executadas, porque o delta não as toca.
- O comportamento real do Vision em outros formatos de impressão (Firefox, Safari) não foi medido; ficam cobertos só pelo tier 2b.

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| R1 | Tier 2b disparava com a marca "Vencimento ausente" obsoleta | ✅ corrigido | `extract_pdf.py` `_text_read_incomplete(rec, doc_text)`: exige também texto sem data determinística (`extract_due_date_from_text` e `extract_payment_deadline_from_text` nulos). Teste `test_guia_DIGITAL_com_data_limite_no_texto_nao_chama_o_vision`; mutante (remover a condição) → vermelho, revertido e conferido. Manifesto regravado. |

Gates após a correção: pytest 1957 (+1) · vulture 9 (os mesmos falsos positivos)
Baseline (Passo 3):    pytest 1956 · vulture 9
Re-review do diff da correção: sem achado novo. Efeito conservador declarado: data impressa no texto, porém implausível (anterior à emissão), não aciona o tier 2b — a conta segue com a data presumida e a marca, como antes do delta.

Não corrigido por decisão sua:
- Drift criado pela própria correção: `.claude/skills/pipeline-extracao/SKILL.md`, `docs/knowledge/pipeline-extracao.md` e `CLAUDE.md` descrevem o gatilho do tier 2b como "guia de arrecadação com vencimento PRESUMIDO", sem a condição nova de "texto sem data determinística". O rito não sincroniza a documentação durante a correção.
- Opcionais O1–O3.
Nada foi commitado.

## Opcionais aplicados (pedido do usuário, 2026-10-06)

| # | Melhoria | Desfecho | Observação |
|---|---|---|---|
| O1 | Contador de página casava "09/2026" | ✅ aplicado | `_is_browser_print_chrome_line`: "N/M" só com até 3 dígitos e 1 ≤ N ≤ M (também na linha da URL). |
| O2 | Arrecadação descartada sem releitura em imagem/.docx | ✅ aplicado | `_try_barcode_vision` monta o bloco por `_vision_source_block` (PDF ou imagem; .docx segue recusado). Releitura ligada em `_extract_image` e `_extract_docx`, aqui ainda com o temporário existindo. |
| O3 | Marca "Vencimento ausente" obsoleta | ✅ aplicado | `_drop_absent_due_date_note` nos 3 pontos que trocam a data presumida por uma lida (fator, rótulo "Vencimento", data-limite da guia). A trava por `doc_text` do R1 continua, como segunda barreira. |
| — | Complexidade cognitiva de `_extract_records` (SonarLint 24 > 15) | ✅ reduzida | Tier 2 extraído para `_tier2_vision`, sem mudança de comportamento. |

Mutantes: 7 de 7 vermelhos (O1, O2 ×3, O3 ×3), arquivo restaurado e conferido.
Gates: pytest 1964 (+7 sobre 1957) · vulture 9 (os mesmos) · manifesto regravado.
Ponta a ponta: PDF real da 1863 → `pdf_vision`, 2026-10-13, R$ 79,66, código idêntico ao gravado e sem notas.
Nada foi commitado.
