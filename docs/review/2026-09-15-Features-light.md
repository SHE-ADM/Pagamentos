# Code Review — Features, working tree (2026-09-15)

## Resumo
Alvo: nenhum (review do diff completo)
Modo: light (sem passo de ataque, sem verificação adversarial)
Delta: 9 arquivos alterados (+409/−33) e 5 novos (1.299 linhas: migrations 138/139/140 e 2 testes). EOL conferido: `--ignore-cr-at-eol` dá o mesmo stat.
Régua: `CLAUDE.md` do projeto (Regras 2 e 4, Pipeline de extração, Banco de dados), skill `pipeline-extracao`, `docs/padrao-execucao.md` (via CLAUDE.md global)
Gates: pytest 1729 passed · ruff: `read_emails.py` 83→82, `reprocess_beneficiario_final.py` 8→8, testes novos 0 (sem config de CI, comparado com o HEAD) · vulture nos 2 `.py` alterados: 2 falsos positivos `connect`, iguais ao HEAD · SHA-256 de `read_emails.py` = manifesto · npm test/lint/typecheck **não executados** (delta sem arquivo TS/JS; as guardas TS só citam os docs em comentário) · e2e não aplicável

O diff trata três casos. (1) Uma falha da RPC de fornecedor deixa de cair no pagador: `SupplierResolutionError`, a migration 138 e o `sender_email` fora da sondagem. (2) Em guia de tributo, o contribuinte não vira mais fornecedor, e o favorecido real vence. (3) Curadoria de dados nas migrations 139 e 140.

O desenho está correto e os testes cobrem o que prometem: call site executado, anti-vacuidade e paridade entre marcador e migration com sanidade do parser. Encontrei uma lacuna no contrato novo de `resolve_supplier` e um consumidor adjacente que ficou desalinhado.

## Achados

### 🔴 Bloqueantes
Nenhum

### 🟡 Recomendados

- [skills/email-reader/scripts/read_emails.py:1127] `resolve_supplier` não captura `http.client.HTTPException` (`IncompleteRead`, `BadStatusLine`, `LineTooLong` não herdam de `OSError`), e `_http_error_detail` também não.
  Falha:     a conexão cai durante o `r.read()` da RPC → `IncompleteRead` escapa de `resolve_supplier` e de `_finalize_supplier` (que só captura `SupplierResolutionError`) → `process_message` cai no `except Exception` → o e-mail inteiro fica em `falha`, os boletos seguintes do mesmo e-mail não são processados e o e-mail já fica registrado. O contrato diz que falha transitória re-tenta e que qualquer falha vira `SupplierResolutionError`, com o erro registrado por conta.
  Evidência: `issubclass(http.client.IncompleteRead, OSError)` → `False`; `issubclass(BadStatusLine, OSError)` → `False`. A tupla transitória é `(URLError, TimeoutError, OSError)`. Antes do diff, o `except Exception` devolvia `None`.
  Correção:  incluir `http.client.HTTPException` na tupla transitória e no `except` de `_http_error_detail`, com um caso de teste.
  Regra:     CLAUDE.md global § Python ("separar falha de rede esperada de erro inesperado"); docstring do próprio `resolve_supplier`.

- [scripts/reprocess_body_emails.py:126] O dry-run (`inspect_one`) ignora o `False` de `_finalize_supplier`. Com o desfecho novo (falha da RPC → `False`, antes → pagador), a previsão diverge do modo real.
  Falha:     a RPC falha no dry-run → o log registra a exceção, mas `find_financial_duplicate` roda sem `sk_supplier` e o script informa "gravaria R$ X". No modo real, `try_extract_from_body` devolve `BODY_NONE` e nada é gravado.
  Evidência: linha 126 chama `R._finalize_supplier(...)` sem checar o retorno. O `False` já era possível antes (sem pagador), e o delta aumentou a frequência.
  Correção:  `if not R._finalize_supplier(...): log + return "sem_fornecedor"`.
  Regra:     rito § Passo 6.5 (superfície adjacente); CLAUDE.md § Scripts de manutenção (o dry-run precisa provar o que o modo real faz). **Arquivo fora do delta.**

### 🔵 Opcionais
- [read_emails.py:421] `SUPPLIER_RPC_ATTEMPTS <= 0` deixa o laço vazio: levanta "falhou: None" sem nenhuma chamada. Um `max(1, …)` resolve; o padrão é o mesmo de `DUP_QUERY_ATTEMPTS`.
- [read_emails.py:1129] 408 e 429 são transitórios, mas caem no ramo "4xx definitivo": a conta vai a `/erros` em vez de re-tentar.
- [tests/test_supplier_contribuinte_guia.py:180] `test_ctrl_sem_tokens_de_marca_degrada_para_similaridade` não verifica `ctrl.payloads == []`, ao contrário dos testes irmãos.

## Pendências (trabalho incompleto)
- [read_emails.py + deploy-manifest.json] Deploy manual em produção ainda não feito (registrado em `progress.md`). Até lá, a guia com a grafia "CONFECES" volta a cair no sk 1400. — recomendada (depende do usuário)
- Marcadores TODO/FIXME/HACK/XXX/WIP no delta, incluindo os untracked: nenhum. Stubs e testes pulados: nenhum.

## Drift código × documentação
- `read_emails.py:1105` × `CLAUDE.md:836`: o CLAUDE.md diz que "só a recusa 'nenhum identificador valido' devolve `None`", mas o código também devolve `None` com o Supabase indisponível (`_available=False`). A docstring e `docs/knowledge/pipeline-extracao.md` citam os dois casos. — decisão pendente do usuário

## Não coberto
- Estado real do banco: não consultei se as migrations 138/139/140 estão aplicadas, nem comparei o corpo de `resolve_supplier_id` da 138 com a definição viva no catálogo (a migration afirma que foi "copiado do catálogo").
- A medição do limiar 0,85 (1.387 fornecedores) não foi reproduzida. A premissa foi aceita como documentada.
- `read_emails.py` (~7 mil linhas) foi lido nos hunks, em `_finalize_supplier`, `_resolve_supplier_by_payer`, `_is_tax_document` e no caminho de exceção de `process_message`; o restante não.
- Vulture rodou só nos 2 arquivos alterados, não com o comando completo da skill (`server/ skills/ scripts/`).
- Gates npm (Vitest, ESLint, tsc, ts-prune) não executados: o delta não tem arquivo TS/JS.

---

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| R1 | `http.client.HTTPException` escapava do contrato de `resolve_supplier` | ✅ corrigido | `read_emails.py`: incluído na tupla transitória e no `except` de `_http_error_detail`. Teste novo `test_corpo_cortado_retenta_e_esgotado_levanta`: verde com a correção, **vermelho com o mutante** (arquivo restaurado e conferido por `diff -q`). Manifesto regravado com `--update` e paridade em 32/32 |
| R2 | Dry-run de `reprocess_body_emails.py` ignora o `False` de `_finalize_supplier` | ⏸️ adiado | arquivo fora do delta (correcao.md, item 4). Correção proposta: `if not R._finalize_supplier(...): return "sem_fornecedor"` |

Gates após a correção: pytest 1730 (+1) · ruff `read_emails.py` 82 (= baseline) e teste 0 · paridade 32/32 · EOL ok
Baseline (Passo 3):    pytest 1729 · ruff 82 · SHA do manifesto conferido
Re-review do diff da correção: sem achado novo

Não corrigido por decisão sua: drift do `CLAUDE.md:836` (`None` com Supabase indisponível), os 3 opcionais, o deploy manual.
Nada foi commitado.
