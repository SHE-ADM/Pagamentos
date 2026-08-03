# Code Review — Features / Onda 4 (varredura histórica) (2026-08-03)

## Resumo

Alvo: `achados` — **não resolvido** como plano (o termo casa relatórios de review, não um documento
de plano). Referência de pendências usada: `docs/roadmap-enriquecimento-dados.md` §ONDA 4 +
`~/.claude/plans/adaptive-stirring-goose.md` (plano aprovado nesta sessão).
Modo: **light (sem passo de ataque, sem verificação adversarial)**
Delta: 5 arquivos alterados (+287/−10), 2 novos (`scripts/varredura_historica.py` 905 linhas ·
`tests/test_varredura_historica.py` 689 linhas), lidos por inteiro
Régua: `CLAUDE.md` (raiz + workspace + global) · `docs/roadmap-enriquecimento-dados.md` §ONDA 4 ·
`docs/padrao-execucao.md`
Gates: **pytest 951 passed** (baseline 890) · **npm test 1.213 passed** (506+705+2) · **lint exit 0**
· **typecheck OK** · **prune exit 0** · **vulture** só os 7 falsos positivos conhecidos de rota Flask
(baseline documentado no `CLAUDE.md`)

Revisado o script novo da Onda 4 — passada única, estritamente aditiva sobre a caixa IMAP —, a
extensão do módulo compartilhado `supabase_rest.py`, os 49 testes de comportamento e as 12 guardas
textuais. Os quatro invariantes declarados (não gravar conta, não marcar `\Seen`, não sobrescrever,
não escrever em `PDF_INBOX`) estão implementados de forma estrutural e travados por teste validado
por mutante. **Um bloqueante:** o script detecta que a caixa mudou de identidade no meio da passada,
diz "Abortando." e **continua processando**. Mais três recomendados, todos em código defensivo ou de
relatório — a categoria que menos aparece em teste porque só roda quando algo já deu errado.

## Achados

### 🔴 Bloqueantes

- [scripts/varredura_historica.py:858] A varredura **não aborta** quando o `UIDVALIDITY` muda no
  meio, apesar de a mensagem de erro afirmar "Abortando."
  Falha:     a passada é longa (horas, milhares de mensagens). Se a caixa for recriada/migrada no
             meio, `_reconectar` levanta `RuntimeError` — mas o `except Exception` do laço o trata
             como "falha desta mensagem", registra em `falhados` e **segue para o UID seguinte**, que
             agora designa outra mensagem. O log repete "Abortando." a cada mensagem sem abortar, e o
             operador lê "1 uid com falha" no fim e conclui que a passada terminou bem.
  Evidência: execução com IMAP falso trocando o `UIDVALIDITY` na reconexão →
             `UIDs processados APOS a deteccao: [b'2', b'3']`. O teste existente
             (`test_uidvalidity_diferente_apos_reconexao_aborta`) cobre só `Caixa.mensagem` isolada,
             não o laço — é onde o "continuar" realmente acontece.
  Correção:  exceção dedicada (`class CaixaMudou(RuntimeError)`) levantada por `_reconectar` e
             re-levantada no `except Exception` do laço, caindo no `except` externo que já reporta e
             devolve 1; mais um teste no nível do laço.
  Regra:     `CLAUDE.md` → "não silenciar erro"; o próprio invariante 5 do script (idempotente e
             retomável) depende de um checkpoint coerente com uma única identidade de caixa.

### 🟡 Recomendados

- [scripts/varredura_historica.py:531] `_texto_apos_decrypt` **vaza no `%TEMP%` o PDF
  descriptografado**, em claro.
  Falha:     `extract_pdf._decrypt_pdf` cria a cópia aberta via `tempfile.mkstemp` e devolve o
             `Path`; ninguém a apaga. Numa passada sobre a caixa inteira, cada PDF cifrado (OBER e
             afins) deixa um boleto **legível** no diretório temporário do usuário — dado financeiro
             sensível, além do espaço. No reader o vazamento existe mas é de 1 por e-mail novo; aqui
             é o acervo inteiro de uma vez.
  Evidência: `extract_pdf.py:1112-1118` — `fd, tmp = tempfile.mkstemp(...)` … `return Path(tmp)`;
             nenhum `unlink` no chamador.
  Correção:  `try/finally` em `_texto_apos_decrypt` com `aberto.unlink(missing_ok=True)`.

- [scripts/varredura_historica.py:781] O relatório final imprime números do inventário **já
  mutados** pelo processamento.
  Falha:     `estado = {**inv, ...}` é cópia rasa — `estado["corpo_pendente"]` **é o mesmo objeto**
             que `inv["corpo_pendente"]`, e `_processar_mensagem` faz `pop` nele (idem `add` em
             `chaves_fiscais` e escrita em `objetos`). Numa passada que grava 400 corpos, o relatório
             final diz `com body_full NULO: 0 (candidatos)` e `fiscal_document hoje: <total já com as
             novas>` — some justamente a base de comparação que justifica a onda.
  Evidência: execução — `corpo_pendente e o MESMO objeto? True` / `depois do pop, inv tem 0
             candidatos`.
  Correção:  capturar as contagens iniciais num dict antes do laço e `_relatorio` consumir esses
             valores, não os dicionários vivos.

- [scripts/supabase_rest.py:96] `storage_list(com_metadata=True)` entrou no **módulo compartilhado**
  sem teste de comportamento.
  Falha:     é a fonte única de transporte, e o modo novo alimenta a decisão de `storage_key_for`
             sobre **sobrescrever ou não** um objeto. Se o formato de `metadata` mudar, ou o ramo
             novo quebrar a paginação, nada acusa: os testes existentes
             (`test_backfill_provenance.py:387-401`) exercitam só o modo lista.
  Evidência: `grep storage_list` em `tests/` retorna apenas chamadas com 3 argumentos.
  Correção:  um caso no servidor falso já existente cobrindo `com_metadata=True` — paginação e
             objeto com `metadata` ausente/nulo.
  Regra:     `CLAUDE.md` → "todo componente novo ou alterado de forma relevante deve ter ao menos um
             teste"; a lição do `supabase_rest.py` é justamente que a fonte única concentra risco.

- [tests/test_varredura_historica.py:533] `--upload-all` é a única flag que **muda o comportamento
  de escrita** e não tem teste.
  Falha:     com ela, anexo sem chave de acesso passa a subir ao bucket. Uma regressão que inverta a
             condição (`if not docs and not estado["upload_all"]`) faria a varredura subir **todos**
             os anexos por padrão — órfãos que a próxima purga apagaria, depois de pagar a banda —
             sem nenhum teste vermelho.
  Evidência: `upload_all` aparece só como `False` no fixture; nenhum caso o liga.
  Correção:  um caso em `ProcessarMensagemTest` com `upload_all=True` provando que o anexo sem chave
             sobe e **não** gera linha em `fiscal_document`.

### 🔵 Opcionais

- [tests/test_fiscal_document_consistency.py:41] `_sem_prosa` remove `#` até o fim da linha sem
  respeitar strings: um `#` dentro de literal na mesma linha esconderia um identificador proibido da
  guarda (falso negativo). Correção robusta seria `tokenize`.
- [scripts/varredura_historica.py:890] `_estado_checkpoint` é definida **depois** de `main`, que a
  usa — funciona, mas quebra a leitura de cima para baixo do arquivo.
- [scripts/varredura_historica.py:706] o rótulo `bytes a baixar` descreve, no modo real, bytes **já
  baixados**.
- [scripts/varredura_historica.py:880] `_relatorio` é impresso mesmo quando o run aborta por
  checkpoint incompatível — um relatório inteiro zerado logo abaixo da mensagem de erro.

## Pendências (trabalho incompleto)

- [scripts/varredura_historica.py] **O script nunca foi executado — nem `--dry-run`.** A onda só
  fecha depois de: dimensionar a caixa, medir a taxa com `--deep --limit 200`, rodar `--limit 50`
  real conferindo que `financial_account_control` não mudou, e então a passada completa —
  **bloqueante para o fechamento da Onda 4**, mas é trabalho novo, não correção.
- [docs/roadmap-enriquecimento-dados.md:738] A linha de registro diz "script pronto, NÃO executado";
  precisa ser fechada com as contagens reais depois da passada — **recomendada**.
- [scripts/varredura_historica.py:424] `Caixa.pastas()` faz `SELECT` em **todas** as pastas da conta
  para contá-las, incluindo Spam/Lixo. É leitura pura (`readonly=True`, sem FETCH), mas a memória do
  projeto diz "ler SOMENTE a INBOX" — vale confirmar que contar é aceitável — **opcional**.

## Drift código × documentação

- `docs/roadmap-enriquecimento-dados.md` diverge de si mesmo: linhas **460 e 317 dizem "439"** corpos
  truncados; linhas **304, 856 e 861** do mesmo documento — e o `CLAUDE.md:1771/5060` — dizem
  **440**. O delta usa 440 (consistente com a migration 105). Divergência **preexistente, fora do
  delta** — decisão pendente do usuário sobre qual número é o correto; não corrigida por regra do
  rito.

## Não coberto

- **Baseline dos gates Node não foi medido antes do delta.** `npm test`/`lint`/`typecheck`/`prune`
  foram executados apenas no estado atual (todos verdes). O delta não toca nenhum arquivo JS/TS, mas
  a comparação número-a-número com o estado anterior não existe. O baseline do pytest existe (890,
  medido no início da sessão) — hoje 951.
- **Nenhum gate foi executado contra a caixa IMAP ou o Supabase reais.** Toda a verificação do script
  é por teste com IMAP/rede falsos. O comportamento contra o servidor real (formato exato do
  `LIST`/`UIDVALIDITY` da Locaweb, resposta do Storage a upload sem `x-upsert`) é **inferido do
  código, não observado** — é exatamente o que o `--dry-run` pendente serve para provar.
- **`_document_parts` foi comparado com `save_attachments` em UMA mensagem sintética** (PDF + JPEG
  anexo + PNG inline). Anexos aninhados (`message/rfc822` encaminhado com anexo dentro) não foram
  exercidos em nenhum dos dois lados.
- **Dimensão de concorrência** aplicada por raciocínio (PATCH com `is.null`, INSERT com
  `ignore-duplicates`, upload sem upsert), não por execução concorrente real com o reader agendado.

---

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| B1 | Varredura não abortava quando o `UIDVALIDITY` mudava | ✅ corrigido | `CaixaMudou(RuntimeError)` + `except CaixaMudou: raise` antes do `except Exception` do laço (`varredura_historica.py:342,904`); teste `test_caixa_que_muda_no_meio_ABORTA_o_laco` no nível do laço, validado por mutante |
| R1 | PDF descriptografado vazava no `%TEMP%`, em claro | ✅ corrigido | `finally` com `unlink(missing_ok=True)` em `_texto_apos_decrypt` (`:542-564`); 2 testes (caminho feliz e falha no meio) |
| R2 | Relatório final lia contagens já mutadas do inventário | ✅ corrigido | `_contagens_iniciais()` tira a foto antes do laço (`:722`); `_relatorio` passa a consumi-la |
| R3 | `storage_list(com_metadata=True)` sem teste de comportamento | ✅ corrigido | 2 casos em `test_backfill_provenance.py` (paginação no modo novo + `metadata` ausente/nulo) |
| R4 | `--upload-all` sem teste — única flag que muda escrita | ✅ corrigido | `test_upload_all_sobe_anexo_sem_chave_e_nao_registra_fiscal` |
| — | Rótulo "bytes a baixar" no modo real (opcional O3) | ✅ corrigido | corrigido de carona, na mesma linha do fix R2 — declarado por transparência |

Gates após a correção: **pytest 958 (+7)** · npm test 1.213 · lint exit 0 · typecheck OK · vulture
só os 7 falsos positivos de rota Flask
Baseline (Passo 3):    **pytest 951** · npm test 1.213 · lint exit 0 · typecheck OK · idem
Re-review do diff da correção: **sem achado novo** — `CaixaMudou` é subclasse de `RuntimeError`, logo
cai no `except` externo que já reportava e devolvia 1; o `unlink` roda depois de o texto já estar em
memória; `_contagens_iniciais` é pura e tem call site único.

Mutantes validados nesta fase (5/5 ficaram VERMELHOS, todos revertidos e conferidos por `diff -q`):
remover o re-raise de `CaixaMudou` · remover o `unlink` · contagem por referência viva · ignorar
`upload_all` · descartar o `metadata`.

### Não corrigido por decisão sua

- ⏸️ **Contagem de testes na documentação ficou obsoleta pela própria correção.** `CLAUDE.md:1683`,
  `roadmap:738` e `roadmap:955` dizem "49 testes"; agora são **54** em
  `test_varredura_historica.py` (+ 41 em `test_backfill_provenance.py`, era 39). Não alterado
  porque o rito proíbe tocar docs de estado na fase de correção — é ajuste de uma linha em cada
  um dos três pontos.
- ⏸️ **Drift 439 × 440** corpos truncados dentro do próprio roadmap (linhas 460/317 × 304/856/861).
  Preexistente e fora do delta; exige sua decisão sobre qual número vale.
- ⏸️ **Pendência de execução:** o script nunca rodou, nem em `--dry-run`. É trabalho novo, não fix.
- 🔵 **Opcionais não corrigidos:** `_sem_prosa` sem `tokenize`; `_estado_checkpoint` definida abaixo
  de `main`; relatório zerado impresso quando o run aborta por checkpoint incompatível.

Nada foi commitado.

---

## Adiados resolvidos (2026-08-03, a pedido — "com robustez técnica no código e de estrutura")

| # | Item adiado | Desfecho | Como |
|---|---|---|---|
| A1 | Contagem de testes obsoleta na doc | ✅ resolvido | `CLAUDE.md:1683`, `roadmap:738` e `:955` → **55 testes de comportamento + 12 guardas**; números conferidos por execução, não estimados |
| A2 | Drift 439 × 440 corpos truncados | ✅ resolvido | alinhado em **440** (`roadmap:317,462`), que é o valor da **tabela medida** da §7.2 e o que o `CLAUDE.md` já registrava; a linha do diagnóstico (`:79`) preserva o 439 original **com nota de refinamento** — apagá-lo reescreveria o histórico da medição |
| O1 | `_sem_prosa` podia dar falso negativo | ✅ resolvido | trocado regex por **`ast` + `tokenize`** (`test_fiscal_document_consistency.py:41`) + classe `SemProsaTest` com 5 casos |
| O2 | `_estado_checkpoint` definida depois de `main` | ✅ resolvido | movida para antes (`varredura_historica.py:790`, `main` em `:823`) |
| O4 | Relatório zerado impresso no aborto precoce | ✅ resolvido | flag `varreu`, ligada só quando o laço começa; teste `test_aborto_no_gate_do_checkpoint_nao_imprime_relatorio_zerado` |
| P1 | Script nunca executado | ⏸️ **continua adiado** | é execução contra a caixa postal e o Supabase reais — fora de "código e estrutura", e o plano a define como passo operacional do usuário |

### Por que `ast` + `tokenize` e não regex (O1)

A guarda antiga mentia **nos dois sentidos**, e o pior deles é silencioso:

- `re.sub(r"#[^\n]*", "")` cortava a partir de **qualquer** `#`, inclusive dentro de string:
  `q = "select # from financial_account_control"` perdia o identificador, e a guarda
  "o nome da tabela financeira não aparece no código" **deixava passar exatamente o que existe
  para barrar**;
- `re.sub(r'"""[\s\S]*?"""', "")` casava qualquer par de aspas triplas — docstring ou não —,
  engolindo o código entre duas strings triplas não relacionadas.

`tokenize` sabe onde um `#` é comentário e onde é conteúdo de string; `ast` sabe quais strings são
docstring de módulo/classe/função. Nenhum dos dois adivinha. A limpeza também **preserva a
numeração das linhas** (comentário vira linha vazia, não linha removida), para que um trecho
reportado por uma guarda continue apontando para o lugar certo.

Gates após esta rodada: **pytest 964 (+6 desde 958)** · npm test 1.213 · lint exit 0 · typecheck OK
· prune exit 0 · vulture só os 7 falsos positivos de rota Flask
Mutantes validados: `_sem_prosa` de volta ao regex → **2 testes vermelhos**; relatório sempre
impresso → **1 vermelho**. Ambos revertidos e conferidos por `diff -q`.
Re-review do diff desta rodada: **sem achado novo** (`_estado_checkpoint` antes de `main`; CLI
responde; docs coerentes entre si).

Nada foi commitado.

---

## Execução da Onda 4 (2026-08-03) — e o defeito de teste que ela revelou

Passada real autorizada e executada: ensaio `--limit 50` → passada completa → reexecução de prova.

| Medida | Antes | Depois | Δ |
|---|---|---|---|
| `financial_account_control` count / `max(id)` | 673 / 822 | 673 / 822 | **+0 / +0** ✅ |
| `email_control` | 1.166 | 1.166 | +0 (nenhuma linha criada) |
| corpos pendentes | 506 | 436 | −70 |
| `fiscal_document` | 172 | 179 | +7 |
| objetos no bucket | 520 | 524 | +4 |

264 mensagens, **0 falhas**, quarentena vazia, reexecução devolve `a processar: 0 de 264`.

### 🔴 Defeito de teste descoberto pela execução (corrigido)

`MainDryRunTest` lia o `data/varredura_checkpoint.json` **REAL** do projeto. Enquanto o script
nunca tinha rodado, o arquivo não existia e os 7 casos passavam **por acidente**. Na primeira
execução de verdade o checkpoint apareceu com o UIDVALIDITY da caixa real, o gate de
compatibilidade disparou e `test_dry_run_nao_escreve_nada` ficou vermelho.

Nem o review nem os 15 mutantes tinham pego: **nenhum deles alterava o disco**, e a suíte só
distinguia os dois mundos por um arquivo fora do repositório. Corrigido com `setUp` que aponta
`CHECKPOINT_PATH` e `QUARENTENA_DIR` para um `tempfile.TemporaryDirectory` — validado por mutante
(sem o isolamento, o teste volta a ficar vermelho com o checkpoint real presente).

> **Lição:** teste que depende da AUSÊNCIA de um arquivo é verde por acidente até alguém criar o
> arquivo. Estado local (checkpoint, cache, lock, diretório de saída) precisa ser isolado no
> `setUp`, não herdado do ambiente.

Gates finais: **pytest 964** · lint exit 0 · typecheck OK · vulture só os 7 falsos positivos de rota
Flask. Nada foi commitado.

---

## Resolução das pendências e achados abertos (2026-08-03)

| # | Item | Origem | Desfecho |
|---|---|---|---|
| **P0** | Purga apagaria **10 PDFs fiscais** legítimos | achado desta sessão (a frase "purga liberada" era minha) | ✅ **corrigido** — `_tem_chave_fiscal` decide pelo CONTEÚDO; 68 → 58 a apagar |
| A7-2 | `Dashboard.tsx` (vencimentos) sem a11y | review 2026-07-08 | ✅ `Dashboard.a11y.test.tsx` — 3 casos (inicial, com filtro, escopo "todas") |
| A7-3 | `ResetPasswordForm` sem teste funcional | review 2026-07-08 | ✅ `ResetPasswordForm.test.tsx` — 5 casos, inclusive **signOut antes de navigate** |
| A7-4 | `Erros` e `CobrancaErros` sem teste de página | review 2026-07-08 | ✅ 10 casos nos dois — filtro só ao confirmar, detalhe, falha vira mensagem |
| A7-5 | `is_processed` sem pytest | review 2026-07-08 | ✅ `tests/test_is_processed.py` — 7 casos + guarda cross-layer do call site |

Gates: **pytest 978** (era 964) · **Node 1.231** (era 1.213) · lint 0 · typecheck OK · vulture só
os 7 falsos positivos de rota Flask.

### O bloqueante em detalhe

A preservação da purga era por `storage_key`, e `fiscal_document.access_key` é **UNIQUE** — logo
ela cobre só o **primeiro** objeto de cada chave. O segundo (o PDF individual, quando a
transportadora também manda o consolidado) não consta em lugar nenhum, vira órfão e era apagado
**sendo um DACTE legítimo**. E a lacuna **crescia**: 4 objetos em 01/08, **10** em 03/08.

A correção inspeciona o conteúdo antes de apagar, com três decisões todas na direção de não
apagar: só PDF é aberto; **falha ao baixar ou ler → preserva**; e a barreira roda **também no
`--dry-run`** — senão o relatório prometeria apagar o que a execução preservaria, e o dry-run é o
único relatório que o operador lê antes de autorizar algo irreversível.

**8 mutantes validados** nesta rodada: sem a barreira · falha ao baixar passando a apagar · "44
dígitos" sem validar DV · barreira movida para depois do dry-run · `is_processed` falhando fechado
· `if known_ids is not None` · `navigate` antes de `signOut` · filtro de `Erros` a cada tecla.

### Continuam abertos — por escopo, não por esquecimento

- **Ondas 5–9** do roadmap (camada 2 fiscal, campos derivados, `audit_log`, hardening do chat).
- **RBAC completo** (migrations 066–068 + `requirePermission`) — desenhado, não implementado.
- **Prova da RLS do chat** com usuário do grupo Comercial — adiada por decisão de produto.
- **Handlers de boleto por link**: SIEG (JS/ajax), Lmed/mdnet (CAPTCHA), Efí (PDF por JS).
- **TanStack Query** em `Consulta.tsx`/`Emails.tsx`; **`portal-next`** de volta ao jsdom;
  **`payment_type_id`** sem tabela de domínio.

Nada foi commitado.
