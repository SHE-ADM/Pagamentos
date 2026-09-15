# Code Review — Features, working tree, robustez (2026-09-15)

## Resumo
Alvo: robustez de código (`docs/padrao-execucao.md` § Critérios obrigatórios de aceite; § Padrões específicos da stack — Python)
Modo: light (sem passo de ataque, sem verificação adversarial)
Delta: 10 arquivos alterados (+419/−34) e 6 novos (1.439 linhas: migrations 138/139/140 e 3 testes). O relatório anterior, `docs/review/2026-09-15-Features-light.md`, ficou fora do delta. EOL conferido.
Régua: `docs/padrao-execucao.md`, `CLAUDE.md` do projeto (Regras 2 e 5, Pipeline de extração), skill `pipeline-extracao`
Gates: pytest 1733 passed · ruff (sem gate de CI; comparado com o HEAD): `read_emails.py` 83→82, `reprocess_body_emails.py` 5→5, `reprocess_beneficiario_final.py` 8→8, `test_reprocess_body_dry_run.py` 3 (novo), demais testes novos 0 · vulture completo (`server/ skills/ scripts/ --min-confidence 60`): 7 falsos positivos das rotas Flask já documentados · `check_deploy_parity.py` 32/32 · npm test/lint/typecheck **não executados** (delta sem TS/JS)

Este review segue o primeiro do dia e cobre as correções feitas depois dele: R1 (`http.client.HTTPException`), R2 (dry-run de `reprocess_body_emails.py`), o drift do `None` com Supabase indisponível no CLAUDE.md e no SKILL.md, a confirmação das migrations e a reprodução da medição.

A robustez defensiva está boa. Os três desfechos de `resolve_supplier` são explícitos; há timeout e retry com backoff; `log.exception` é usado nos caminhos de falha; nenhum `except` vazio foi introduzido; os testes executam o fluxo real e foram validados por mutante. Sobrou uma lacuna de validação de faixa nos parâmetros de ambiente novos.

**Estado do banco confirmado (somente leitura, `BEGIN READ ONLY`):**
- **138:** as definições vivas de `resolve_supplier_id` e `_enrich_supplier_name` são idênticas ao arquivo (whitespace colapsado); só `service_role` executa; colunas com 60.
- **139:** A1, A2, B1 = 0 e B2 = 2 conferem.
- **140:** P1 13/13; P2 = 0, com sanidade (CNPJ de `company` só com dígitos, então o oráculo não era vazio); 1400/1415 removidos e sem conta; sk 4 ativo.
- Nenhuma guia de tributo gravada desde 15/09 fora do sk 1.

## Achados

### 🔴 Bloqueantes
Nenhum

### 🟡 Recomendados

- [skills/email-reader/scripts/read_emails.py:421] `SUPPLIER_RPC_ATTEMPTS` e `SUPPLIER_RPC_BACKOFF` vêm do ambiente sem validação de faixa.
  Falha:     `SUPPLIER_RPC_BACKOFF=-1` no `.env` → na 1ª falha transitória, `time.sleep(-1.5)` levanta `ValueError` fora de qualquer `except` do laço → o erro escapa como `ValueError` (não `SupplierResolutionError`) e derruba o e-mail inteiro no `except` genérico de `process_message`. `SUPPLIER_RPC_ATTEMPTS=0` → o laço não roda e toda conta vai a `/erros` com "falhou: None", sem nenhuma chamada à RPC.
  Evidência: linhas 421-422, `int(os.getenv(...))`/`float(os.getenv(...))` sem limite; `time.sleep` com valor negativo levanta `ValueError: sleep length must be non-negative`.
  Correção:  `max(1, …)` nas tentativas e `max(0.0, …)` no backoff, com teste.
  Regra:     `docs/padrao-execucao.md` § Critérios de aceite ("validar parâmetros de entrada e contratos (… faixa …)").

### 🔵 Opcionais
- [read_emails.py:1131] 408 e 429 são transitórios, mas caem no ramo "4xx definitivo". A doc descreve "4xx definitivo não re-tenta"; mudar isso exige ajustar a doc.
- [read_emails.py:421] Valor não numérico em `SUPPLIER_RPC_ATTEMPTS` quebra o import do reader. É o mesmo padrão preexistente de `DUP_QUERY_ATTEMPTS`.
- [tests/test_reprocess_body_dry_run.py:27,77] ruff: `noqa` sem uso e `return None` redundante (os testes irmãos estão limpos).
- [scripts/reprocess_body_emails.py:136] `ec['subject'][:55]` com assunto NULL levanta `TypeError`; o mesmo padrão já existe nas linhas 109 e 115.
- [tests/test_supplier_contribuinte_guia.py:180] O teste de degradação sem marca não verifica `ctrl.payloads == []`.

## Pendências (trabalho incompleto)
- [read_emails.py + deploy-manifest.json] Deploy manual em produção pendente; o arquivo mudou de novo com o R1. — recomendada (depende do usuário)
- Marcadores TODO/FIXME/HACK/XXX/WIP, stubs e testes pulados: nenhum.

## Drift código × documentação
- Comentário de `CONTRIBUINTE_NAME_SIMILARITY` (`read_emails.py`, "variantes reais do contribuinte ficam em 0,88-1,00") e `docs/knowledge/pipeline-extracao.md` ("as variantes do contribuinte começam em 0,88") × a medição reproduzida hoje. Os nomes com marca de pagadora ficam em 1,000 / 1,000 / 0,963 / **0,809 ("CONFECCOES OTIMOTEX", sk 1227)** / 0,615 / 0,571. Os outros dois números **conferem**: sem marca, o máximo é 0,703 (DEXINGLONG PLASTICS); entre os favorecidos de guia, 0,453 (Governo do Estado de SP - SEFAZ), e os 10 favorecidos dão `contribuinte=False`. A conclusão se mantém (os nomes abaixo de 0,85 são pegos pela marca), mas o "0,88" não se reproduz. — decisão pendente do usuário

## Não coberto
- **sk 1227 "CONFECCOES OTIMOTEX"** (ativo, sem CNPJ, plano 12/631) tem a conta **933** (boleto, R$ 12.364,34, venc. 24/08/2026). É um possível cadastro-apelido da pagadora fora de guia de tributo, caso que a 140 não cobre. É dado e está fora do delta; precisa de conferência sua.
- Passo de ataque e verificação adversarial (modo light).
- Gates npm não executados.
- `read_emails.py` foi lido nos hunks e nas funções tocadas, não por inteiro.

---

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| R1 | Faixa de `SUPPLIER_RPC_ATTEMPTS`/`BACKOFF` não validada | ✅ corrigido | `read_emails.py` (`resolve_supplier`): `attempts = max(1, …)` e `backoff = max(0.0, …)` validados no uso. Teste novo `test_parametros_fora_da_faixa_nao_pulam_a_rpc_nem_dormem_negativo`: verde com a correção e **vermelho com cada um dos dois mutantes** (arquivo restaurado e conferido por `diff -q`). Manifesto regravado, paridade 32/32 |

Gates após a correção: pytest 1734 (+1) · ruff `read_emails.py` 82 (=) e `test_supplier_rpc_failure.py` 0 · paridade 32/32 · EOL ok
Baseline (Passo 3):    pytest 1733 · ruff 82 · paridade 32/32
Re-review do diff da correção: sem achado novo. As duas constantes têm um só consumidor (`resolve_supplier`); a mensagem do erro e o contrato não mudaram. ⚠️ **O diff não foi congelado antes das edições** (correcao.md, item 1); a correção foi isolada pelo hunk de `resolve_supplier` (`git diff HEAD -- read_emails.py`), que só contém as linhas descritas acima.

Não corrigido por decisão sua: drift do "0,88" (comentário + `docs/knowledge`), sk 1227 / conta 933, os 5 opcionais, o deploy manual.
Nada foi commitado.
