# Code Review — Features, working tree (2026-09-15)

## Resumo
Alvo: nenhum (review do diff completo)
Modo: max (passo de ataque + verificação adversarial)
Delta: 14 arquivos alterados (+788/−49) e 11 novos (2.303 linhas: `reprocess_document_number.py`, migrations 138–141 e 6 testes). Os dois relatórios light do dia ficaram fora do delta. EOL conferido: `--ignore-cr-at-eol` dá o mesmo stat.
Régua: `CLAUDE.md` do projeto (Regras 2 e 4, Pipeline de extração, Banco de dados), skills `pipeline-extracao` e `scripts-manutencao`, `docs/padrao-execucao.md` (via CLAUDE.md global)
Gates: pytest **1774 passed** · ruff, comparado com o HEAD (sem gate de CI): `read_emails.py` 83→82, `extract_pdf.py` 36→36, `reprocess_body_emails.py` 5→5, `reprocess_beneficiario_final.py` 8→8, `test_dup_nosso_numero_titulo.py` 3→3; arquivos novos 0, exceto `test_reprocess_body_dry_run.py` 3 · `check_deploy_parity.py` 32/32 · npm test/lint/typecheck **não executados** (delta sem TS/JS) · e2e não aplicável
Verificação adversarial: 2 contestações; 1 confirmado, 0 enfraquecidos, 1 refutado

Este review cobre três frentes. A primeira é o Nº do Documento no lugar do nosso número: prompt, leitura determinística, guardas de dedup e script retroativo. A segunda é a regra BENEFICIÁRIO = pagadora ⇒ sk 1 (migration 141). A terceira é a parte de fornecedor/RPC, já revisada pelos dois reviews light do dia e revisitada aqui só no ataque.

O desenho das guardas de dedup resistiu. A regra nova também resistiu aos ataques medidos: o write-back de contato e o de classificação protegem o sk 1, `unique_invoice_number` roda depois da dedup e, no banco, só a 933 e a 194 são boletos com pagador terceiro no sk 1.

O defeito real está no parser do Nº do Documento. Ele aceita a cauda "Espécie/Aceite" quando ela tem mais de 5 letras. **O script retroativo já rodou em modo real hoje (14:44–14:50 UTC, 338 edições) e gravou esse lixo em 5 contas do banco compartilhado.**

**Refutado na contestação:** `_own_document_number` por igualdade estrita (legado sem carteira/DV). Na SIEG, fornecedor do cenário, o Nº do Documento impresso é idêntico ao valor legado (`000000091070`), então `_same_title` deduplica. A única conta em aberto do grupo (1330) já tem a 2ª via deduplicada. Nos demais grupos, o número é próprio, e a correção proposta os leria como cópia. Exposição real: zero.

## Achados

### 🔴 Bloqueantes
Nenhum

### 🟡 Recomendados

- [skills/pdf-contas-pagar/scripts/extract_pdf.py:956] `_DOCNUM_ROW_RE` só admite até 2 tokens sem dígito, de 1 a 5 caracteres, entre o Nº do Documento e a data. Com Aceite "NAO ACEITO" ou Espécie "RECIBO" (6 letras), o grupo preguiçoso absorve a cauda, e ela vence o `invoice_number` do modelo. `[verificado]`
  Falha:     linha `12/06/2026 1606 DS NAO ACEITO 12/06/2026 0000000000118` → `"1606 DS NAO ACEITO"`; linha `15/06/2026 0008901683 RECIBO N 16/06/2026 04/26/104177433-1` → `"0008901683 RECIBO"`. `apply_boleto_document_number` grava isso no pipeline, e `reprocess_document_number.py` fez o mesmo no PATCH.
  Evidência: (a) nos 221 PDFs locais, 67 páginas deram valor, **3 delas com cauda** (FATURA OTIMOTEX 12326 e 12389, Infoglobo); (b) no banco estão as contas **123/558/1051** ("… RECIBO", sk 1191) e **147/1043** ("… DM NAO ACEITO", CT-e), com `audit_log` `ator_via='servico'` entre 14:44:18 e 14:48:10 e o nosso número como valor anterior; (c) contestação: nada a jusante normaliza o valor, e pelo cabeçalho a cauda são as colunas Espécie/Aceite.
  Correção:  descartar os tokens finais sem dígito do valor capturado, com testes das duas linhas reais. As 5 contas já gravadas **não** voltam à seleção do script (o `invoice_number` delas deixou de ser igual ao `nosso_numero`) e exigem correção dirigida, que fica como pendência.
  Regra:     CLAUDE.md § Pipeline ("Um extrator que erra … produz um acervo que parece completo"); `docs/padrao-execucao.md` § validar contratos
  Veredito:  CONFIRMADO

### 🔵 Opcionais
- [scripts/reprocess_document_number.py:120,196] `_download_pages`/`_patch_invoice` capturam só `URLError`/`TimeoutError`. `ConnectionResetError` e `http.client.IncompleteRead` durante o `read()` abortam o lote no meio, sem resumo. O script é idempotente, então basta reexecutar, mas a execução parcial não fica declarada.
- [scripts/reprocess_document_number.py:195] O PATCH não passa por `unique_invoice_number`. Parcelas que repetem o Nº (ex.: BR Supply `000134997-007` em 3 páginas) passam a compartilhar o mesmo valor, enquanto o pipeline gravaria `(2)`/`(3)`. Impacto não medido: a dedup 2 é vetada pelo nosso número.
- [scripts/reprocess_document_number.py:65] Contas "já corretas" (Nº impresso = nosso número) continuam na varredura e são baixadas de novo a cada execução.
- [tests/test_reprocess_body_dry_run.py] ruff 3 (`noqa` sem uso, `return None` redundante). O achado vem do review anterior e segue aberto.

## Pendências (trabalho incompleto)
- [banco — contas 123, 558, 1051, 147, 1043] `invoice_number` com cauda Espécie/Aceite gravado pelo script retroativo. Correção dirigida depois do fix do parser: `0008901683`, `0008951990`, `0009004814`, `2306`, `1808`, conferindo cada PDF. — recomendada (escrita no banco compartilhado, decisão sua)
- [progress.md / docs] A execução real do `reprocess_document_number.py` (15/09, 14:44–14:50 UTC, 338 contas) não está registrada, e hoje só um `SELECT` no `audit_log` prova que ocorreu. — recomendada
- [read_emails.py + extract_pdf.py + deploy-manifest.json] Deploy manual em produção pendente (registrado em `progress.md`). — recomendada (depende do usuário)
- Marcadores TODO/FIXME/HACK/XXX/WIP, stubs e testes pulados: nenhum no diff nem nos untracked.

## Drift código × documentação
Nenhum. Os números da documentação ("432 de 510") descrevem a medição anterior à execução do script. Hoje restam 161 cópias estritas entre os boletos, coerente com as 338 edições. Não é divergência de comportamento.

## Não coberto
- **Vetor "o modelo inverte beneficiário e pagador"** contra a regra BENEFICIÁRIO = pagadora: nesse caso o boleto de um fornecedor real iria ao sk 1. Não é mensurável, porque o CNPJ/nome extraído antes da remoção não é persistido. A medição pelos CSVs locais foi **vácua** (`data/csv_output` é log de e-mail, não linha extraída). O que o banco mostra: 81 contas com pagador terceiro, 5 com fornecedor = pagador e 11 no sk 1 (9 guias, 933, 194).
- Cadastro-apelido removido (1227) continua casando pela RPC por nome (`deleted_at` ignorado). Um boleto "CONFECCOES OTIMOTEX" **sem** CNPJ extraído cai no 1227 removido. É o residual declarado na 141.
- Migrations 138–140 e os testes `test_supplier_contribuinte_guia`/`test_supplier_rpc_failure`/`test_reprocess_body_dry_run` foram lidos pelo diff. Revisão profunda e conferência no banco ficaram com os dois reviews light do dia. A **141** foi conferida aqui: 933 no sk 1 com 12/631/8 e 1227 removido.
- `read_emails.py` foi lido nos hunks e em `find_financial_duplicate`, `_finalize_supplier`, `unique_invoice_number`, `upload_attachment` e nos call sites de dedup, não por inteiro.
- A amostra do parser são os 221 PDFs locais (jun–jul). PDFs só-Vision (sem texto) não passam pelo parser; o texto dos 338 PDFs do lote de hoje não foi relido.
- Gates npm (Vitest, ESLint, tsc, ts-prune) não executados: o delta não tem arquivo TS/JS.

---

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| R1 | Cauda Espécie/Aceite ("NAO ACEITO", "RECIBO") entrava no Nº do Documento | ✅ corrigido | `extract_pdf.py` (`extract_boleto_document_number`): tokens finais sem dígito são descartados antes de `_is_valid_docnum`. Teste novo `test_cauda_de_especie_e_aceite_nao_entra_no_numero`, com as duas linhas reais e sanidade do cabeçalho: verde com a correção e **vermelho com o mutante** (`'1606 DS NAO ACEITO' != '1606'`); arquivo restaurado e conferido por `diff -q`. Re-medição nos 221 PDFs: 67 páginas, e **só os 3 valores com lixo mudaram** (`1606`, `2306`, `0008901683`). Manifesto regravado com `--update`, paridade 32/32 |

Gates após a correção: pytest 1775 (+1) · ruff `extract_pdf.py` 36 (=) e `test_boleto_document_number.py` 0 · paridade 32/32 · EOL ok
Baseline (Passo 3):    pytest 1774 · ruff `extract_pdf.py` 36 · paridade 32/32
Re-review do diff da correção: sem achado novo. Contra o `pre-fix.diff` congelado, o diff só contém o laço de corte, o hash novo no manifesto e o teste novo. Sem caminho de erro engolido nem mudança de contrato: lista vazia vira `""` e cai no `_is_valid_docnum`. ⚠️ **Residual deliberado:** um Nº cujo sufixo real seja só letras ("NF 123 A") perde o sufixo. Nenhum dos 67 valores reais tem esse formato.

Não corrigido por decisão sua:
- As **5 contas já gravadas com lixo** (123, 558, 1051, 147, 1043). Escrita no banco compartilhado, e o script retroativo não as seleciona de novo.
- O registro da execução do script em `progress.md`.
- Os 4 opcionais.
- O deploy manual (`read_emails.py`, `extract_pdf.py`, `deploy-manifest.json`).

Nada foi commitado.
