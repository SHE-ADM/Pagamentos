# Code Review — Features (2026-10-17)

## Resumo
Alvo: nenhum (review do diff completo)
Modo: light (sem passo de ataque, sem verificação adversarial)
Delta: 5 arquivos alterados, 0 novos, +36/−4 linhas (antes da correção)
Régua: CLAUDE.md (workspace + projeto), docs/knowledge/pipeline-extracao.md
Gates: pytest 1965 · check_deploy_parity OK (32/32) · lint/typecheck TS: não executados (diff só toca Python, Markdown e settings do VS Code)
Revisado: tier 2b do extract_pdf (guia de tributo sem código entra no Vision por vencimento presumido), teste, manifesto, doc e settings do VS Code. Lógica correta e estreita; o manifesto confere com o hash atual.

## Achados

### 🔴 Bloqueantes
Nenhum

### 🟡 Recomendados
- [tests/test_browser_print_guia.py:303] O teste novo só exercita a função pura `_text_read_incomplete`; o call site `_extract_records → _tier2_vision` não era executado para o caso tributo sem barcode.
  Falha:     alguém remove a chamada do tier 2 para esse caminho, ou o `_vision_recovers` rejeita o registro → o teste puro continua verde e a conta FGTS volta a gravar vencimento = data da extração.
  Evidência: diff do teste (só chama `E._text_read_incomplete`); regra do CLAUDE.md §2 "testar a função PURA não cobre o CALL SITE".
  Correção:  caso que executa `_extract_records` com tributo sem barcode e confere o Vision chamado e a data adotada.
  Regra:     CLAUDE.md §2 (Todo componente tem teste).

### 🔵 Opcionais
- [.vscode/settings.json:16] Mudança de ambiente do VS Code não relacionada ao pipeline; deve entrar em commit próprio `chore(workspace)` (memória: code-workspace sem aviso).
- [extract_pdf.py:2139] Tributo sem barcode e sem data em NENHUM lugar (guia legitimamente sem vencimento) passa a gastar uma chamada Vision a cada leitura; `_vision_recovers` evita a troca indevida, mas o custo existe. Aceito pela doc ("só tributo").

## Pendências (trabalho incompleto)
Nenhum (sem TODO/FIXME/stub no delta).

## Drift código × documentação
Nenhum. A nota nova em docs/knowledge/pipeline-extracao.md descreve o comportamento do código.

## Não coberto
- Comportamento real com o PDF do FGTS Digital (conta 2034): só mocks; exige o PDF e a Claude API.
- Gates TS (lint/typecheck/vitest): não executados, o delta não os toca.
- Produção: o manifesto já bate com o repositório de desenvolvimento; a cópia para C:\Sheild\API\Pagamentos é manual do usuário.

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| R1 | Teste só da função pura, sem call site | ✅ corrigido | `test_tributo_sem_codigo_executa_o_vision_pela_funcao_de_topo` executa `_extract_records`; mutante (remover `tax_guide_without_code`) deixa os 2 testes de tributo vermelhos; revertido e confirmado |
| O1 | `.vscode/settings.json` fora do escopo | ⏸️ adiado | exige commit próprio `chore(workspace)`; escrita em git só com pedido explícito |
| O2 | Custo de 1 chamada Vision por tributo sem data | ⏸️ adiado | decisão de negócio já registrada na doc ("só tributo"); a leitura ocorre uma vez por e-mail (dedup por message_id) |

Não coberto, tratado depois do relatório:
- Gates TS: `npm run lint` exit 0 · `npm run typecheck` exit 0 (antes "não executados").
- PDF real (cache local, sem chamar a API paga): `eunice_PAGAMENTO_FGTS_SOBRE_FOLHA_20261016` → texto 7389 chars, nenhuma data determinística, tier 2b dispara ("vencimento"). `eunice_pagamento_FGTS_20260716` → texto traz 2026-07-20, tier 2b NÃO dispara.
- Ainda não coberto: a resposta real do Vision para a guia (custo de API) e a cópia para produção (manual do usuário).

Gates após a correção: pytest 1966 (+1) · check_deploy_parity OK · lint 0 · typecheck OK
Re-review do diff da correção: sem achado novo.
Nada foi commitado.
