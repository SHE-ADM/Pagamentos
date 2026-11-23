# Code Review — Features / regra ALURA (2026-11-23)

## Resumo
Alvo: ALURA (docs/knowledge/pipeline-extracao.md § "Regra ALURA — e-mail mensal com NF de produto + NF de serviço")
Modo: max (ataque + adversarial)
Delta: 4 arquivos alterados, 2 novos, +365/−8 linhas (tracked) + 667 linhas novas (alura_fiscal.py 231, test_alura_fiscal.py 436)
Régua: CLAUDE.md (global, workspace, projeto), docs/knowledge/pipeline-extracao.md, skills pipeline-extracao/deploy-producao
Gates: pytest 2151 passed · check_deploy_parity 33/33 · ruff (não é gate do projeto; 93 apontamentos, incl. 1 RUF059 no teste novo) · vulture ≥80% sem saída · lint/typecheck JS: não executados (diff sem TS)
Verificação adversarial: 2 contestações; 1 confirmado, 1 enfraquecido, 0 refutados
Revisados por inteiro: alura_fiscal.py, diff de read_emails.py, diff dos docs e do manifesto. Medidos: dedup e cadastro contra o banco real (leitura), 8 mutantes, métodos de consulta com urlopen simulado. Veredito geral: implementação sólida; duas lacunas de teste, nenhum defeito de comportamento encontrado.

## Achados

### 🔴 Bloqueantes
Nenhum

### 🟡 Recomendados
- [skills/email-reader/scripts/read_emails.py:1520] O invariante FAIL-CLOSED de `find_account_by_document` não é travado por nenhum teste [verificado]
  Falha:     troca do `raise RuntimeError` final por `return None` → suíte inteira verde; numa falha de rede o e-mail duplicado (2 envios em 2 s, message_ids distintos) grava as contas pagas duas vezes — o UNIQUE de `gmail_message_id` não as une.
  Evidência: mutante M5 sobreviveu; o fake de `tests/test_alura_fiscal.py:218` levanta por conta própria. Medido com urlopen simulado: o método real levanta hoje (correto), e a consulta devolve 2610/2611 no banco real.
  Correção:  teste que executa o método REAL de `SupabaseControl` com urlopen simulado (falha → RuntimeError; resposta vazia → None; URL contém o `in.(...)`).
  Regra:     CLAUDE.md "Teste que promete uma garantia tem de entregá-la".
  Veredito:  CONFIRMADO

### 🔵 Opcionais
- [read_emails.py:8607] `pure_nfe=... and not alura_handled` sem teste (mutante M4 sobrevive; assunto real "ENC: Fatura Alura" não aciona `pure_nfe`) [verificado, rebaixado] — Veredito: ENFRAQUECIDO (só rótulo `ignorado` × `duplicidade`, caminho hipotético).
- [read_emails.py:~7920] `find_supplier_by_cnpj` devolve None tanto para "não cadastrado" quanto para falha de rede; a regra registra "fornecedor ALURA não encontrado" e marca `falha` — motivo enganoso num soluço do Supabase.
- [tests/test_alura_fiscal.py:430] variável `ctrl` não usada (RUF059).

## Resolução (Passo 8, 2026-11-23)
- R1 ✅ `FindAccountByDocumentTest` (3 testes); mutante M5 vermelho.
- O1 ✅ `test_reenvio_com_assunto_de_nfe_pura_tambem_vira_duplicidade` (assunto "ENC: NF-e Alura"); mutante M4 (remover `and not alura_handled` de `pure_nfe`) vermelho, arquivo restaurado.
- O2 ✅ só a mensagem de `/erros`: "não confirmado no cadastro (por CNPJ): não cadastrado ou consulta indisponível". O contrato `None` não mudou (documentado e deliberado); manifesto regravado.
- O3 ✅ `ctrl` não usado removido do teste.
- Gates após a correção: pytest 2155 passed (baseline 2151), paridade 33/33.

## Pendências (trabalho incompleto)
Nenhuma (varredura TODO/FIXME/stub sem ocorrência; testes presentes — 33).

## Drift código × documentação
Nenhum observado: o doc cita 33 testes (confere) e manifesto em paridade. A alegação "10 mutantes validados" não foi reconstituída (ver Não coberto).

## Não coberto
- Mutantes: reexecutei 8 próprios (6 vermelhos, 2 sobreviventes = achados acima); os 10 do doc não foram reconstituídos.
- NFS-e real da prefeitura e DANFE real: não buscados (rede externa); coberto só por fixtures.
- Gates JS e e2e: fora do delta.
- `register_attachment` lançando exceção após `register_financial` bem-sucedido (conta gravada, nota contada como problema): não exercido.
