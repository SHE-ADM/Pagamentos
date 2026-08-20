# Code Review — Features / tipo `dar / dare` + roteamento de fornecedor por e-mail encaminhado (2026-08-19)

## Resumo

Alvo: `Riscos residuais que deixei registrados` — resolvido em
[progress.md](../../progress.md) § "Pendências conhecidas" (3 itens novos: guia por Vision,
fallback 3 morto, 8 guias JUCE) + [docs/knowledge/pipeline-extracao.md](../knowledge/pipeline-extracao.md).
Modo: light (sem passo de ataque, sem verificação adversarial)
Delta: 13 arquivos alterados, 5 novos (990 linhas), +468/−41 nos versionados
Régua: `CLAUDE.md` (raiz + workspace + global), `docs/db/historico-migrations.md`,
`docs/knowledge/pipeline-extracao.md`, `docs/padrao-execucao.md`
Gates: unittest **1555 OK** · vitest **1596** (620+921+2+53, 204 arquivos) · typecheck OK ·
lint 0/0 · ts-prune 0 · check_deploy_parity **32/32** · pytest **não executado** — módulo
ausente no `.venv` (substituído por `unittest discover`, que roda a mesma suíte) · e2e
Playwright **não executado** — crasha no sandbox do agente

O delta faz duas coisas independentes que compartilham o mesmo caso de origem (conta 1101):
consolida `dar`/`dare` no tipo único `dar / dare` (migrations 132/133) e cria o fallback 1b de
fornecedor pelo e-mail do remetente original encaminhado (migration 134). **Nenhum bloqueante.**
O trabalho é de qualidade acima da média do repositório: os testes novos declaram o mutante que
travam, têm anti-vacuidade explícita e o `PdfCallSiteTest` executa a função de topo em vez de
conferir wiring por texto — exatamente o que a regra 2 do `CLAUDE.md` exige. As três migrations
foram verificadas **contra o banco real** (CHECK com 32 valores e `dar / dare`, 27 contas
consolidadas, 0 resíduo, RPC com `anon`/`authenticated` sem EXECUTE e `service_role` com).
Os quatro recomendados são de trilha, cobertura adjacente e um efeito colateral de write-back
que o delta abriu sem substituir a proteção que removeu.

## Achados

### 🔴 Bloqueantes

Nenhum.

### 🟡 Recomendados

- [skills/pdf-contas-pagar/scripts/extract_pdf.py:285] Sete comentários atribuem a consolidação
  `dar / dare` à **migration 134**, que é a RPC de fornecedor — a consolidação é a **133**.
  Falha:     quem investigar "por que `dar / dare` é entrada única" abre `134_find_supplier_by_email.sql`
             e encontra uma RPC de fornecedor, sem relação com o domínio; a 133 — que fez
             DROP/UPDATE/ADD do CHECK e migrou 26 contas — fica invisível. Agrava-se porque a 134
             **é** citada corretamente para o fallback 1b nos MESMOS dois arquivos: as duas
             leituras coexistem e não há como distingui-las sem abrir os `.sql`. Num projeto cuja
             regra é "migration aplicada é imutável e o histórico é a prova", a trilha aponta para
             o lugar errado.
  Evidência: ocorrências erradas em `extract_pdf.py:285,304,388`, `read_emails.py:2605,3368,3532`
             e `financial-account-control.schema.ts:34`. Contra-prova em
             `docs/db/historico-migrations.md` ("A `133` consolida `dar` e `dare`…") e no próprio
             `133_doc_type_dar_dare_consolidado.sql`, que contém o `UPDATE … SET document_type =
             'dar / dare'`. A `134` não toca `document_type`.
  Correção:  trocar 134 → 133 nas sete ocorrências que descrevem a consolidação, preservando as
             que descrevem o fallback 1b; regravar `deploy-manifest.json` (os dois `.py` viajam nele).
  Regra:     `CLAUDE.md` § Banco de dados — o histórico das migrations é a trilha de auditoria.

- [scripts/reprocess_body_emails.py:121] O dry-run do reprocessador de corpo não repassa
  `body_text`, então prevê um fornecedor diferente do que o modo real gravaria.
  Falha:     e-mail com `De:` de fornecedor cadastrado no corpo e sem favorecido extraído → o
             dry-run resolve pela regra de imposto/assunto (sk = OTIMOTEX), o run real resolve
             pelo 1b (sk = fornecedor). Como `find_financial_duplicate` casa **por `sk_supplier`**,
             o dry-run pode responder "gravaria" onde o real responde "duplicado", ou o contrário.
             O `--dry-run` é o gate de segurança obrigatório dos scripts de manutenção deste
             projeto; um dry-run que diverge do real destrói exatamente o que ele existe para dar.
  Evidência: `process_one` → `try_extract_from_body` → `_finalize_supplier(ctrl, payload, body_text)`
             (`read_emails.py:5695`), enquanto `inspect_one` chama `R._finalize_supplier(ctrl, payload)`
             — e o docstring de `inspect_one` afirma "simula o caminho real".
  Correção:  passar `body_text`, já disponível como parâmetro da própria função.
  Regra:     Passo 6 do rito — superfície adjacente do delta (a assinatura mudou aqui, não lá).

- [tests/test_supplier_imposto.py:101] O teste de anti-regressão do 1b não exercita o lookup que
  o nome dele promete — ele mede o caminho do ctrl legado.
  Falha:     o `_FakeCtrl` deste arquivo não define `find_supplier_by_email`, então o
             `getattr(ctrl, "find_supplier_by_email", None)` devolve `None` e o bloco 1b sai
             **antes de consultar**. O teste trava "ctrl sem o método", não "remetente não
             cadastrado"; o mutante que o próprio docstring declara ("o fallback 1b atribuir o
             fornecedor mesmo com o lookup devolvendo None") não é o que ele observa. Se alguém
             acrescentar o método ao fake — evolução natural — o teste muda de significado em
             silêncio e continua verde.
  Evidência: `_FakeCtrl` em `tests/test_supplier_imposto.py:22-37` define apenas `resolve_supplier`
             e `supplier_defaults`; o guard em `read_emails.py:2291` é `getattr(...)`.
             A propriedade real está coberta em
             `test_supplier_forwarded_email.py::test_email_nao_cadastrado_nao_cria_fornecedor_e_cai_na_regra_de_imposto`,
             que assere `ctrl.lookup_calls == [EMAIL_DESPACHANTE]`.
  Correção:  dar ao `_FakeCtrl` um `find_supplier_by_email` que registra a chamada e devolve
             `None`, e assertar que ele **foi** consultado (anti-vacuidade).
  Regra:     `CLAUDE.md` §2 — "Teste que promete uma garantia tem de entregá-la".

- [skills/email-reader/scripts/read_emails.py:2287] O fallback 1b remove a isenção de write-back
  que a regra de imposto garantia, e a classificação forçada pode sobrescrever a curadoria do
  cadastro de um fornecedor.
  Falha:     um contador/despachante **diferente do sk 1262**, cadastrado com e-mail e com
             classificação default curada, encaminha uma GNRE/DARE. O 1b atribui a conta a ele
             (antes ia para a OTIMOTEX); em seguida `apply_forced_classification` resolve a esfera
             estadual e devolve `write_back=True`; como o sk não é 1 nem está em
             `TAX_CLASSIFICATION_EXCLUDED_SK_SUPPLIERS`, `update_supplier_classification`
             **reescreve o default do cadastro** e todas as contas futuras dele passam a nascer
             com a classificação tributária. O comentário da própria migration 132 nomeia esse
             modo de falha: "errar ali se propaga para todas as contas futuras dele".
  Evidência: `resolve_forced_classification` (read_emails.py:3446) só pula a forçada quando
             `sk_supplier in TAX_CLASSIFICATION_EXCLUDED_SK_SUPPLIERS` (= `{1262}`);
             `apply_forced_classification` (3480) só isenta `OTIMOTEX_SK_SUPPLIER`. O caso 1101
             escapa por acidente feliz — o 1262 já estava excluído **antes** deste delta, por
             outro motivo (reembolso/honorários).
  Correção:  suprimir o `write_back` quando o fornecedor tiver vindo do 1b (sinal fraco por
             definição, é a premissa do próprio bloco) — **ou** manter e acrescentar cada
             despachante/contador novo à lista de exclusão conforme for cadastrado.
             ⏸️ Muda *o que* o sistema decide sobre classificação: decisão sua, não do revisor.

### 🔵 Opcionais

- [skills/email-reader/scripts/read_emails.py:2286] `_supplier_name_by_legal_suffix(subject)` é
  calculado no 1b e recalculado idêntico no fallback 2 (linha 2322).
- [tests/test_supplier_forwarded_email.py:381] `test_pdf_nao_passa_a_gravar_email_body_excerpt` é
  trivialmente verdadeiro — `_finalize_supplier` nunca escreveu essa coluna em caminho nenhum, e o
  caso passaria com o 1b inteiro removido.

## Pendências (trabalho incompleto)

- [progress.md:86] Guia de arrecadação lida por **Vision** não recebe `apply_arrecadacao_amount`
  nem `apply_text_due_date` — **recomendada**. Confirmado por leitura: as duas só são chamadas em
  `_build_records_text` (`extract_pdf.py:1406,1414`), e `_build_records_vision` não as invoca.
  **Exposição medida neste review:** 38 guias tributárias no acervo vieram por Vision
  (35 `pdf_vision` + 3 `docx_vision`), somando R$ 912.285,26. Das 9 que têm linha de arrecadação
  de 48 dígitos — as únicas auditáveis —, o valor gravado **confere com o valor embutido no código
  de barras em 100% dos casos** (0 divergências). O risco é estrutural e real, mas ainda **não se
  materializou**: as correções existem porque o parser de TEXTO errava, e o Vision, lendo a página
  renderizada, tem copiado o "Total a Recolher" correto. O registro no `progress.md` descreve o
  sintoma como se ele já ocorresse — vale anotar a medição ao lado.
- [progress.md:87] Fallback 3 de fornecedor (por NOME do bloco encaminhado) morto no caminho de
  PDF — **opcional**. Registro confere: ele lê `payload['email_body_excerpt']`, que
  `FINANCIAL_FIELDS` nunca povoa no caminho de anexo. Não reviver é a decisão certa (desemboca em
  `resolve_supplier`, que cria fornecedor).
- [progress.md:88] 8 guias JUCE antigas sem texto extraível não reclassificadas — **opcional**.
  Amostragem no banco: 1101 JUCEMAT → `dar / dare` ✓, 1103 JUCEPE → `dae` ✓, 1102 JUCEMS →
  `tributo` genérico (correto: JUCEMS emite GR, que não é valor do domínio), 427/428 →
  `recibo` (`pdf_vision`, coerentes com "escaneadas"). Todas pagas. Impacto nulo.
- [progress.md:55] Deploy PENDENTE — **bloqueante para produção, não para o merge**: copiar
  `read_emails.py`, `extract_pdf.py` e `deploy-manifest.json`. As migrations 132/133/134 **estão
  aplicadas** (verificado no banco). ⚠️ Se os recomendados R1/R2 forem corrigidos, os hashes mudam
  e o manifesto precisa ser regravado **antes** da cópia.

## Drift código × documentação

- `CLAUDE.md:749` enuncia o invariante 🔴 "Guia de ARRECADAÇÃO: valor = total a recolher (do
  BARCODE) e vencimento = data-limite" **sem ressalva**, mas o código só o cumpre no caminho de
  texto. A exceção existe apenas no `progress.md`, que é "verdade que expira" — o invariante é o
  lugar onde ela precisa estar. Decisão pendente: acrescentar a ressalva ao invariante ou fechar
  o defeito.
- `supabase/migrations/132_doc_type_dar.sql:26` lista `documento de arrecadacao estadual` entre as
  frases-gatilho de `dar`; a decisão final (133, código e `test_doc_type_dar.py`) a **excluiu**,
  porque é o nome por extenso do DAE em PE/CE. A 132 é artefato aplicado e imutável — não se
  edita. Decisão pendente: registrar a correção no histórico ou aceitar a divergência como parte
  do registro honesto de que a 132 foi superada em horas.

## Não coberto

- **pytest não executado** — o módulo não está instalado no `.venv` do projeto. Rodei
  `python -m unittest discover` dentro de `tests/`, que carrega a mesma suíte (1555 casos, OK),
  mas fixtures/marcadores específicos de pytest, se existirem, não foram exercitados.
- **e2e Playwright não executado** — o renderer crasha no sandbox do agente ao montar a SPA
  (limitação conhecida). Nenhuma rota nova foi criada por este delta, e a única mudança de
  frontend é uma string em `TAX_DOCUMENT_TYPES`.
- **SonarCloud não consultado** — lint local verde não garante o PR verde neste projeto.
- **Vencimento das guias por Vision não auditado** — o código de barras de arrecadação não carrega
  fator de vencimento (ao contrário do boleto), então não há oráculo independente para conferir a
  metade "data-limite" do risco residual do Vision. Só a metade "valor" foi medida.
- **A camada Vision não foi exercitada de verdade** — a análise do risco residual é por leitura de
  código e por consulta ao acervo já gravado, não por execução do caminho `pdf_vision` sobre uma
  guia real.
- **Dimensão de concorrência não aplicada** — o delta não introduz estado compartilhado nem
  transação nova; a RPC é `STABLE` e o pipeline é sequencial por e-mail.

---

# Adendo — resolução dos itens não corrigidos (2026-08-19, mesma sessão)

A pedido do usuário ("resolver não corrigidos com robustez de código"), os quatro itens que o
review havia deixado abertos foram fechados. Este bloco é acrescentado ao relatório; o texto
acima **não** foi reescrito — ele descreve o estado encontrado.

## R4 — write-back sobre curadoria: fechado de forma estrutural

O achado era condicional (dependia de um despachante **≠ 1262** ser cadastrado), e a proteção que
existia — `TAX_CLASSIFICATION_EXCLUDED_SK_SUPPLIERS` — é uma **allowlist reativa**: só protege quem
alguém já descobriu e cadastrou à mão. A correção fecha a **classe**, não o caso:

| Elo | Onde | O quê |
|---|---|---|
| marca | `read_emails.py:2342` (fallback 1b) | grava `_supplier_signal = 'forwarded_email'` |
| decisão | `read_emails.py:3540` (`apply_forced_classification`) | `_is_weak_supplier_signal` ⇒ **suprime o write-back**; a CONTA ainda é classificada |
| limpeza | `read_emails.py:606` (`register_financial`) | `strip_transient_fields` remove as chaves `_`-prefixadas **na fronteira de gravação** |

Três decisões de desenho, cada uma contra um modo de falha concreto:

- **Conjunto (`SUPPLIER_SIGNAL_WEAK`), não booleano** — a próxima procedência fraca entra no
  conjunto, não num `if` novo espalhado pela função.
- **Strip genérico por PREFIXO, não por lista de nomes** — `register_financial` serializa o payload
  **inteiro**; uma allowlist de nomes falharia justamente na chave efêmera nova, e o sintoma seria
  a **conta parar de ser gravada** (PGRST204), não uma linha errada.
- **Ponto único na fronteira** — a limpeza não depende de nenhum call site lembrar dela. Foi o
  critério que descartou o desenho alternativo (`pop` em cada caminho).

Verificado que `register_financial` é o **único** ponto que serializa o payload da conta: os outros
`json.dumps(payload)` do arquivo pertencem a `email_control`, `attachment` e `fiscal_document`, e
`update_financial` recebe dicts montados pelo chamador.

## Porta lateral encontrada ao corrigir (não estava no review)

`scripts/reprocess_classification_overrides.py` varre **todas** as contas e faz write-back
chamando `resolve_forced_classification` **direto** — sem passar por `apply_forced_classification`,
portanto sem a supressão. E a marca é efêmera: o script não tem como saber que o fornecedor daquela
conta veio do encaminhador.

Não inventei heurística para adivinhar procedência a partir da conta gravada. A correção é de
**visibilidade**: `apply_supplier_writebacks` agora lê a classificação atual do cadastro e marca
com `[SOBRESCREVE]` — com valor antigo → novo — todo write-back que destrói curadoria existente. O
aviso aparece no `--dry-run`, que é o gate obrigatório do script. Curadoria destruída em silêncio
era o risco; uma linha que o operador lê antes de confirmar transforma isso numa decisão.
Exercitado: cadastro com curadoria divergente avisa; sem curadoria (0/0) ou já igual, não avisa.

## O1, O2 e os dois drifts

- **O1** — `_supplier_name_by_legal_suffix` deixou de ser chamada duas vezes; o fallback 2 reusa
  `_subject_anchor`/`_subject_has_anchor` já computados para a guarda do 1b. Seguros: derivam só de
  `payload["subject"]`, que nenhum bloco entre os dois pontos altera.
- **O2** — `test_pdf_nao_passa_a_gravar_email_body_excerpt` passou a observar a **consequência**: o
  corpo carrega telefone e chave PIX, e o teste prova que `apply_contact_writeback` rodou e **não**
  os gravou; com o corpo passado explicitamente, o mesmo texto **grava** (anti-vacuidade do
  oráculo). Antes era um `assertNotIn` trivialmente verdadeiro.
- **Drift 1** — o invariante da guia de arrecadação no `CLAUDE.md` ganhou a ressalva do Vision **com
  a medição** (0 divergências), substituindo o trecho em vez de empilhar. O `progress.md` passou de
  "defeito conhecido" para "risco estrutural — 0 ocorrências medidas", com a população e o limite
  ("a metade vencimento não é auditável").
- **Drift 2** — a migration 132 é imutável e **não** foi editada. O `docs/db/historico-migrations.md`
  ganhou um aviso explícito de que o comentário dentro dela está desatualizado quanto a
  `documento de arrecadacao estadual`, e de que a decisão válida é a do histórico.

## Validação por mutante

Nenhuma correção foi dada por boa sem instalar o defeito e ver o vermelho. Todos revertidos e a
reversão confirmada por `diff -q`:

| Mutante | Efeito esperado | Resultado |
|---|---|---|
| `if False` no lugar de `_is_weak_supplier_signal` | write-back volta para sinal fraco | 🔴 2 falhas |
| `dict(payload)` no lugar de `strip_transient_fields` | marca vaza para o PostgREST | 🔴 3 falhas |
| `payload["email_body_excerpt"] = body_text` no 1b | corpo vaza para o contact writeback | 🔴 1 falha |
| `lookup = None` em `_finalize_supplier` | 1b nunca consulta | 🔴 1 falha (passava verde antes de R3) |

## Gates

```
Suíte Python:  1567 (+12 desde o baseline de 1555) · OK
Vitest:        1596 — 620 + 921 + 2 + 53 · OK
               ⚠️ os 2 casos do AiChatWidget falham em paralelo e passam com --maxWorkers=1
               (24/24). Nenhum arquivo de frontend foi tocado nesta rodada.
typecheck OK · lint 0/0 · ts-prune 0 · test_doc_links 10 OK · paridade 32/32
CLAUDE.md: 1134 linhas, teto 1400 — saldo de 266
```

## O que continua fora

- **A correção do Vision** (aplicar `apply_arrecadacao_amount`/`apply_text_due_date` no caminho
  visual) segue **não feita** — é trabalho novo, não conserto, e a medição mostra 0 ocorrências.
  Agora está registrada com número em vez de adjetivo.
  → ✅ **Feita em 2026-08-20**, na sessão seguinte; ver o adendo abaixo.
- **Nada foi commitado.**

---

# Adendo 2 — a correção do Vision, feita (2026-08-20)

O último item aberto foi fechado a pedido do usuário ("resolver de forma completa a correção do
vision com robustez técnica nos códigos e nas estruturas"). Não é conserto de defeito observado —
a medição acima continua valendo (0 divergências em 9 guias auditáveis); é **fechar a classe**
antes que ela apareça.

## O que mudou

| Elo | Onde | O quê |
|---|---|---|
| simetria | `extract_pdf._build_records_vision` | o ramo Vision deixou de ser código inline no dispatcher e virou a contraparte nomeada de `_build_records_text` |
| valor | mesmo builder | `apply_arrecadacao_amount(rec, ocr_barcode=True)` |
| vencimento | `apply_arrecadacao_deadline` | **fonte única** da decisão, gated pelo barcode; usada também pelo caminho de texto, que passou a delegar |
| procedência | `EXTRACTION_PROMPT` | campo novo `payment_deadline` — o modelo **transcreve**, o código decide |
| precedência | `build_records(..., doc_text=)` | texto real (tier 2, página espelhada) vence o campo do modelo |
| 2ª barreira | `febraban.arrecadacao_value_refuted` | total ≥10× o valor lido ⇒ não sobrescreve e **anota** |
| validação | `extract_pdf._iso_date` | data vinda do modelo é validada antes de virar `due_date` |
| lacuna adjacente | `build_record_from_json` | tupla literal → `VISION_SOURCES`, incluindo `docx_vision` no gate `barcode_self_refuted` |

Três decisões de desenho, cada uma contra um modo de falha concreto:

- **Guarda de OCR em UMA direção só.** Refutar o barcode 10× *menor* preservaria o número do LLM
  e gravaria **a menor** — o estrago original (27 GNRE, R$ 297,17). A assimetria é a regra.
- **`payment_deadline` fora do `rec`.** Consumido do item JSON no builder; se entrasse no
  registro, o PostgREST recusaria o INSERT (PGRST204) e a conta deixaria de ser gravada.
- **A instrução do `due_date` no prompt permanece.** Sem barcode não há gate; ela é a rede da
  guia cujo código não foi lido.

## Validação por mutante — 7, todos vermelhos, todos revertidos (`diff -q` limpo)

| Mutante | Resultado |
|---|---|
| remover `apply_arrecadacao_amount` do builder Vision | 🔴 5 falhas |
| remover `apply_arrecadacao_deadline` do builder Vision | 🔴 6 falhas |
| `if False` no gate `arrecadacao_44` do applier | 🔴 4 falhas |
| `return False` em `arrecadacao_value_refuted` | 🔴 3 falhas |
| `_iso_date` devolvendo a string crua | 🔴 10 falhas |
| tupla literal de volta em `build_record_from_json` | 🔴 1 falha |
| `apply_text_due_date` com cópia própria da regra | 🔴 1 falha |

⚠️ **Um teste meu passou pelo motivo errado e o próprio caso o denunciou:** o fator do
`BOLETO_BANCARIO` da fixture decodifica em **2026-07-31** — a mesma data-limite da guia —, então
"boleto ignora a data-limite" ficaria verde por coincidência. O caso passou a usar uma data alheia
às duas.

## Gates

```
Suíte Python:  1593 (+26 sobre o baseline de 1567) · OK
paridade:      32/32, exit 0 (manifesto regravado; febraban.py entrou na lista de cópia)
```

**Deploy segue pendente e é manual, do usuário.** A lista de cópia mudou: `febraban.py` **antes**
de `extract_pdf.py` (import no topo — módulo ausente estoura e nenhum PDF é extraído), depois
`read_emails.py`, e o `deploy-manifest.json` por último.

**Nada foi commitado.**

---

# Adendo 3 — o risco residual que o próprio conserto do Vision deixou (2026-08-20)

A pedido do usuário ("resolver Riscos residuais do vision — faça uso de robustez no código").
O Adendo 2 fechou a **simetria** das duas regras da guia entre texto e Vision, mas fechou as
duas metades com **proteções desiguais**, e o próprio relatório nomeia o motivo em "Não
coberto": *"o código de barras de arrecadação não carrega fator de vencimento, então não há
oráculo independente para conferir a metade data-limite. Só a metade valor foi medida."*

| Metade da regra | Procedência no Vision | Proteção antes desta rodada |
|---|---|---|
| **valor** | código de barras (OCR dos próprios dígitos) | DV geral + `arrecadacao_value_refuted` (≥10× ⇒ recusa e anota) |
| **vencimento** | `payment_deadline` **transcrito pelo modelo** | `_iso_date` — validação de **forma**, e só |

Onde nada de fora confere o número é exatamente onde o código precisa se julgar por coerência
interna. Reproduzido **antes** de escrever qualquer correção, com a fixture real da GNRE 773:

```
modelo diz '31/07/2016' -> due_date gravado: 2016-07-31
modelo diz '2126-07-31' -> due_date gravado: 2126-07-31
modelo diz '2027-07-31' -> due_date gravado: 2027-07-31
```

O caso de **2126** é o pior e não é simétrico ao do valor: a conta **nunca vence** — some do
grid de vencimentos, do aging, dos KPIs e da cobrança de vencidos, sem erro, sem linha em
`/erros` e sem teste vermelho. É a mesma classe de "erra para menos e parece completo" que o
relatório principal descreve.

## O que mudou

| Elo | Onde | O quê |
|---|---|---|
| forma | `extract_pdf._iso_date` | resto depois dos 10 chars precisa ser separador de hora — `31/07/20260` deixou de virar `2026-07-31` |
| coerência | `extract_pdf.arrecadacao_deadline_refuted` | cruza a data-limite com o vencimento que o modelo leu do **mesmo documento**; teto **180 dias** |
| decisão | `extract_pdf.apply_arrecadacao_deadline(..., doc_due_date=)` | recusa ⇒ **preserva** o vencimento do documento e **anota** em `processing_notes` |
| procedência | `_build_records_vision` | a contraprova segue a **origem da data**, não o call site: a do TEXTO entra sem cruzamento |

Cinco decisões de desenho, cada uma contra um modo de falha concreto:

- **Referência = a data do DOCUMENTO, não "hoje".** Usar a data de extração refutaria a data
  certa num reprocessamento histórico — a armadilha já documentada em `apply_text_due_date`,
  que foi o motivo de o `_due_date_plausible` não valer para guia. Sem `due_date` lido, não há
  referência a inventar: a data entra ("não há o que refutar", semântica da família `*_refuted`).
- **Duas direções**, ao contrário da guarda de valor. Lá a assimetria é obrigatória (refutar o
  outro lado preservaria o número do LLM, que é o estrago original); aqui a recusa preserva a
  data do documento nos dois sentidos, então nenhuma direção é perigosa.
- **Opt-in pela PROCEDÊNCIA.** No builder visual a data-limite tem duas origens; a do texto é
  determinística. Colapsá-las numa chamada só com contraprova fixa é o refactor natural — e o
  mutante 7 mostra que ele quebra o caso da página espelhada / tier 2.
- **Referência por ITEM.** Num carnê, parcelas a meses de distância julgadas contra a data da
  primeira seriam refutadas em bloco.
- **O teto é medido, não escolhido.** Folga real entre data-limite e vencimento do tributo:
  **0–3 dias** (31 guias, medição já registrada no código). Acervo inteiro consultado nesta
  rodada: **988 contas, ZERO** com `due_date` a mais de 180 dias da extração; nas 38 guias por
  Vision, **−11 a +16 dias**. O teto é ~60× a folga e ~11× o extremo observado. E o que ele
  **não** cobre está declarado: erro de mês/dia (≤31 dias) não é separável de validade longa
  legítima, com teste travando a afirmação.

## Validação por mutante — 8, todos vermelhos, reversão confirmada byte a byte

| Mutante | Resultado |
|---|---|
| applier ignora a contraprova | 🔴 4 falhas |
| predicado sempre devolve `False` (guarda inerte) | 🔴 5 falhas |
| guarda de uma direção só (copiando a de valor) | 🔴 4 falhas |
| teto afrouxado para 100 anos | 🔴 4 falhas |
| teto apertado para 30 dias (crendo pegar erro de mês) | 🔴 2 falhas |
| `_iso_date` de volta ao parse por prefixo | 🔴 4 falhas |
| call site colapsado (contraprova fixa nas duas procedências) | 🔴 1 falha |
| referência compartilhada entre itens | 🔴 1 falha |

⚠️ **Dois casos meus passaram VERDES na primeira montagem do placar** e foram reescritos — é o
motivo de o rito existir:

- *"sem vencimento lido, a data-limite ainda entra"* usava uma guia **recente**, que cabe no
  teto de 180 dias mesmo com a referência caindo para *hoje*. Passou a usar uma guia de **300
  dias** atrás, derivada de `today()` para não envelhecer em literal.
- *"com N pagáveis cada item cruza com o próprio vencimento"* usava parcelas a **dias** uma da
  outra, em que a referência compartilhada dá o **mesmo** veredito. Passou a usar parcelas a
  **352 dias**, com uma terceira de ano corrompido para provar que a recusa cai no item certo.

## Gates

```
Suíte Python:  1608 (+14 sobre 1593) · OK   ·   test_arrecadacao_gnre: 71 casos
paridade:      32/32, exit 0 (manifesto regravado — extract_pdf.py mudou)
test_doc_links 10 OK    ·   CLAUDE.md: 1151 linhas, teto 1400 — saldo de 249
```

Frontend/TS não foram tocados nesta rodada (mudança é Python-only: `extract_pdf.py` e o teste).

## O que continua fora

- **A camada Vision segue não exercitada contra a API real** — o `VisionWiringTest` executa
  `process_pdf` e `_extract_records` de ponta a ponta, mas com a resposta do modelo dublada.
  Exercitar de verdade exige uma guia real e chamada paga; a contraprova desta rodada existe
  justamente porque essa verificação não é rotineira.
- **A metade "vencimento" continua sem oráculo EXTERNO** — nenhum código de arrecadação carrega
  fator de vencimento. O que mudou é que ela deixou de depender só da boa-fé da transcrição.
- **Deploy segue pendente e é manual, do usuário.** Ordem inalterada: `febraban.py` →
  `extract_pdf.py` → `read_emails.py` → `deploy-manifest.json`.

**Nada foi commitado.**
