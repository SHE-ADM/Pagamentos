# Roadmap — Enriquecimento de dados e ampliação analítica

> **Criado em:** 2026-07-31
> **Escopo:** ampliar a acurácia e a gama de perguntas do chat de IA (`docs/arquitetura-chat-ia-pagamentos.md`)
> sem quebrar o pipeline de extração de e-mails nem as operações já em produção.
> **Execução:** **uma onda por vez**, com o protocolo de verificação da seção 3 cumprido em cada uma.

---

## 1. Princípio ordenador

As ondas estão ordenadas por **dependência e risco**, não por atratividade:

1. **Destravar** o dado que já está gravado e o chat não alcança.
2. **Parar de perder** informação que chega e é descartada hoje.
3. **Recuperar** o que é jogado fora por decisão de negócio (documento fiscal).
4. **Derivar** campos novos a partir do que existe.
5. **Governança**, **hardening** e, por fim, o que depende de evidência futura.

Cada onda entrega valor sozinha e **não depende da seguinte** — é o que permite parar em qualquer
ponto sem deixar trabalho pela metade.

**Regra transversal:** nada chega ao usuário sem uma **tool** que o exponha. O modelo só enxerga o
que pode chamar; tabela ou coluna nova sem tool não amplia a gama de perguntas em nada.

---

## 2. Diagnóstico medido (2026-07-31)

Todos os números abaixo foram medidos no banco de produção nesta data. Eles são a **justificativa
de cada onda** — e o motivo de algumas ideias terem sido descartadas.

### 2.1 Performance — por que NÃO haverá tabelas agregadas

| Função (tool) | Warm | Cold |
|---|---|---|
| `resumo_situacao` | **3,1 ms** | 85 ms |
| `gasto_por_fornecedor` (todo o período) | **4,2 ms** | 26 ms |
| `gasto_por_periodo` | 5,5 ms | — |
| `listar_contas` | 7,4 ms | — |
| `aging_vencidos` | 23 ms | — |
| `gasto_por_classificacao` | 25 ms | — |

- Tabela fato: **609 contas / 2,4 MB** — cabe inteira em memória.
- Latência real das perguntas em produção: **8.307 a 30.147 ms**.
- **O SQL responde por 0,04% a 0,3% do tempo.** O restante é a Claude API.
- Crescimento medido: **192 contas em junho, 417 em julho** (~5.000/ano).

> Zerar 100% do tempo de banco transformaria uma resposta de 19 s em 19 s. **O gargalo é o modelo,
> não o dado.**

### 2.2 Cobertura — o que o chat NÃO alcança

`analytics.vw_payables` expõe **26 colunas**; `financial_account_control` tem **42**.

**Ausentes da view (dado gravado e inalcançável pelo chat):**
`has_invoice` · `has_bank_slip` · `fine_interest` · `discount` · `other_additions` ·
`other_deductions` · `extraction_source` · `created_by` · `updated_by` · `status_changed_by`

### 2.3 Informação perdida ou descartada

| Indicador | Valor |
|---|---|
| E-mails registrados | 1.133 |
| **Ignorados (nenhum dado estruturado)** | **545 — 48% da caixa** |
| Ignorados **com anexo baixado** | 224 |
| Ignorados que são **CT-e / transporte** | **180 — 172 (96%) com anexo** |
| Ignorados NF-e / NFS-e | 31 (13 com anexo) |

**Documentos fiscais por tipo — o que dimensiona as Ondas 3 e 4:**

| Tipo | E-mails | Com PDF | Chave de acesso 44 díg.? |
|---|---|---|---|
| **CT-e** | 169 | 172 | ✅ modelo **57** |
| **NF-e** (+ "nota fiscal" genérico) | 48 | **33** | ✅ modelo **55** |
| **NFS-e** | 10 | **4** | ❌ **municipal — não tem chave nacional** |
| **CF-e / NFC-e / cupom fiscal** | **1** | **0** | ✅ modelos **59 / 65** (sem volume hoje) |
| Cupom fiscal **não** eletrônico | 0 | 0 | ❌ papel térmico, sem estrutura |
| `body_preview` — teto de 500 chars | **439 de 1.133 (39%) truncados** — *refinado para **440** na medição por caminho da §7.2, que é a que vale* |
| `email_body_excerpt` (só quando vira conta) | média 918, máx 11.449 chars |
| Anexos: **XML** / PDF | **0** / 662 (de 679) |

> **Não há um único XML.** CT-e e NF-e chegam só como PDF (DACTE/DANFE) — não existe o caminho
> fácil de parse canônico.

### 2.4 Completude e qualidade do dado

| Indicador | Valor |
|---|---|
| `competence_date` preenchido | **84 de 609 (14%)** — e a coluna é **TEXT**, não DATE |
| Sem centro de custo ou plano (id 0) | **69 (11%)** |
| Forma de pagamento indefinida | 61 (10%) |
| Com código de barras | 350 (57%) |
| **Boleto sem nota fiscal** | **169** (contra 135 com ambos) |
| Com juros/multa | 11 |
| Com desconto | 2 |
| `amount_charged` ≠ `amount` | 16 (2,6%) |
| Nº de documento com sufixo de parcela | 12 |
| Fornecedores recorrentes (≥3 meses) | **11 → 150 contas (25% da base)** |
| Desses, com **valor** estável (<20% variação) | apenas **3** |
| Contas bancárias cadastradas | **1** |
| `audit_log` | existe, **0 linhas** |

### 2.5 O achado que bloqueia a métrica de DPO

| Indicador | Valor |
|---|---|
| Contas pagas | 463 |
| **Com `payment_date` ≠ `due_date`** | **13** |
| Janela desses pagamentos reais | **29 a 30/07/2026** |

> A migration **096** fez backfill adotando `due_date` como data de pagamento. Logo **450 de 463
> (97%)** das pagas têm "pagamento exatamente no vencimento" **por artefato**, não por pontualidade.
> Só existem **2 dias** de histórico real. Calcular DPO hoje devolveria *"atraso médio zero"* —
> confiantemente falso.

---

## 3. Protocolo de execução por onda (obrigatório)

Objetivo: **nenhuma onda pode quebrar a extração de e-mails, as 4 rotinas agendadas, o CRUD ou o
chat já em produção.** Cumprir os 5 passos em cada onda, na ordem.

### Passo 1 — Baseline ANTES de alterar

```powershell
npm test                 # todos os workspaces
npm run lint             # 0 erros e 0 warnings
npm run typecheck
npm run prune            # deve reportar 0
py -3 -m pytest tests/ -q   # 776 testes do pipeline
```

Sem baseline verde não há como provar regressão depois. **Registrar a contagem de testes.**

### Passo 2 — Migration idempotente + verificação no banco

- `IF NOT EXISTS` / `CREATE OR REPLACE`; nunca editar migration já aplicada.
- Aplicar via Supabase MCP ou psql (ver `apply-migration-via-psql` na memória).
- **Verificar no catálogo** o efeito real (coluna, policy, grant), não confiar no "sucesso" do DDL.
- Rodar `get_advisors` após qualquer DDL — barato e pega RLS/`SECURITY DEFINER` esquecidos.

> ⚠️ **A Supabase é compartilhada entre dev e produção.** Toda migration vale para os dois no ato.

### Passo 3 — Não regredir o pipeline Python

Só quando a onda tocar `skills/`:

```powershell
py -3 -m pytest tests/ -q                                    # suíte completa
py -3 skills\email-reader\scripts\read_emails.py --dry-run    # IMAP + Supabase, sem gravar
py -3 scheduler\check_deploy_parity.py --update               # regravar manifesto no MESMO commit
```

### Passo 4 — Verificação funcional da onda

- As tools novas/alteradas respondem (chamada direta por SQL antes de ir ao chat).
- **Oráculo diferencial:** a tool e uma query de controle equivalente devolvem o mesmo valor.
- **Nunca** assertar número absoluto — o dado deriva em 24 h (o pipeline roda a cada 5 min).

### Passo 5 — Fechamento

- Suíte verde novamente + autorrevisão adversarial ("o que quebra isto?").
- Atualizar `CLAUDE.md` e a seção 7 deste documento.
- **Deploy em produção do pipeline é manual, pelo usuário** — entregar o passo de cópia + comando
  de validação; nunca executar remotamente.

### Critério de PARADA

Se qualquer passo falhar de forma não trivial: **parar e replanejar**, não seguir empurrando. A
onda seguinte não começa com a anterior incompleta.

---

## 4. As ondas

> A numeração de migration abaixo é **indicativa**. A próxima livre em 2026-07-31 é a **103**; a
> numeração final segue a ordem real de aplicação.

### ONDA 1 — Destravar o dado que já existe

**Por quê:** o chat não alcança 16 colunas já gravadas. Nenhuma extração, trigger ou LLM envolvido.

| Item | O quê | Migration |
|---|---|---|
| 1.1 | `vw_payables` expõe `has_invoice`, `has_bank_slip`, `fine_interest`, `discount`, `other_additions`, `other_deductions`, `extraction_source` | 103 |
| 1.2 | Filtros de compliance nas tools (`listar_contas`, `gasto_por_fornecedor`) | 104 |
| 1.3 | Sugestões do painel: 9 do Grupo 1 + 5 do Grupo 2 (seção 6), agrupadas por tema | — |
| 1.4 | Bateria de regressão sobre as sugestões (**cobre o item "testes de regressão" da Fase 4**; rate limit e few-shot seguem na Onda 8) | — |
| 1.5 | 🟠 **Rate limit no `/api/ai-chat`** — promovido da Onda 8 pela auditoria | — |
| 1.6 | 🎯 **Eixo `tipo` (Fixa / Variável / Custo de Mercadorias)** em `gasto_por_classificacao`: `p_group_by = 'tipo'` + filtro `p_subgroup_type_ids` | 104 |
| 1.7 | 🎯 **Tool `demonstrativo_despesas(...)`** — a estrutura de custos e despesas do período | 104 |

> **Por que o rate limit foi promovido:** é o **único item do plano com risco financeiro em aberto
> hoje** — não há teto de custo por usuário/sessão na Claude API. Deixá-lo na penúltima onda
> significaria conviver com essa exposição por todo o roadmap. É barato, independente de qualquer
> outra onda e não toca em banco.

#### 🎯 Foco de auditoria 1 — Despesas fixas × variáveis (itens 1.6 e 1.7)

O dado **já existe e está populado** — a classificação vive no **subgrupo**
(`chart_subgroup_type_id`, migrations 092/093) e a `vw_payables` já a expõe:

| Tipo | Contas | Valor |
|---|---|---|
| Custos de Mercadorias | 156 | R$ 3.014.127 |
| Despesas Fixas | 219 | R$ 1.445.576 |
| Despesas Variáveis | 101 | R$ 1.759.528 |

**A lacuna estava só na tool:** `gasto_por_classificacao` aceitava `p_group_by` =
`centro_custo | plano_contas | grupo | subgrupo` — **sem `tipo`** —, e `p_nature_ids` filtra a
natureza do **grupo** (Despesas/Custo), não o tipo do **subgrupo**. Resultado: o
`/dashboard_despesas` mostrava o gráfico, mas o **chat não conseguia responder** *"quanto foi
despesa fixa vs. variável?"*. Item 1.6 fecha isso.

#### 🎯 Foco de auditoria 2 — "Demonstrativo de Custos e Despesas" (decisão: opção B)

**DRE completo NÃO é possível e foi descartado** (ver seção 5): o sistema tem **0 receitas** — é
contas a pagar. Chamar de "DRE" algo sem receita repetiria o defeito do DPO: número com o nome de
uma coisa que ele não é.

O que a tool 1.7 entrega é a **metade que existe, íntegra e auditável** — com os tributos em
**linha própria**, resolvendo a questão sem obrigar escolha entre visão contábil e visão de caixa:

```
Custos de Mercadorias ................. R$ 3.014.127
Despesas Fixas ........................ R$ 1.445.576
Despesas Variáveis .................... R$ 1.759.528
Tributos (passivo tributário) ......... R$ 2.214.143   ← linha SEPARADA
Não classificado ...................... R$   421.596
──────────────────────────────────────────────────────
Total de saídas ....................... R$ 8.854.971
```

**Por que os tributos ficam numa linha à parte, e não dentro de "despesas":** os R$ 2,2M estão em
subgrupos de **Passivo Tributário** (Tributos sobre Importação, sobre Vendas a Recolher, Federais,
Obrigações Acessórias) e **não ter tipo fixa/variável é contabilmente correto** — tributo a
recolher é passivo, não despesa do período. Mas o `/dashboard_despesas` filtra só natureza
`Despesas` e `Custo`, então hoje esse dinheiro **fica invisível** ali. Numa auditoria, alguém vai
perguntar onde ele foi parar. A linha própria preserva a semântica contábil **e** fecha o caixa.

> ⚠️ **A linha "Não classificado" é obrigatória na saída.** Um demonstrativo que omite o que não
> soube classificar deixa de fechar com o total — e um número que não fecha destrói a confiança em
> todos os outros. Hoje são **64 contas / R$ 416.379** sem plano de contas, mais **R$ 5.217** de
> Publicidade e Propaganda (a única lacuna real de classificação encontrada).

**Detalhes de implementação verificados na 3ª auditoria (não improvisar):**

- **A linha "Tributos" sai da NATUREZA do grupo (`chart_group_nature_id = 4`), nunca de ids de
  subgrupo hardcoded.** Verificado no banco: **todo** o Passivo é "Passivo Tributário" — 40 contas,
  **R$ 2.214.143,31**, batendo exatamente com a linha do demonstrativo. Hardcodar os 4 subgrupos
  (52, 53, 54, 55) quebraria silenciosamente quando o cadastro mudasse.
- **A `vw_payables` expõe `chart_subgroup_type_id` (o id), não o nome.** Para rotular "Despesas
  Fixas"/"Variáveis"/"Custos de Mercadorias", a função precisa de **JOIN com
  `public.financial_type_group`**. Verificado que isso funciona sob `SECURITY INVOKER`: a tabela
  tem RLS ativo, **policy para `authenticated` e `GRANT SELECT`** — a função não retornará vazio.
  (Alternativa: expor `chart_subgroup_type_name` na view no item 1.1.)

**Destrava:** 169 boletos sem NF · juros/multa (11) · descontos (2) · cobrado ≠ documento (16) ·
**despesas fixas × variáveis** · **demonstrativo de custos e despesas**.
**Risco:** baixo — `CREATE OR REPLACE VIEW` aditivo; nenhuma coluna existente muda.
**Atenção:** a view é `security_invoker = true` — **não alterar**, é o que faz a RLS valer no chat.
**Esforço:** P.

---

### ONDA 2 — Parar de perder o corpo dos e-mails

**Por quê:** perda **ativa** — 39% dos corpos já estão truncados em 500 chars.

| Item | O quê | Migration |
|---|---|---|
| 2.1 | `email_control.body_full` + `tsvector` gerado + índice GIN | 105 |
| 2.2 | Reader grava o corpo completo — **dois pontos de truncamento** (`register` e `process_message`) | — |
| 2.3 | ❓ **Decisão:** passar a guardar o corpo do e-mail **ignorado por falta de keyword** | — |
| 2.4 | Tool `buscar_emails(termo, período, remetente)` | 106 |
| 2.5 | 📦 **Deploy em produção** — `read_emails.py` + `check_deploy_parity.py --update` | — |

#### ⚠️ O e-mail ignorado por falta de keyword hoje NÃO tem corpo algum (achado da auditoria)

`_register_ignored` grava o e-mail **sem nenhum corpo** — nem `body_preview`. O próprio código
declara: `"has_attachment": None,  # desconhecido — não baixamos o corpo`.

Consequência: a Onda 2, sozinha, melhora apenas os e-mails que **passam pelo filtro de keyword**.
Os **545 ignorados** (48% da caixa) continuariam sem texto pesquisável — inclusive os **259** da
categoria "outros", que é justamente onde mora o conteúdo que ninguém classificou.

**Decisão do item 2.3 — RESOLVIDA em 2026-07-31: opção A (só remover o truncamento).**

> ⚠️ **A recomendação original desta seção era "B", e estava errada** — baseada na premissa de que
> o corpo já viria barato ("texto puro"). Medido no código antes de implementar, o mecanismo real é
> outro: no loop o reader faz `BODY.PEEK[HEADER.FIELDS (...)]` (4 headers, leve) e só
> `process_message` faz `(INTERNALDATE RFC822)` — **a mensagem inteira, com anexos**. Trazer o corpo
> do e-mail sem keyword exigiria um FETCH completo por mensagem, baixando anexo junto (224 dos
> ignorados têm anexo).

E os números também estavam mal atribuídos. O quadro real:

| Caminho | E-mails | Com corpo | **Truncados** |
|---|---|---|---|
| **B — processado** (passou pela keyword) | 884 | 823 | **440** |
| **A — sem keyword** (`_register_ignored`) | **251** | **0** | 0 |

Os **440 truncados estão TODOS no caminho processado** — remover o teto de 500 chars resolve
**100% da perda medida**, com custo zero de IMAP. Os 251 sem corpo são e-mails que não casaram
nenhuma keyword, ou seja, **não-financeiros por definição**: cobri-los custaria um FETCH completo
por mensagem e traria PII de comunicação interna/pessoal, em troca de busca textual sobre material
fora do domínio do produto.

*(Nota: os "545 ignorados sem corpo" citados na seção 2.3 do diagnóstico misturavam dois grupos —
545 é o total de `status='ignorado'`, que inclui os ignorados **por regra de negócio**, e esses têm
corpo porque passaram por `process_message`.)*

**Truncamento em dois lugares** — ambos precisam mudar: `SupabaseControl.register`
(`(rec.get("body_preview") or "")[:500]`) e `process_message` (`body_text[:500]`).

**Backfill:** **impossível** para os 440 truncados — o texto só existe no IMAP. Reprocessáveis
apenas os que ainda estiverem na caixa. **É o motivo de esta onda vir cedo.**
**Atenção:** corpo integral carrega **PII**; a RLS da migration 078 já recorta `email_control` por
remetente para grupo restrito — validar que continua valendo com a coluna nova.
**Esforço:** P–M.

---

### ONDA 3 — Documentos fiscais: camada 1 (chave de acesso, sem LLM)

**Por quê:** 172 DACTEs + 33 DANFEs baixados, guardados no bucket, **zero** dado estruturado.

**Cobertura: todo documento fiscal com chave de acesso de 44 dígitos** — CT-e (57), NF-e (55),
CF-e-SAT (59) e NFC-e (65). O parser **não filtra por modelo**: aceita qualquer modelo válido e
grava o que encontrar. É isso que faz NF-e e CF-e entrarem com **custo marginal ≈ zero** depois que
o CT-e estiver implementado — muda apenas a leitura de 2 dígitos.

| Item | O quê | Migration |
|---|---|---|
| 3.1 | Tabela `fiscal_document` — **append-only e imutável** (coluna `model` discrimina 55/57/59/65) | 107 |
| 3.2 | Parse **determinístico** da chave de 44 dígitos, reusando `febraban.py` | — |
| 3.3 | Reader grava **no e-mail `ignorado`**, antes do descarte da conta | — |
| 3.4 | 🔴 **Atualizar `scripts/purge_orphan_attachments.py`** para preservar objeto referenciado por `fiscal_document` | — |
| 3.5 | Backfill dos documentos cujo PDF ainda existe no bucket | — |
| 3.6 | Tool `documentos_fiscais(...)` | 108 |
| 3.7 | ✅ **Deploy em produção (01/08, verificado 27/27)** — `fiscal_key.py` (novo) + `extract_pdf.py` + `read_emails.py`, os **três juntos**, **mais o `deploy-manifest.json`**; `--update` no mesmo commit | — |

#### ⚠️ 3.4 é BLOQUEADOR — sem ele a purga destrói o trabalho desta onda

`purge_orphan_attachments.py` considera **órfão** todo objeto não referenciado por
`financial_account_attachment.storage_key` **ou** `financial_account_control.source_file`.
Ele **não conhece** `fiscal_document`. Rodado após esta onda, apagaria exatamente os PDFs de CT-e e
NF-e recém-registrados — de forma **irreversível**, reportando "órfãos removidos" com naturalidade,
sem nenhum sinal de erro.

O item 3.4 **precisa entrar junto da 3.1**, não depois.

> ✏️ **Corrigido em 2026-08-01 (execução, achado O9):** este parágrafo dizia que o 3.4 "é arquivo de
> deploy (`scripts/`), portanto exige `--update`". **Não é** — `DEPLOY_GLOBS` cobre
> `skills/*/scripts/*.py` e `scheduler/*.ps1`; `scripts/` fica de fora, e a purga roda da máquina de
> desenvolvimento. Quem exigiu `--update` foi o **`fiscal_key.py`** (arquivo NOVO em `skills/`), e
> com ele entraram no manifesto também o `extract_pdf.py` (reexport) e o `read_emails.py` — os
> **três** do item 3.7. Ver o bloco DEPLOY 2026-08-01 do `CLAUDE.md`: copiar o `extract_pdf.py` sem
> o `fiscal_key.py` derruba **toda** a extração de PDF (`ModuleNotFoundError`, verificado por
> mutante).

#### ⚠️ O backfill alcança bem menos do que os 172 CT-e

Medido em 2026-07-31 — a purga executada em **15/07/2026** (571 → 236 objetos) já levou a maior
parte dos PDFs:

| | Quantidade |
|---|---|
| CT-e ignorados com anexo | **172** |
| Recebidos **antes** da purga | 117 |
| Recebidos **depois** da purga | 55 |
| **Com PDF ainda no bucket** | **57 (33%)** |
| Objetos órfãos hoje no bucket | 138 (de 483 no total) |

Os **~115 restantes** só são recuperáveis pelo **IMAP**, via `reprocess_message.py --message-id`
(que rebusca a mensagem original) — e apenas enquanto ainda estiverem na INBOX. Decidir no início
da onda se vale o custo, ou se o backfill se limita aos 57 e o valor vem do fluxo daqui para a
frente.

> **Lição:** cada dia sem a Onda 3 é PDF fiscal que a próxima purga pode levar. É um argumento
> para não deixá-la para depois — mas **não** para pular a Onda 1, que é mais barata e não perde
> nada por esperar.

A chave de acesso é autodescritiva:

| Posições | Conteúdo |
|---|---|
| 0–1 | UF do emitente |
| 2–5 | AAMM da emissão |
| 6–19 | **CNPJ do emitente** |
| 20–21 | **modelo** — 55 NF-e · 57 CT-e · 59 CF-e-SAT · 65 NFC-e |
| 22–24 | série |
| 25–33 | **número do documento** |
| 43 | DV (módulo 11 — já implementado em `barcode_dv_refuted`) |

#### Ponto de integração — há DOIS tipos de `ignorado`, e só um é alcançável

A regra de negócio permanece **intacta**: e-mail sem conta a pagar **continua** não gerando linha em
`financial_account_control`. O que muda é que ele passa a alimentar `fiscal_document`. Mas os dois
caminhos que produzem `ignorado` são muito diferentes:

| Tipo | Quando | Anexo foi baixado? | Alcançável? |
|---|---|---|---|
| **A — sem keyword no assunto** | `run_reader` registra e segue | ❌ **Nunca baixa nem extrai** (`has_attachment` fica NULL) | ❌ não há PDF |
| **B — descartado por regra de negócio** | CT-e sem boleto · NF-e pura · confirmação de pagamento | ✅ baixou, subiu ao bucket, extraiu, **então** descartou a conta | ✅ **é aqui que a onda atua** |

**Onde exatamente o gancho entra (corrigido pela auditoria de 2026-07-31):** no **Passo 1** de
`extract_and_store_accounts` — o laço que extrai todos os anexos e coleta as linhas em `pending` —,
gravando `fiscal_document` **sempre que o documento contiver uma chave de acesso válida**,
independentemente do destino que a linha terá depois.

> ⚠️ **Não amarrar aos pontos de `skipped_nonpayable`.** A primeira versão deste plano dizia "no
> ponto em que a linha vira `skipped_nonpayable`" — mas existem **7 pontos distintos** de
> `skipped_nonpayable` no Passo 2 (CT-e sem boleto, fatura+boleto, extrato/relatório, não-pagável
> visual, recebível, seguradora…), e só alguns são documento fiscal. Ancorar ali significaria 7
> ganchos a manter e cobertura incompleta.
>
> **O Passo 1 é superior por três razões:** (a) é **um único ponto**; (b) cobre o documento fiscal
> **mesmo quando a linha VIRA conta** — por exemplo, o boleto de transporte que traz junto a chave
> do CT-e, hoje perdida; (c) **não depende da regra de negócio**, que pode mudar sem que o registro
> fiscal deixe de ser desejável.

Isso funciona porque `cte`, `ct-e`, `dacte`, `conhecimento de transporte`, `nota fiscal`, `nfe` e
`nf-e` **já estão em `KEYWORDS_DEFAULT`** — então esses e-mails passam pelo filtro de assunto e têm
o anexo baixado. Um CT-e cujo assunto não casasse keyword nenhuma cairia no tipo A e permaneceria
inalcançável (não é o caso hoje).

**Invariante a preservar:** a gravação em `fiscal_document` é **não-fatal** e **não altera** o
`status` do e-mail nem cria conta — mesmo padrão do `register_attachment` (migration 079). Se ela
falhar, o e-mail segue `ignorado` normalmente e a extração financeira não é afetada.

**Fora desta onda, por decisão fundamentada:**

- **NFS-e** → **não tem chave nacional de 44 dígitos** (é municipal, layout por prefeitura; o
  Padrão Nacional só existe desde 2023 e a adoção é heterogênea). Exigiria LLM por layout para
  **4 documentos**. Vai para a **Onda 9** (condicional).
- **Cupom fiscal NÃO eletrônico** → papel térmico, sem estrutura e sem chave; **0 ocorrências** na
  base. Ver seção 5 (descartados).
- **Conteúdo detalhado** (itens de NF-e, peso/rota/frete do CT-e) → **Onda 5**, porque exige LLM.

> ⚠️ **Invariante:** documento fiscal **NUNCA soma** em relatório financeiro — o frete já entra
> como boleto e a NF-e é a origem da mercadoria, não a obrigação de pagamento. Somar duplicaria
> despesa. Vai explícito no dicionário de dados do chat.

**Por que não repete o erro dos agregados:** documento é **imutável** — um CT-e não muda de peso
amanhã. É tabela de **proveniência**, não de agregação; não há o que dessincronizar.
**Esforço:** M.

---

### ONDA 4 — Varredura histórica da caixa postal (passada única)

**Por quê:** boa parte do que se quer recuperar **não está mais no banco nem no bucket** — só na
caixa postal. Uma passada única em `financeiro@otimotex.com.br` resolve **duas ondas de uma vez**:

| Recupera | Origem do problema |
|---|---|
| ~115 CT-e sem PDF | apagados pela purga de 15/07 |
| 440 corpos truncados em 500 chars | `body_preview` nunca guardou o texto completo |
| Documentos fiscais anteriores ao pipeline | e-mails nunca processados |

> **440, não 439** (divergência interna corrigida em 2026-08-03): a tabela medida da §7.2 —
> `B — processado | 884 | 823 | 440` — é a fonte, e o `CLAUDE.md` já registrava 440. Duas frases
> desta seção diziam 439, escritas ao redor da medição. O número **exato de hoje** sai do
> `--dry-run` (`com body_full NULO`), que consulta `body_full IS NULL AND keyword_matched IS NOT
> NULL` — é ele que fecha a onda, não o valor histórico.

**Precisa ser um script novo — `read_emails.py --all` NÃO serve.** A dedup por `message_id`
(`known_ids`) **pula** todo e-mail já registrado, que é exatamente o conjunto a reprocessar. O
`reprocess_message.py` ignora a dedup, mas opera **um Message-ID por vez**.

#### 🔴 Invariantes de segurança (a parte que pode causar dano real)

> **Natureza do processo (decisão do usuário):** executado **UMA ÚNICA VEZ**, com finalidade
> exclusiva de **ajustar/completar** os dados. **Não apaga nada do que já existe** e não corrige
> nem sobrescreve dado gravado — é **estritamente aditivo**. Terminada a passada, o fluxo normal do
> reader volta a ser a única via de entrada.

Este é o processo de maior risco do plano inteiro — ele **reprocessa e-mails que já geraram
contas**. As travas:

1. **NUNCA grava em `financial_account_control`.** O script é **read-only** na tabela financeira.
   Sem essa trava, uma varredura criaria **contas a pagar duplicadas** em massa — o pior desfecho
   possível num sistema de pagamentos.
2. **NUNCA apaga, altera ou sobrescreve nada.** Nem `status`, nem `reviewed_at`, nem conta, nem
   objeto do bucket, nem campo já preenchido. Só **acrescenta**: `body_full` **quando nulo** e
   linhas novas em `fiscal_document`.
3. **NUNCA marca como lido** (`\Seen`) — não usar `--mark-seen`; a caixa é operada por pessoas.
4. **Idempotente:** rodar duas vezes não duplica (`fiscal_document` com UNIQUE na chave de acesso;
   `body_full` só preenche quando nulo). Embora seja passada única por decisão, a idempotência é o
   que permite **retomar com segurança** após uma queda no meio do processo.
5. **`--dry-run` obrigatório antes**, reportando: total de mensagens na caixa, quantas já
   registradas, quantas com documento fiscal, quantas gravaria.
6. **Retomável por checkpoint** — a caixa é grande e a conexão IMAP cai; reiniciar do zero a cada
   falha inviabiliza o processo. Reusar `_connect_and_search` (timeout + retry/backoff já
   implementados).
   **Onde fica o checkpoint** (a auditoria apontou que "retomável" estava declarado sem mecanismo):
   arquivo local `data/varredura_checkpoint.json` com os UIDs já processados — **não** tabela nova,
   porque o estado é efêmero e morre com o fim da passada única. Combinado com a idempotência do
   item 4, retomar é seguro mesmo se o checkpoint se perder.

> 📦 **Esta onda NÃO exige deploy em produção.** É passada única e o script roda de **qualquer
> máquina com o `.env`** (IMAP + Supabase) — inclusive a de desenvolvimento. Não entra no
> `check_deploy_parity`, não altera as 4 rotinas agendadas e não precisa ser copiado para
> `C:\Sheild\API\Pagamentos`.

#### Incógnita a medir na primeira execução

`email_control` cobre **01/04/2026 a 31/07/2026** (1.133 e-mails, 186 remetentes). **Não se sabe
quantas mensagens a caixa tem de fato** — pode haver anos de histórico anterior ao pipeline. O
`--dry-run` responde isso antes de qualquer gravação, e é o que dimensiona o custo.

**Custo:** baixo se restrito à **camada 1** (chave de acesso, determinística, sem LLM). Estender à
camada 2 (itens/conteúdo) multiplicaria o custo pelo nº de documentos — decidir separadamente.

**Pré-requisito:** Ondas 2 e 3 concluídas — sem `body_full` e `fiscal_document` não há onde gravar.
**Esforço:** M.

> **Por que vem ANTES da camada 2 (Onda 5), e não depois:** a purga já levou 67% dos PDFs de CT-e;
> cada semana de espera é acervo perdido de forma irreversível. A camada 2 é a onda mais cara e
> arriscada do plano — amarrar a varredura a ela adiaria a recuperação por tempo indeterminado.
>
> **Trade-off assumido:** os documentos recuperados aqui terão só a camada 1. Quando (e se) a Onda 5
> for feita, o script desta onda é **re-executável** sobre o acervo já registrado — sem novo acesso
> ao IMAP, pois os PDFs terão sido salvos no bucket nesta passada.

---

### ONDA 5 — Documentos fiscais: camada 2 (conteúdo via LLM)

**Por quê:** a chave de acesso identifica o documento, mas não diz **o que** foi comprado ou
transportado. Este é o conteúdo mais rico do projeto — e o mais caro e arriscado de extrair.

| Item | O quê | Migration | Estado |
|---|---|---|---|
| 5.1 | Tabela `fiscal_document_item` (1:N → `fiscal_document`) — **itens de produto da NF-e** | — | 🔴 **SUSPENSO** — 15 DANFEs medidos |
| 5.2 | Extração por LLM do DANFE: código, descrição, NCM, CFOP, quantidade, unidade, valor unitário, valor total | — | 🔴 **SUSPENSO** — mesma causa |
| 5.3 | Campos de conteúdo do CT-e: peso, volumes, origem/destino, valor do frete, NF vinculada | **119** | ✅ **CONCLUÍDO** (2026-08-12) — **sem LLM**, da fatura agregada |
| 5.3-b | O mesmo, a partir do **DACTE individual** (83 PDFs) — exige LLM, layout varia por emissor | — | ⏸ não iniciado |
| 5.4 | Extensão de `documentos_fiscais` (rota/peso/frete + filtro `p_rota`) | **119** | ✅ saiu junto com o 5.3 |

> ⚠️ **Os números 109/110/111 que esta tabela reservava NÃO valem mais** — foram consumidos por
> trabalho não relacionado (e-mail de plataforma; sentinela de autoria) e pela Onda 6, antes desta
> onda começar. O 5.3 saiu na **119**. Confira sempre a última migration aplicada antes de criar
> uma nova; reservar número com meses de antecedência não sobrevive ao contato com a realidade.
>
> A tool `itens_nota_fiscal(...)` que o 5.4 previa **não foi criada**: ela serviria aos itens de
> NF-e, que estão suspensos. O que a 119 entregou foi a extensão da tool existente.

**Destrava:** custo de frete por rota, peso por destino e a NF transportada em cada conhecimento —
✅ **entregue pelo 5.3**. O *"o que compramos deste fornecedor?"* e a análise por NCM/CFOP dependem
dos itens de NF-e e **seguem impossíveis**, por falta de população, não por falta de implementação.

**Riscos — esta onda é a de maior risco do plano:**

1. **Erro de leitura visual.** Não há XML: só DANFE/DACTE em PDF. O projeto tem dois precedentes
   documentados (id **463**, barcode corrompido por OCR; id **435**, data invertida pelo Vision).
   Item com quantidade ou valor errado é pior que item ausente.
2. **Cardinalidade.** Uma NF-e tem de 1 a 100+ itens; a tabela de itens cresce numa ordem de
   grandeza acima da fato. Rever índices e o teto de linhas devolvido ao chat.
3. **Dupla contagem.** Vale o mesmo invariante da Onda 3, com força redobrada: **valor de item de
   NF-e não é conta a pagar**. Precisa estar explícito no dicionário e coberto por teste.
4. **Custo recorrente de LLM** por documento processado.

**Pré-requisito:** a Onda 3 concluída e em uso — só faz sentido detalhar o conteúdo depois que a
identificação estiver estável e alguém estiver de fato consultando os documentos.
**Esforço:** G.

#### 🔴 POPULAÇÃO MEDIDA (2026-08-12) — o carro-chefe da onda não se sustenta

Levantamento feito **lendo os 144 PDFs do bucket** (pdfplumber, sem LLM) e classificando pelo
TEXTO, não por assunto/nome — a classificação por metadados, tentada antes, erra: 34 PDFs com
assunto `CT-e - NNNN` registravam apenas a chave da NF-e citada dentro do DACTE.

| Grupo | PDFs | Docs | O que é | Serve a quê |
|---|---|---|---|---|
| **A** DACTE | 83 | 123 | conhecimento de transporte, **layout varia por emissor** (Rodonaves × Oksman × STC) | **5.3** — exige LLM ou parser por emissor |
| **B** fatura agregada | 10 | 55 | BRASPRESS/SSW — **tabela regular**: AWB, percurso ORIG/DEST, data, peso, NF, vlr. mercadoria, vlr. frete, destinatário, + a chave do CT-e na linha seguinte | **5.3 SEM LLM** |
| **C** guia GNRE | 31 | 31 | guia de recolhimento citando a chave | nada |
| **D** DANFE | **15** | **15** | única fonte de itens de produto (só **6** com tabela detectável) | 5.1/5.2 |
| **F** outro | 5 | 8 | DACTE com texto corrompido pelo extrator | 5.3 parcial |

**Três conclusões que mudam o desenho da onda:**

1. **5.1/5.2 (itens de NF-e) tem população real de 15 documentos** — e o "o que compramos deste
   fornecedor?" que justifica a onda não se sustenta neles. Das 128 NF-e registradas, a maioria
   são chaves **citadas** em guias GNRE ou dentro do DACTE; o DANFE em si não está no acervo.
   Criar tabela filha + extração por LLM + tool + testes para 15 documentos é desproporcional.
2. **5.3 é maior e mais barato do que o plano supunha.** A hipótese registrada era que o grupo B
   fosse "resumo de cobrança, não DACTE" — **ler o PDF a desmentiu**: ele traz exatamente os
   campos do 5.3 em tabela estruturada, casável 1:1 com `fiscal_document.access_key`, extraível
   por regex determinístico. O LLM ficaria só para o grupo A.
3. 🔴 **O pré-requisito declarado da onda continua NÃO cumprido:** `documentos_fiscais` **nunca
   foi chamada** — 8 interações em `analytics.ai_chat_log`, de 30/07 a 10/08. Detalhar conteúdo
   que ninguém consulta é otimizar o degrau errado.

**Achado colateral, já corrigido (não era escopo da onda):** a varredura expôs que **61 CT-e
estavam sendo perdidos** por a barra faltar no separador de dígitos do `fiscal_key.py` — acervo
de 232 → **293** documentos. Ver o bloco da Onda 3 no `CLAUDE.md`.

**Recomendação:** executar **só o 5.3**, e começando pelo grupo B (determinístico, 55 CT-e, sem
custo de LLM) — ou **adiar a onda inteira** até alguém consultar os documentos, registrando a
queda da premissa, como a Onda 4 fez. Os itens 5.1/5.2 ficam **suspensos por falta de
população**, a reabrir se o acervo de DANFE crescer.

#### ✅ EXECUTADO em 2026-08-12 — item 5.3 pelo grupo B (migration 119)

| Entrega | Onde |
|---|---|
| Parser determinístico, stdlib puro, fail-closed pelo SUB-TOTAL | `skills/pdf-contas-pagar/scripts/cte_content.py` |
| 9 colunas de conteúdo + `content_source` + índice de rota | migration **119** |
| `analytics.documentos_fiscais` devolve rota/peso/frete/NF + filtro `p_rota` | migration **119** |
| Gancho no reader, **depois** do registro das chaves | `_register_cte_content` em `read_emails.py` |
| Backfill de **57 CT-e** em 12 faturas | `scripts/backfill_cte_content.py` |
| 21 testes (parser + gancho executado), validados contra 4 mutantes | `tests/test_cte_content.py` |
| Guarda anti-dupla-contagem (tool × SYSTEM_PROMPT) | `lib/ai-chat/regression.test.ts` |

**Verificação por oráculo diferencial:** o SUB-TOTAL impresso fechou em **10/10** faturas; e,
cruzando pelo PDF de origem, **9 de 9** faturas com conta a pagar vinculada batem **exatamente**
com o `amount` da conta — o que prova, no dado, que o frete é decomposição e não despesa nova.

**O que NÃO foi feito, e por quê:** 5.1/5.2 (itens de NF-e) seguem suspensos — 15 DANFEs; e o
5.3-b (DACTE individual por LLM, 83 PDFs) não foi implementado, porque o layout varia por
transportadora e o pré-requisito de uso da Onda 3 continua não cumprido. Executar o barato e
verificável primeiro deixa a decisão sobre o LLM para quando houver demanda real.

---

### ONDA 6 — Campos derivados na tabela fato

**Por quê:** enriquecer o que já existe, **derivando** — nunca inventando.

| Item | O quê | Migration | Nota |
|---|---|---|---|
| 6.1 | **`competence_month` DATE — coluna NOVA e derivada** (`competence_date` permanece TEXT) | **112** | ✅ aplicada — mas com **`make_date`**, não `to_date` (ver 7.5) |
| 6.2 | **`dim_date` + feriados nacionais** | **111** | ✅ aplicada — 11.323 dias, calendário BANCÁRIO |
| 6.3 | **`installment_number` / ~~`installment_total`~~ → `installment_base`** | **113/114** | ✅ aplicada — o **total NÃO existe na origem** (ver 7.5) |
| 6.4 | **`days_late`** como **coluna gerada** (`GENERATED ALWAYS AS STORED`) | **112** | ✅ aplicada — só `payment_date - due_date` |
| 6.5 | **`extraction_confidence`** derivado de `extraction_source` | **112** | ✅ aplicada — ordinal textual, nunca numérico |
| 6.6 | **Recorrência por cadência** — **função** em `analytics` | **115** | ✅ aplicada — por cadência, nunca por valor |
| 6.7 | Expor no schema Zod e na `vw_payables` | **115** | ✅ aplicada — view de 35 → 40 colunas |

> **Numeração real: 111–115**, não 112–116. As migrations 109 e 110 foram consumidas por trabalho
> não relacionado (e-mail de plataforma; sentinela de autoria) antes desta onda começar; deixar a
> 111 vazia só para casar com o número escrito aqui seria pior. A **116** corrigiu a truncagem
> silenciosa das duas funções da 115 (achado B1 do review de 2026-08-10), então a Onda 7 desloca
> para 117–118.

#### 🔴 `competence_date` NÃO pode ser convertida para DATE (achado da auditoria de 2026-07-31)

A versão inicial deste plano previa `competence_date TEXT → DATE`. **Isso quebraria a extração de
e-mails.** Verificado no código e nos dados:

- O conteúdo é **`YYYY-MM`** (mês de competência), não uma data: `2026-06` (32), `2026-07` (30),
  `2026-05` (8)… — **todos os 84 valores** nesse formato.
- `'2026-06'::date` → **`invalid input syntax for type date`**.
- O formato é **contrato de três camadas**: o prompt do Claude (`extract_pdf.py`, *"competencia no
  formato YYYY-MM"*), o template do CSV (`output_template.csv`) e o schema Zod
  (`competence_date: z.string() // YYYY-MM`).
- Com a coluna em DATE, **todo INSERT do reader passaria a falhar** — a extração pararia.

**Correção adotada — acrescentar, não converter:**

```sql
ALTER TABLE financial_account_control
  ADD COLUMN competence_month date
  GENERATED ALWAYS AS (
    CASE WHEN competence_date ~ '^\d{4}-(0[1-9]|1[0-2])$'
         THEN to_date(competence_date || '-01', 'YYYY-MM-DD')
         ELSE NULL END
  ) STORED;
```

`competence_date` **permanece TEXT e intocada** → pipeline, CSV e Zod seguem válidos, zero risco.

> ⚠️ Usar **`to_date(...)`**, não `::date`: o cast de texto para data é **STABLE** (depende de
> `DateStyle`) e o PostgreSQL **recusa** expressão não-IMMUTABLE em coluna gerada. `to_date` com
> máscara explícita é IMMUTABLE.

> 🔴 **A guarda `CASE ... regex` NÃO é enfeite — sem ela a coluna gerada quebraria o INSERT**
> (achado A11, 3ª auditoria). Medido no banco real: `to_date('2026-13-01','YYYY-MM-DD')` lança
> **`22008: date/time field value out of range`**, e valor não-numérico lança erro de parsing. Como
> `competence_date` é preenchida pelo **Claude** (o prompt pede `YYYY-MM`, mas LLM pode desviar),
> um único valor fora do formato faria **todo o INSERT falhar** — parando a extração, que é
> exatamente o que a correção do achado A1 pretendia evitar.
>
> O regex **guarda** o `to_date`: mês `13` → `NULL`, texto livre → `NULL`, `2026-07` → `2026-07-01`
> (validado no banco). Hoje há **0 valores fora do padrão** nos 84 existentes — o risco é **futuro**,
> e é justamente o tipo que só aparece meses depois, em produção.

| Item | Acréscimo derivado desta correção | Migration |
|---|---|---|
| 6.7 | Expor `competence_month` no schema Zod (`@sheild/shared`) e na `vw_payables` | 112 |

#### Dependência transversal desta onda

Toda coluna nova em `financial_account_control` exige atualizar **`packages/shared`** (fonte única
de tipos entre API e frontends) e, se o chat precisar dela, também **`vw_payables`**. Sem isso, a
coluna existe no banco e é invisível para o resto do sistema.

**Destrava:** competência × caixa · dias úteis até vencer · carnês · previsão sobre os 25% da base
que são recorrentes.
**Esforço:** M.

---

### ONDA 7 — Governança / auditoria ✅ CONCLUÍDA (2026-08-11)

| Item | O quê | Migration |
|---|---|---|
| 7.1 | ✅ `audit_log` populada por trigger em `financial_account_control` **e `supplier`** | 117 |
| 7.2 | ✅ **DUAS** tools: `auditoria_eventos` (lista) + `auditoria_resumo` (agregado) | 118 |
| 7.3 | ✅ Ator propagado nos caminhos da Next API (`lib/audit-actor.ts`) | — |

**Destrava:** *"quais usuários vêm alterando campos sensíveis"* — antes irrespondível, pois só o
**último** editor era guardado (456 contas editadas por usuário real, 367 com situação alterada).

#### 🔴 O item 7.1 NÃO era executável como escrito — quatro achados no levantamento

Medidos no catálogo **antes** de qualquer alteração:

| # | Achado | Consequência |
|---|---|---|
| 1 | `audit_log.registro_id` era **uuid**; a PK da fato é **bigint** | Não havia onde gravar o id da conta. A tabela nasceu com o PK-UUID do padrão Sheild genérico, que **nenhuma** tabela deste projeto segue |
| 2 | Policy `"Enable read access for all users"` **TO public** + `GRANT SELECT TO anon` | Popular a trilha **publicaria a base financeira** — a anon key é pública (vai no bundle). Mesma família dos achados 072/081/099: objeto criado pelo dashboard nasce permissivo |
| 3 | Policy de `authenticated` era `USING (true)` | Ignorava a RLS 076 — o grupo Comercial veria o delta de contas alheias (vazamento lateral pela auditoria) |
| 4 | `contaService.remove(id)` não recebia ator e grava por `service_role` | O **hard delete** seria auditado com autor desconhecido — justamente a operação mais destrutiva |

Por isso a 117 **fecha o furo ANTES de ligar as triggers**: a ordem interna do arquivo é parte da
correção, não organização.

#### Decisões tomadas com o dono do produto

- **Escopo:** UPDATE + DELETE + TRUNCATE. **INSERT fica de fora** — a linha recém-criada já *está*
  na fato e o pipeline insere ~17/dia, o que somaria ~6.200 linhas/ano de ruído afogando a pergunta
  de governança.
- **Tabelas:** fato **+ `supplier`**. Alterar a chave PIX de um fornecedor é o vetor clássico de
  fraude em contas a pagar e não deixava rastro algum (a tabela não tem sequer `updated_by`).
- **Leitura:** espelha a RLS atual das contas — preserva o status quo, já que o painel de detalhe
  de `/consulta` sempre mostrou "Criado por"/"Última edição por" a usuários não-restritos.

#### O que a implementação descobriu (registrado no `CLAUDE.md`)

- A trigger de linha tem de ser **AFTER** (as 5 atuais da fato são BEFORE e alteram `NEW`); a de
  TRUNCATE tem de ser **BEFORE**, senão a contagem de linhas destruídas é inalcançável.
- `SECURITY DEFINER` é **obrigatório**, ou a curadoria de `/consulta` quebra com 42501 — a
  regressão classe **074**. A migration prova o contrário na própria aplicação.
- **`OLD.updated_by` nunca é fonte de ator** (é o editor anterior → acusação falsa). O ator viaja
  por **header** nos caminhos da Next API, e o **JWT tem precedência** — inverter a ordem
  permitiria a um usuário logado assinar alterações no nome de outro.
- `audit_sensitive_fields()` **nasceu chamável por `anon`** (HTTP 200 com a anon key), como as 4
  funções da Onda 1. Quarta ocorrência: **não confiar no default privilege**.
- A `audit_log` estava vazia, então o oráculo da 118 **insere eventos sintéticos, mede e desfaz** —
  comparar contagens sobre tabela vazia seria `0 = 0`, verde para sempre.

**✅ Validada em PRODUÇÃO no próprio dia**, sem intervenção manual: os três caminhos apareceram
sozinhos na trilha — `jwt` (um usuário marcou "Tem Boleto" pela UI, delta e autor corretos),
`servico` em lote (28 eventos do batch diário) e `supplier` (o pipeline gravou uma chave PIX, que é
o vetor de fraude que motivou estender o escopo). As tools responderam sobre esse dado com
`total_encontrado` correto.

**Dois achados a mais, encontrados ao atacar o que já estava pronto:** (1) um evento de **usuário
removido** era contado como *automação* — a trilha não perdia o evento, ela o **reatribuía** a uma
categoria que inocenta todo mundo, e o projeto já apagou um usuário antes; (2) o filtro por campo
**não enxergava a exclusão** que destruiu aquele campo, omitindo de *"quem mexeu no valor?"* um
DELETE de R$ 50.000. Ambos corrigidos, com sonda na migration e guarda validada por mutante.

**Verificação:** 34 guardas em `tests/test_onda7_auditoria.py` (validadas contra **9 mutantes**),
4 testes de comportamento no `api-backend` (validados por mutante), recorte de RLS provado com
usuários reais (Comercial **2 de 3**, Financeiro **3 de 3**) e cadeia do ator provada ponta a ponta
contra o PostgREST real. **Sem deploy em produção** — nada em `skills/` foi tocado.
**Esforço:** M.

---

### ONDA 8 — Hardening do chat (Fase 4 do roadmap original)

| Item | O quê | Migration |
|---|---|---|
| 8.1 | ~~Rate limit~~ — **promovido para a Onda 1 (item 1.5)** pela auditoria de 2026-07-31 | — |
| 8.2 | ✅ Tuning de few-shot a partir do `ai_chat_log` acumulado (2026-08-12) | — |
| 8.3 | ✅ **Gate de uso da IA por GRUPO** — acesso opt-in + cota própria | **120** |

**Esforço:** P–M. **Status: ✅ CONCLUÍDA (2026-08-12).**

#### O que a implementação decidiu (e o que ficou rejeitado)

| # | Decisão | Alternativa rejeitada, e por quê |
|---|---|---|
| D1 | Acesso **+ cota** por grupo (`NULL` = teto do `.env`) | **Teto de tokens**: a soma não é index-only, pediria política de falha própria e, com 8 interações de histórico, não há como calibrar número. Gatilho para reabrir: um usuário passar de ~1M tokens/dia, **medido** |
| D2 | Por **GRUPO** (`user_group`), espelhando `sees_only_own_accounts` | **Override por usuário**: 2ª fonte de verdade + regra de precedência, sem caso real. Se surgir, a resolução entra num lugar só — o `gate.ts` |
| D3 | **Deny por default**, semente libera 1, 2 e 7 | **Allow por default**: grupo novo nasceria com acesso a recurso pago sem ninguém decidir |
| D4 | Gate fail-**closed**, cota fail-**open** | Unificar: fail-open no gate é bypass de autorização; fail-closed na cota é queda total por soluço de contador |

> 🔴 **Comercial (6) ficou fora de propósito, e não é só permissão:** com `sees_only_own_accounts`,
> o chat responderia sobre ~5 contas enquanto um colega vê 830 — mesma pergunta, totais diferentes,
> e o modelo não tem como dizer por quê. Se entrar, entra **junto** com uma linha no SYSTEM_PROMPT
> declarando o recorte.

#### Verificação

- **6 sondas** no `DO $$` da 120, todas verdes na aplicação. A **P1** (ninguém que já usou perde
  acesso) e a **P4** (o papel `authenticated` enxerga a coluna mas não a escreve) foram validadas
  por **mutação simulada em transação desfeita** — P1 acusou `1` usuário sem acesso com a semente
  errada; P4 acusou escrita bem-sucedida com `GRANT`+`POLICY` concedidos. Zero resíduo no banco.
- **8 mutantes** de código, isolados e em série: renomear a coluna só na migration (guarda
  cross-layer vermelha, vitest verde), gate fail-open, rota ignorando o retorno do gate, 429 citando
  o `.env`, `!== false` no Layout, `clientSafe` desligado, gate lendo por truthiness.
- **Prova do recorte de RLS** (dívida da onda, adiada em 2026-07-31): bruna@lebianco.com.br, grupo
  Comercial — `vw_payables` **830 → 5**, igual ao oráculo `created_by`; `resumo_situacao()`
  **R$ 12.581.149,54 → R$ 10.004,70**; `fiscal_document` 293 → 0.
- Gates: **Node 1.461** · **Python 1.307** (+24 guardas da onda) · lint, typecheck e prune limpos.
- **Sem deploy em produção** — nada em `skills/` foi tocado.

#### Achado colateral corrigido junto

`failFromError` só ecoava `ApiServiceError` com `status < 500`, então as **três mensagens 503** de
`translateAnthropicError` (timeout, falha de rede, 5xx do provedor) mudavam o status e **perdiam o
texto**: o usuário lia "Erro interno ao processar a solicitação" justamente quando a causa era
temporária e havia o que fazer. O teste de integração que dizia parear tradução e envelope pareava
**só o 429**. Corrigido com `ApiServiceError.clientSafe` (opt-in, default `false` — os 8 CRUDs
seguem intocados) e uma guarda que pareia **cada** ramo, validada por mutante.

---

### ONDA 9 — Condicional (só com evidência)

| Item | Gatilho para reabrir |
|---|---|
| **Integração de RECEITAS (Firebird → Supabase) → DRE completo** | o negócio precisar de DRE de verdade. É o **único caminho** para isso: as receitas existem no Firebird (`VW_PSQ_FIN_REC_BAN`, já lido pela cobrança de vencidos), mas nada é gravado no Supabase. **Esforço G** — projeto próprio, muda a natureza do produto (deixa de ser só contas a pagar). Até lá, vale o "Demonstrativo de Custos e Despesas" da Onda 1 |
| **NFS-e** (extração por layout municipal) | volume crescer — hoje são **4 PDFs**, sem chave nacional |
| **CF-e / NFC-e / cupom fiscal eletrônico** | aparecer volume — o parser da Onda 3 **já aceita** os modelos 59/65; hoje há **1 e-mail e 0 anexos** |
| **DPO / pontualidade real** | histórico pós-096 acumulado (hoje: 2 dias) |
| Valor efetivamente pago / conciliação | integração bancária ou extrato — **não é derivável** |
| Text-to-SQL (Fase 5 do chat) | tools novas não cobrirem as perguntas do `ai_chat_log` |
| **Tabelas agregadas** | alguma tool passar de **~500 ms** warm |

**Esforço:** variável — cada item é reavaliado quando (e se) o gatilho ocorrer.

---

## 5. O que fica DELIBERADAMENTE fora

| Descartado | Por quê |
|---|---|
| **Tabelas agregadas / materialized view** | SQL é **0,04–0,3%** do tempo; o gargalo é o LLM. Zerar o banco não muda a latência percebida |
| **Tabela de dados de boleto** | Já está na fato (`barcode`, `nosso_numero`, juros, descontos, `amount_charged`); duplicar criaria 2ª fonte de verdade |
| **`amount_paid` automático** | Trigger inventaria dado. Os 11 casos com juros provam que cobrado ≠ pago |
| **`approved_by` automático** | Aprovação preenchida por trigger **destrói o conceito** que diz implementar |
| **`is_overdue` / faixa de aging como COLUNA** | Muda com o tempo sem UPDATE — é exatamente o bug da migration **095** |
| **Cupom fiscal NÃO eletrônico** | Papel térmico: sem chave, sem estrutura, só OCR de foto (e térmico desbota). **0 ocorrências** na base — seria construir para um cenário que não existe |
| **DRE completo** *(decisão do usuário, 2026-07-31 — opção B)* | O sistema tem **0 receitas** — é contas a **pagar**. DRE exige Receita Bruta → Deduções → CMV → Lucro Bruto → Despesas → Resultado; aqui existe só a metade de baixo. **Não é problema de enriquecimento**: é dado que não existe neste banco. Entregue no lugar: **"Demonstrativo de Custos e Despesas"** (Onda 1, item 1.7), com esse nome — não "DRE". Reabrir só via integração de receitas (Onda 9) |

---

## 6. Perguntas pré-definidas (sugestões do painel)

Origem: documento *"Auditoria e Controle de Contas a Pagar"* (2026-07-31), **revisado contra o
banco real**. O documento foi escrito olhando as 42 colunas da tabela; o chat vê 26 via
`vw_payables` — daí a reclassificação.

> **Sugestão é um contrato:** o usuário clica confiando. Toda sugestão precisa estar coberta pela
> bateria de regressão antes de entrar no painel. **Lista de sugestões e bateria de teste são o
> mesmo artefato.**

### Grupo 1 — funcionam hoje (entram na Onda 1)

| # | Pergunta | Tool |
|---|---|---|
| 1 | Como estamos de contas a pagar? | `resumo_situacao` |
| 2 | Quanto vence nos próximos 7 dias? | `listar_contas` |
| 3 | Quais os 5 maiores fornecedores com contas vencidas? | `gasto_por_fornecedor` |
| 4 | Qual a distribuição das contas vencidas por faixa de atraso? | `aging_vencidos` |
| 5 | Quanto gastamos por centro de custo neste mês? | `gasto_por_classificacao` |
| 6 | Quais contas estão sem centro de custo ou plano de contas definido? | `gasto_por_classificacao` |
| 7 | Como evoluíram os pagamentos mês a mês neste ano? | `gasto_por_periodo` |
| 8 | Compare os gastos entre OTIMOTEX TECIDOS, LEBIANCO e OTIMOTEX FARDOS | `p_sk_company` |
| 9 | Qual a diferença entre o que vence e o que saiu de caixa neste mês? | `gasto_por_periodo` |

### Grupo 2 — dependem da Onda 1 (expor colunas)

| # | Pergunta | Precisa de |
|---|---|---|
| 10 | **Quais contas têm boleto mas não têm nota fiscal?** | `has_invoice`, `has_bank_slip` — **169 casos** |
| 11 | Quanto pagamos de juros e multa, e por qual fornecedor? | `fine_interest`, `other_additions` |
| 12 | Quanto capturamos em descontos por antecipação? | `discount`, `other_deductions` |
| 13 | Em quais contas o valor cobrado ficou acima do valor do documento? | filtro sobre `amount` × `amount_charged` |
| 14 | Qual a taxa de sucesso da extração automática por origem? | `extraction_source` (+ tool de e-mails p/ falhas) |
| 15 | 🎯 **Quanto foi despesa fixa e quanto foi variável neste mês?** | eixo `tipo` (item 1.6) |
| 16 | 🎯 **Mostre o demonstrativo de custos e despesas do mês** | tool `demonstrativo_despesas` (item 1.7) |
| 17 | 🎯 **Quais os maiores gastos fixos recorrentes?** | eixo `tipo` + `gasto_por_classificacao` |
| 18 | 🎯 **Quanto pagamos de tributos no período?** | linha própria do demonstrativo (item 1.7) |

### Grupo 3 — reformuladas ou adiadas

| Origem | Situação |
|---|---|
| §1 — *matriz de perdas/ganhos entre `amount` e `amount_charged`* | ⚠️ **Premissa incorreta** — `amount_charged` é o **cobrado no boleto**, não o pago. Substituída pelas 11, 12 e 13 |
| §2 — *índice de pontualidade / DPO* | 🚨 **Adiada (Onda 9)** — 97% das pagas têm data de backfill; só 2 dias de histórico real |
| §5 — *quais usuários alteram campos sensíveis* | ✅ **Entregue (Onda 7, 2026-08-11)** — `auditoria_resumo` com `group_by='usuario'` e `apenas_sensiveis=true` |
| §4 — *falha da esteira de extração* | 🟡 Parcial na Onda 1; completa exige tool sobre `email_control` (Onda 2) |

---

## 7. Registro de execução

| Onda | Status | Migrations aplicadas | Data | Observações |
|---|---|---|---|---|
| 1 — Destravar colunas existentes | ✅ **concluída** | **103, 104** | 2026-07-31 | 7 itens; 3 achados na execução (abaixo) |
| 2 — Corpo de e-mail | ✅ **concluída** | **105, 106** | 2026-07-31 | escopo A; 8ª tool; **deploy do reader APLICADO e verificado em prod** |
| 3 — Fiscais camada 1 (chave: CT-e/NF-e/CF-e) | ✅ **concluída** | **107, 108** | 2026-08-01 | 9ª tool; **72 PDFs fiscais salvos da próxima purga**; **deploy APLICADO e verificado em prod (27/27)** |
| **4 — Varredura histórica (passada única)** | ✅ **concluída** | — (nenhuma) | 2026-08-03 | 264 mensagens · **+70 corpos · +7 chaves · +4 objetos** · 0 falhas · contas intocadas. **A premissa caiu: a INBOX tinha 264 de 1.166 e-mails — 0 CT-e recuperados** |
| 5 — Fiscais camada 2 (itens de NF-e via LLM) | ⬜ não iniciada | — | — | requer Onda 3 |
| 6 — Campos derivados | ⬜ não iniciada | — | — | — |
| 7 — Auditoria | ⬜ não iniciada | — | — | — |
| 8 — Hardening | ⬜ não iniciada | — | — | — |
| 9 — Condicional (NFS-e, CF-e, DPO…) | ⬜ não iniciada | — | — | — |

---

### 7.1 Onda 1 — o que a execução ensinou (2026-07-31)

**Baseline antes:** 776 pytest · 1.165 Node · lint/typecheck/prune limpos.
**Depois:** 776 pytest · **1.199 Node** (+34) · lint/typecheck/prune limpos.
**Prova de não-regressão do pipeline:** o fato foi de **609 → 610 contas** durante a onda — a
extração seguiu rodando normalmente enquanto as migrations eram aplicadas.

**Três achados que não estavam previstos no plano:**

| # | Achado | Como foi pego |
|---|---|---|
| 🔴 **O1** | **As 4 funções recriadas nasceram executáveis por `anon`** — chamáveis com a anon key pública, sem login. Causa: o PostgreSQL concede `EXECUTE` a PUBLIC por default e o `ALTER DEFAULT PRIVILEGES` da migration 098 **não deixou registro persistente** (`pg_default_acl` vazio para funções do schema). As 3 funções antigas só estavam protegidas pelo `REVOKE` explícito da 098 | Verificação de grants logo após aplicar a 104 |
| ⚠️ **O2** | **Expor coluna na view NÃO torna a pergunta respondível.** `fine_interest`/`discount` estavam na view, mas nenhuma tool as agregava — "quanto pagamos de juros" não teria resposta. Foi preciso acrescentá-las ao **RETORNO** de `gasto_por_fornecedor` | Conferência das sugestões contra o que as tools devolvem, antes de publicá-las |
| ⚠️ **O3** | **Somar um ranking truncado dá número errado.** `gasto_por_fornecedor` devolve no máximo 100 de **165** fornecedores; somar suas linhas subestima o total silenciosamente (os 2 fornecedores com desconto ficam fora do top 100 por serem de valor baixo). Registrado no SYSTEM_PROMPT como proibição explícita | Um oráculo diferencial "falhou" — e a investigação mostrou que o **oráculo** é que estava errado, não a tool |

> **O1 vira guardrail permanente** (seção 8, item 2 reforçado): **toda função nova ou recriada em
> `analytics` leva `GRANT` explícito para `authenticated` E `REVOKE` explícito de PUBLIC/anon.**
> Não confiar no `ALTER DEFAULT PRIVILEGES` — foi medido que ele não persiste aqui.

**Três perguntas do documento de auditoria ficaram DE FORA das sugestões**, por não terem dado que
as sustente — e isso é cumprimento da regra "sugestão é um contrato", não omissão:

| Pergunta | Por que ficou fora | Volta em |
|---|---|---|
| DPO / pontualidade | 97% das contas pagas têm `payment_date` de backfill | Onda 9 |
| Quem alterou campos sensíveis | ✅ **entregue na Onda 7** — sugestão no painel + bateria de regressão | — |
| Taxa de sucesso da extração | as falhas vivem em `email_control`, fora do alcance das tools | Onda 2 |

**Entregue:** migrations 103 e 104 · 7ª tool (`demonstrativo_despesas`) · eixo `tipo` · filtros de
compliance · somas de juros/descontos · rate limit (30/h, 150/dia, fail-open) · 15 sugestões em 4
temas · bateria de regressão que cobre as 15.

#### A linha "Não classificado" é curadoria do usuário — NÃO automatizar

Decisão do Ricardo em 2026-07-31: as contas sem plano de contas (**64 contas · R$ 416.379,38** na
data) serão corrigidas **manualmente, ao longo do tempo**. **Não propor nem executar backfill
automático** (herança do cadastro do fornecedor ou classificação em bloco) — várias exigem
julgamento de negócio, e um script sobrescreveria decisões que só ele pode tomar.

Nada a fazer no código: o `demonstrativo_despesas` lê a classificação **em tempo de consulta**, então
a linha encolhe sozinha conforme a curadoria avança. Prova disso no mesmo dia — ao classificar o
subgrupo **77.1 Publicidade e Propaganda** como *Despesas Variáveis*, as duas contas migraram de
"Não classificado" para a linha certa sem ninguém tocar nelas, e o total seguiu fechando
(R$ 8.863.267,26 dos dois lados).

Os três casos que parecem **cadastro sujo**, e não falta de classificação, ficam anotados para
quando ele chegar neles: LEBIANCO (R$ 38.448) e CONFECCOES OTIMOTEX (R$ 1.836) são empresas do
próprio grupo lançadas como fornecedor; **CDI** (R$ 2.699) tem a OTIMOTEX como `legal_name` (filial
mal cadastrada, já registrado no `CLAUDE.md`); e `resposta-automatica-sac@oficial.nike.com.br`
(R$ 6.310) é fornecedor criado a partir de um endereço de e-mail.

---

### 7.2 Onda 2 — o que a execução ensinou (2026-07-31)

**Baseline:** 776 pytest · 1.203 Node. **Depois:** **783 pytest** (+7) · **1.206 Node** (+3) ·
lint/typecheck/prune limpos.

> ⚠️ **O baseline falhou 1 teste na PRIMEIRA execução e passou na segunda.** Não era regressão:
> é o esgotamento de recursos já documentado em `vitest-worker-crash-sandbox` (os 3 workspaces em
> sequência). A regra que se confirma: **falha espalhada e não-reprodutível = recursos; falha no
> mesmo teste = bug.** Rodar isolado (`api-backend` 496/496, `frontend-vite` 705/705) foi o que
> distinguiu os dois casos.

**Entregue:** migrations 105 e 106 · `body_full` + `body_search` (tsvector) + índice GIN · backfill
de 383 corpos · reader gravando o corpo completo · **8ª tool `buscar_emails`** · 16ª sugestão e
5º tema no painel.

**Dois achados durante a execução:**

| # | Achado | Como foi pego |
|---|---|---|
| ⚠️ **O4** | **`COALESCE`/`LEAST`/`GREATEST` não aceitam qualificação `pg_catalog.`** — são construtos da linguagem, não funções. A migration falhou na aplicação com `42883`. E a qualificação nem era necessária: com `search_path = ''` o `pg_catalog` é pesquisado implicitamente, como a 098 já documentava | Erro na aplicação da migration |
| ⚠️ **O5** | **O `ts_headline` recebia só o corpo, enquanto o tsvector indexa assunto + corpo.** Resultado: para o termo "boleto", **104 de 255 e-mails (41%)** vinham sem destaque — **50 deles não têm corpo algum** e casaram apenas pelo assunto, devolvendo trecho vazio. O modelo receberia linhas sem contexto, sem saber por que vieram | Oráculo diferencial: 50 linhas devolvidas, só 30 com destaque |

**Mais três, achados no code review posterior — dois deles nas PRÓPRIAS correções acima:**

| # | Achado | Por que passou |
|---|---|---|
| 🔴 **O6** | **`NULL \|\| texto` devolve NULL em SQL** — no `ts_headline` eu concatenei `e.subject` sem `COALESCE`, então um e-mail **sem `Subject`** produziria `trecho` NULL. Hoje são 0 e-mails, mas mensagem sem Subject é comum | O `COALESCE` do corpo já estava lá; faltou no assunto. Só apareceu ao perguntar ao próprio SQL "e se for nulo?" |
| 🔴 **O7** | **O teto do tsvector existia só no cliente.** `tsvector` estoura em **1 MB** e estourar **quebra o INSERT** (coluna gerada). O teto de 100 KB estava só no reader — mas a varredura da Onda 4, backfills e correção manual gravam `body_full` direto por `service_role`. Movido para dentro da expressão gerada (`left(…, 100000)`) | *"Teto só no cliente protege apenas o cliente que se lembrou dele."* Surgiu ao perguntar **quem mais escreve nesta coluna** |
| 🔴 **O8** | **`scripts/reprocess_body_emails.py` rebuscava o corpo INTEIRO do IMAP e o descartava**, gravando só `[:500]`. A mesma perda que a onda corrigiu no reader, sobrevivendo por outro caminho — e logo nos e-mails em `falha`, os que mais precisam de análise | Revisão de ESTRUTURA: mapear todos os caminhos de escrita de `email_control`, não só o do reader |

> **O8 é o achado mais instrutivo da onda:** corrigir o produtor principal não basta quando há
> produtores secundários. Ao remover um truncamento (ou qualquer perda de dado), mapear **todos**
> os caminhos que escrevem aquela coluna. Aqui foram dois: o reader e um script de reprocessamento.

**E mais três, num review focado na QUALIDADE DA VERIFICAÇÃO — todos "testes que mentem":**

| # | Achado | Correção |
|---|---|---|
| 🔴 **O9** | `test_grava_o_corpo_ANTES_de_decidir_o_desfecho` **não verificava a ordem** — só que a função era chamada nos 4 desfechos. E a ordem importa: se a gravação ficasse depois de `try_extract_from_body`, uma exceção na extração levaria junto o corpo já baixado do IMAP — e o script roda justamente sobre e-mails em `falha`, os que mais quebram a extração | Renomeado para o que de fato verifica + teste novo que prova a ordem **pelo comportamento** (a extração lança, o corpo tem de sobreviver) |
| 🔴 **O10** | A bateria de regressão afirmava *"se alguém acrescentar uma pergunta no painel sem cobrir aqui, o número diverge"*. **Falso** — `toHaveLength(16)` conta o array local e não observa o painel. Uma sugestão nova entraria **sem teste**, quebrando em silêncio o invariante "sugestão é contrato" | Guarda **cross-layer** que lê o `AiChatPanel.tsx` e compara (mesmo padrão do `log.test.ts` × migrations), com sanidade do parser |
| 🔴 **O11** | O teto do corpo vive em **duas camadas** — Python (`BODY_FULL_MAX_CHARS`, quanto GUARDAR) e SQL (`left(…, N)`, quanto INDEXAR) — e nada garantia coerência. Subir o do Python para 150 KB deixaria 50 KB gravados e **fora do índice**, com a busca respondendo "não encontrado" para texto que está no banco. O teste checava `<= 200_000`, número mágico que não observa o SQL | Guarda cross-layer que lê a migration (localizada pelo **conteúdo**, não pelo nome) e exige `teto_python <= teto_sql` |

> **As três correções foram validadas contra MUTANTE** — introduzi o defeito de propósito e conferi
> que o teste falha. Um teste que não fica vermelho quando o defeito existe não é teste, é
> decoração; e os três estavam nessa condição.
>
> **O padrão que O9–O11 revelam é distinto dos anteriores.** O1–O8 eram defeitos de **código**;
> estes são de **verificação**, e mais perigosos, porque teste verde é justamente o que faz parar de
> olhar. Todos apareceram com a mesma pergunta: *"o que aconteceria se eu quebrasse isto de
> propósito?"* — e a resposta, nos três, era **"nada falharia"**.

> **O5 generaliza:** quando a busca casa por um texto e o resultado mostra OUTRO, o usuário vê
> ruído sem explicação. **O trecho exibido tem de vir do mesmo texto que o índice casou.**

#### Decisão de escopo (item 2.3) e o que ficou de fora

Adotada a **opção A** — só remover o truncamento. Os **440 corpos truncados** eram 100% da perda
medida e estão todos no caminho processado. Os **251 e-mails sem keyword** seguem sem corpo: são
não-financeiros por definição, e cobri-los exigiria um `FETCH RFC822` completo por mensagem
(baixando anexos junto), além de trazer PII de comunicação interna para o banco.

Os 440 truncados **continuam NULL** — só o IMAP tem aquele texto. É a **Onda 4** que os recupera.

#### Deploy do reader — APLICADO e verificado em produção (2026-07-31)

Primeira onda que toca `skills/`. `read_emails.py` copiado e confirmado em
`C:\Sheild\API\Pagamentos`: `True 100000` (helper + teto) e as duas gravações presentes no código
carregado (`process_message` e `SupabaseControl.register`).

**Lição de verificação de deploy (vale para as próximas ondas):** conferir a existência de uma
constante prova apenas que **o arquivo mudou**; não prova que a **alteração de comportamento** está
lá. Quando o horário da cópia é incerto — foi o caso aqui —, o que fecha a dúvida é inspecionar o
código carregado:

```powershell
py -3 -c "import sys, inspect; sys.path.insert(0,'skills/email-reader/scripts'); import read_emails as R; print('grava:', 'body_full' in inspect.getsource(R.process_message)); print('envia:', 'body_full' in inspect.getsource(R.SupabaseControl.register))"
```

Um e-mail processado **minutos antes** da cópia fica sem `body_full` e **a dedup não o reprocessa**
(ocorreu com o `email_control` 1192, das 11:40). Esperado, não defeito: os corpos anteriores ao
deploy são alvo da **Onda 4**.

---

### 7.3 Onda 3 — o que a execução ensinou (2026-08-01)

> ✏️ **Fechamento revisado em 2026-08-01 (code review adversarial):** os números abaixo são os do
> fim da implementação. O review posterior encontrou **1 bloqueante confirmado** — `_rest()` sem
> paginação, que corrompeu a proveniência de **68 dos 172** documentos (40%) e os tornava invisíveis
> a qualquer pergunta com recorte de data — mais 3 recomendados. Todos corrigidos, os 68 registros
> **reparados** (`--fix-provenance`) e os invariantes travados por teste: **843 pytest** (+8).
> Detalhe completo em `docs/review/2026-08-01-Features-max.md`. **Lição que generaliza:** consulta
> REST cujo resultado vira dado gravado precisa **paginar** — o corte do Supabase vem com HTTP 200,
> sem erro e sem sinal, e o backfill "concluído com sucesso" não é evidência de dado correto.

**Baseline:** 791 pytest · 1.208 Node. **Depois:** **835 pytest** (+44) · **1.213 Node** (+5) ·
lint/typecheck/prune limpos · vulture sem achado no código novo.

**Entregue:** migrations 107 e 108 · `fiscal_document` (append-only, RLS por remetente) ·
`fiscal_key.py` (parser determinístico, stdlib) · gancho no Passo 1 do reader · purga preservando
documento fiscal · backfill de **172 documentos** (92 NF-e + 80 CT-e) · **9ª tool
`documentos_fiscais`** · 17ª sugestão e 6º tema no painel.

**O número que justifica a onda:** **72 PDFs fiscais** que a próxima execução da purga teria
apagado agora estão preservados (órfãos no bucket: 150 → 78). Não era risco teórico — a purga de
15/07 já havia levado 67% dos CT-e.

**Quatro achados durante a execução:**

| # | Achado | Como foi pego |
|---|---|---|
| 🔴 **O6** | **O DV sozinho nunca foi suficiente.** Uma sequência de 44 dígitos dentro de um "Boleto de Aluguel" passou em UF (41), mês (09), modelo (59) e DV — e virou uma CF-e **de setembro de 1991**. Sequência aleatória fecha o módulo 11 com probabilidade ~1/11; as camadas precisam ser *independentes*. Foi acrescentada a 5ª: ano na janela [2006, corrente+1], já que nenhum documento fiscal eletrônico existe antes da NF-e (2006) | **Olhar o dado depois de gravar** — `min(issue_yearmonth)` saiu `9109` entre 172 linhas todas em 2604–2607. Nenhum teste apontaria: o parser fazia exatamente o que estava escrito |
| ⚠️ **O7** | **`barcode_dv_refuted` (FEBRABAN) NÃO serve para chave de acesso** e o erro seria silencioso: o DV do boleto fica na posição 4 com resto→1; o da SEFAZ, na 43 com resto→0. Reusá-la devolveria veredito plausível e errado. Daí `fiscal_key.py` ser módulo próprio, e não mais uma função no `febraban.py` | Leitura do código antes de reusar — a própria docstring da função já dizia que ela devolve `False` ("não há o que refutar") para chave de acesso |
| ⚠️ **O8** | **Idempotência que reporta "gravado" para duplicata é uma mentira operacional.** `ignore-duplicates` sem `return=representation` devolve 201 mesmo sem inserir, então o log de produção — a via pela qual se confere se a onda funciona — diria "registrado" no reprocessamento inteiro | Rodar a MESMA verificação duas vezes e conferir se o número mudava |
| 🟡 **O9** | O item 3.4 do plano dizia que `purge_orphan_attachments.py` "é arquivo de deploy e exige `--update`". **Não é** — `DEPLOY_GLOBS` cobre `skills/*/scripts/*.py` e `scheduler/*.ps1`, não `scripts/`. Quem exigiu `--update` foi o `fiscal_key.py` (arquivo NOVO em `skills/`), exatamente a lição do `febraban.py` | Ler o `DEPLOY_GLOBS` em vez de confiar no plano |

**Validação por oráculo EXTERNO (o que deu confiança no parser):** os campos decompostos batem
com o nome do arquivo original, que foi escrito pelo emissor e não pelo nosso código —
`Envio_Nf-e_No19016` → `doc_number` 19016; `CT-e_Autorizado_614177` → 614177;
`CT-e - Numero 1898003 serie 0` → número 1898003, série 0. Três emissores diferentes.

**Ganho não previsto:** o DACTE referencia a **NF-e da mercadoria transportada**, então a varredura
capturou 92 NF-e além dos 80 CT-e — inclusive NF-e emitidas pela própria OTIMOTEX
(CNPJ 47273917000123), que documentam o que saiu. Nada disso existia em nenhuma tabela.

**Duas consequências a registrar (não são defeitos):**

- **Grupo restrito vê ZERO documentos fiscais.** A policy da 107 reusa o recorte da 078 (por
  remetente), e quem envia CT-e é a transportadora — nenhum usuário do Comercial é remetente.
  Verificado com o papel real: ester **0**, barbara **172**. Mudar isso é decisão de política de
  acesso, não ajuste técnico.
- **PDF cifrado não entrega chave.** `_pdf_text` roda ANTES do `run_extraction`, que é quem
  descriptografa (boletos OBER/Amil). Não é regressão — antes não se capturava nada —, mas é o
  caso que a Onda 5 ou uma passada dedicada pode recuperar.

**Lição do DEPLOY (vale para toda onda com arquivo Python novo):** a lista de cópia não são "os
arquivos que a feature precisa" — são **os que MUDARAM**, e o `deploy-manifest.json` **vai junto**.
Ele é a régua, e o `check_deploy_parity.py` lê a régua **do diretório dele em produção**, não a do
repositório. Copiando só os `.py`, o veredito fica **enganoso ao contrário**: os arquivos novos
aparecem como `DIVERGENTE` (não batem o hash antigo) e o arquivo novo vira `EXTRA` — a saída acusa
"PRODUÇÃO DESATUALIZADA" com os arquivos **já corretos**. Foi o que aconteceu: `24/26 conferem`
enquanto o `read_emails.py` respondia `True True 4`. **Sintoma diagnóstico:** produção não cria
arquivo, então `EXTRA` casando `DEPLOY_GLOBS` **significa manifesto obsoleto**. Conferir o
SHA-256 do manifesto copiado antes de rodar o verificador separa "arquivo errado" de "problema
noutro lugar". Fechamento: **27/27, `exit=0`**.

**Custo assumido:** `_pdf_text` passou a ler o texto de TODO anexo (antes a leitura era pulada
quando remetente/assunto já haviam decidido a regra LEBIANCO). É uma segunda passada de pdfplumber
por PDF, na casa de centenas de ms — irrelevante perto do IMAP e da Claude API, e é o preço de a
chave fiscal não depender da regra de outra feature.

---

### 7.4 Onda 4 — executada em 2026-08-03 · **a premissa caiu, e o número prova**

**Resultado da passada única** (ensaio de 50 + passada completa, 264 mensagens, **0 falhas**):

| Medida | Antes | Depois | Δ |
|---|---|---|---|
| `financial_account_control` (count) | 673 | 673 | **+0** ✅ |
| `financial_account_control` `max(id)` | 822 | 822 | **+0** ✅ |
| `email_control` (count) | 1.166 | 1.166 | **+0** ✅ (nenhuma linha criada) |
| corpos pendentes (`body_full` nulo + keyword) | 506 | 436 | **−70** |
| `fiscal_document` | 172 | 179 | **+7** |
| objetos no bucket | 520 | 524 | **+4** |

O invariante nº 1 — *nunca gravar conta a pagar* — foi verificado **no banco**, não só por teste:
contagem e `max(id)` idênticos antes e depois. Quarentena vazia (nenhum upload falhou). Reexecutar
imediatamente devolve `a processar: 0 de 264` — idempotência provada em produção, não inferida.

#### 🔴 O achado que vale mais que o resultado: a janela já tinha fechado

O plano projetava recuperar **~115 PDFs de CT-e** e **440 corpos**. A caixa entregou outra coisa:

| | |
|---|---|
| Mensagens na **INBOX** | **264** |
| Linhas em `email_control` | **1.166** |
| **E-mails já processados que não estão mais na caixa** | **~900 (77%)** |
| CT-e recuperados | **0** |
| Corpos recuperados | 70 de 506 candidatos (**14%**) |

A premissa da onda era "o texto só existe no IMAP, então corra". O que a medição mostrou é que,
para 77% do acervo, **ele já não existe nem lá** — os e-mails saíram da caixa depois de
processados, e isso não tem nada a ver com a purga de 15/07, que era a causa suposta. As 7 chaves
novas são **todas NF-e** (uma delas veio dentro de um DACTE da SSW, a NF-e da mercadoria
transportada); nenhum CT-e.

> **A lição generaliza:** quando um plano se justifica por "a fonte é volátil, corra", o **primeiro
> passo tem de ser MEDIR a fonte** — não escrever o coletor. Um `--dry-run` de dois minutos, feito
> na Onda 2, teria revelado que a INBOX guarda ~3 meses de mensagens e que a recuperação histórica
> nunca foi possível na escala planejada. O código está certo e é reutilizável; a **premissa** é que
> nunca foi verificada.

#### O número documentado (440) era outro indicador

O `--dry-run` mediu **506** candidatos, não 440. Não é divergência: 440 contava os **truncados**
(perda medida em julho), e 506 conta **tudo com `body_full` nulo e keyword** — que é o conjunto que
a varredura preenche. O valor de referência para esta onda é sempre o do `--dry-run`, nunca o
histórico.

**Sobrou o quê:** 436 corpos que permanecem nulos (os e-mails saíram da caixa — irrecuperáveis) e
os ~115 CT-e da purga, também irrecuperáveis. Isso **fecha** a Onda 4: não há segunda passada que
traga mais, e o script continua disponível caso a caixa volte a acumular histórico.

---

### 7.4.1 O script (2026-08-03)

`scripts/varredura_historica.py` + `tests/test_varredura_historica.py` (**55 casos**) +
`VarreduraHistoricaSeguraTest` (**12 guardas**) e `SemProsaTest` (5) nas guardas cross-layer.
Suíte: **890 → 964** pytest, vulture limpo.
**Nenhuma migration** e **nenhum deploy** — o script vive em `scripts/`, fora do
`check_deploy_parity`, e roda da máquina de dev.

**Decisões de escopo tomadas com o Ricardo antes de escrever uma linha** (as três primeiras
mudariam materialmente o resultado):

| Decisão | Escolha | Por quê |
|---|---|---|
| E-mail fora de `email_control` | **não cria linha** | `fiscal_document` guarda a própria proveniência e não tem FK; criar linha mudaria as contagens de `/emails` |
| PDF de CT-e apagado pela purga | **re-sobe ao bucket, sem sobrescrever** | sem isso a onda registra a CHAVE e o PDF continua perdido |
| Escopo | **caixa inteira (`ALL`)**, com checkpoint | o histórico anterior a 01/04/2026 não existe em outra via |
| Corpo dos **251 sem keyword** | **não grava** (mantém a opção A do item 2.3) | o custo de FETCH deixou de valer aqui, mas o **PII** permanece: comunicação interna indexada e pesquisável pelo chat |
| PDF **sem chave de acesso** | **não sobe** (`--upload-all` como escape) | sem linha em `fiscal_document` a próxima purga o apagaria como órfão — seria pagar banda por algo destinado a ser deletado |
| Subpastas IMAP | **só INBOX**; o dry-run **lista** as demais com contagem | respeita a regra de nunca ler Spam/Lixo, e ainda assim mede o que há fora |

**Os quatro invariantes viraram ESTRUTURA, não disciplina** — cada um validado por mutante
(introduzir o defeito e conferir o vermelho; 15 mutantes ao todo, incluindo o caso inverso de
"mencionar em comentário **não** pode derrubar a guarda"):

| Invariante | Como é imposto |
|---|---|
| não marca `\Seen` | **EXAMINE** (`readonly=True`, em que o servidor não *pode* gravar flag) + `BODY.PEEK[]` em todo fetch + ausência de `STORE`/`+FLAGS` — três travas independentes |
| não grava conta | o identificador da tabela financeira **não existe no código**, só na prosa |
| `body_full` só quando nulo | filtro `&body_full=is.null` **na URL** — atômico no servidor, imune a corrida com o reader agendado |
| objeto nunca sobrescrito | função de upload própria sem `x-upsert`; 409 = "já existe", não é falha |

#### Três achados que só apareceram lendo o código real

| # | Achado | Consequência se passasse |
|---|---|---|
| 🔴 **V1** | `process_message` do reader usa `(INTERNALDATE RFC822)` — **sem PEEK**. Em caixa read-write isso marca `\Seen` **pelo protocolo**, independentemente de `--mark-seen` | copiar aquela linha marcaria milhares de e-mails como lidos numa caixa operada por pessoas |
| 🔴 **V2** | `data/pdfs_inbox` é território proibido, e o motivo não é colisão de nome: `retry_extraction.py:101,180` resolve PDFs **pelo nome** lá dentro, a partir do banco | um arquivo nosso cujo nome casasse um `source_file` pendente seria extraído por ele e **viraria conta** — furando o invariante nº 1 pela porta dos fundos |
| ⚠️ **V3** | `_connect_and_search` faz retry **só do search inicial** — nenhum dos milhares de FETCH está protegido | a queda no meio (o modo de falha esperado numa varredura) derrubaria o run inteiro |

#### O bug que a autorrevisão pegou depois de tudo verde

O checkpoint gravava `caixa.uidvalidity` **corrente**. Quando a reconexão aborta por UIDVALIDITY
diferente, esse atributo **já foi atualizado para o valor novo** — então o checkpoint sairia com a
identidade NOVA ao lado dos UIDs do inventário ANTIGO, ficaria "compatível" na execução seguinte, e
ela retomaria **pulando as mensagens erradas, em silêncio**: exatamente o desastre que a checagem
existe para impedir. Corrigido gravando a identidade capturada **na abertura**.

> **E o primeiro teste que escrevi para esse bug passava com o defeito reintroduzido.** A falha
> injetada era consumida pelo fetch de `RFC822.SIZE` (que não tem reconexão) e o caminho da
> reconexão nunca era exercido — `0 == 0` com cara de garantia. Só o mutante revelou isso. É a
> lição O9–O11 aparecendo de novo: **um teste de código defensivo só vale depois de ver o vermelho.**

**Verificação operacional — EXECUTADA em 2026-08-03**, nesta ordem: `--dry-run` (dimensionou a
caixa: 264 mensagens, e foi ele que derrubou a premissa) → `--dry-run --deep` (195 anexos, 79 com
chave, 7 novas) → `--limit 50` real conferindo `count(*)`/`max(id)` de
`financial_account_control` antes e depois → passada completa → reexecução provando idempotência
(`a processar: 0 de 264`). Resultado na §7.4.

> ⚠️ **A varredura expôs um defeito ATIVO na purga — corrigido no mesmo dia.** Ao conferir a
> afirmação "a purga está liberada", medi: dos **68 órfãos**, **10 continham chave de acesso
> fiscal VÁLIDA** (18 chaves; um PDF com **6 DACTEs**). Os 4 objetos da varredura estavam
> protegidos, mas a limitação da Onda 3 seguia ativa **e crescendo** — 4 em 01/08, **10** em
> 03/08, porque `access_key` é UNIQUE e cada CT-e reenviado cria um objeto cuja chave já está
> registrada pelo primeiro.
>
> A `purge_orphan_attachments` passou a **decidir pelo conteúdo**: baixa cada candidato, lê o
> texto e preserva o que carrega chave válida. Resultado: **68 → 58 a apagar**. Detalhe em
> `CLAUDE.md` → "a purga decide pelo CONTEÚDO".
>
> **A lição vale além da purga:** a afirmação "está liberada" era uma **inferência** — os objetos
> novos estavam protegidos, logo o resto também estaria. Medir custou dois minutos e revelou o
> contrário. Conclusão sobre efeito colateral de rotina destrutiva se **mede**, não se deduz.

---

### 7.5 Onda 6 — executada em 2026-08-10 · duas premissas do plano caíram

| Medida | Resultado |
|---|---|
| Migrations | **111–115**, todas idempotentes, aplicadas por psql |
| Colunas novas | 5 geradas em `financial_account_control` + tabela `dim_date` (11.323 dias) |
| Funções novas | `br_easter`, `br_holiday_name`, `dias_uteis`, `fac_installment_number`, `fac_installment_base`, `analytics.fornecedores_recorrentes`, `analytics.parcelamentos` |
| Guardas | `tests/test_onda6_campos_derivados.py` — **40 casos**, validados contra **12 mutantes** |
| Gates | pytest **1.186** · frontend-vite **847** · api-backend **527** · lint 0/0 · typecheck 0 · prune 0 |

#### 🔴 O roadmap mandava usar `to_date`, e `to_date` é STABLE

Este documento afirmava, no item 6.1, que *"`to_date` com máscara explícita é IMMUTABLE"*. **É
falso.** A primeira tentativa da migration 112, escrita ao pé da letra, morreu com
`ERROR: generation expression is not immutable`. Conferido em `pg_proc` desta base:

| função | `provolatile` | serve em coluna gerada? |
|---|---|---|
| `to_date(text, text)` | `s` (STABLE) | ❌ |
| `make_date(int, int, int)` | `i` (IMMUTABLE) | ✅ |

É a **mesma classe de erro** que o alerta do 6.1 existia para evitar (`::date` é STABLE) — o plano
só errou qual função escapa dela. `to_date` aceita padrões dependentes de sessão (era, timezone), e
isso a marca STABLE inteira, independentemente da máscara que o call site usa.

> **Lição:** volatilidade se confere em `pg_proc`, não se deduz de "tem máscara explícita, logo é
> determinística". Custou uma migration recusada; poderia ter custado a descoberta em produção.

#### 🔴 `installment_total` não existe — o sufixo é o ORDINAL

O item 6.3 pedia `installment_number` / `installment_total`. Verificado em
`skills/email-reader/scripts/read_emails.py:5289`: o reader monta `f"{doc}/{parcela}"`, onde
`parcela` vem da coluna "Parcela" da tabela do corpo — é `1`, `2`, `3`. Os dados confirmam:
`19019 / 1`, `19019 / 2` e `19019 / 3` são **três contas do mesmo documento**.

Criar a coluna escreveria "3 de 3" num carnê de 12. Entrou no lugar `installment_base` (o documento,
que permite agrupar) + `analytics.parcelamentos()`, que devolve `parcelas_observadas` e
**`parcelas_faltando`** — e já achou **5 carnês com as parcelas 1 e 2 sem conta cadastrada**, um
passivo invisível que o "total" inventado jamais mostraria.

#### O portão de plausibilidade da parcela funcionou

Separar 113 (funções) de 114 (colunas) transformou o dry-run em degrau estrutural: a regra foi
medida sobre os **762 `invoice_number` reais** antes de qualquer coluna existir. Resultado: **19 de
40** candidatos aceitos (banda exigida 8–25; previsão 12–20), com as 40 linhas lidas à mão. Os 21
rejeitados são nosso-número (`09/00018287242`, `109/09116046`, `112/250207258`). Conferido também
que não há formato de parcela **fora** do conjunto candidato.

#### 🔴 Cadência entre CONTAS produzia resposta absurda — e só rodar mostrou

A primeira versão de `fornecedores_recorrentes` media o intervalo entre contas consecutivas.
Executada contra o dado real, devolveu *"HYOSUNG SC — cadência semanal, confiança provável"* com
mediana de **2 dias**. Duas causas, ambas invisíveis na revisão do código:

1. **Várias contas no mesmo vencimento.** OTIMOTEX tem **53 contas em 21 datas**; FEDEX, 35 em 17.
   Os intervalos vinham cheios de zeros. Corrigido agrupando por **data distinta**.
2. **Bandas derivadas da tolerância.** Com tolerância de 5 dias, "semanal" virava `[2,12]` e
   "quinzenal" `[10,20]` — faixas **sobrepostas**. Hoje as bandas são fixas e disjuntas, e a
   tolerância governa só a dispersão (`regular`).

Depois da correção: `BRASPRESS` (mediana 7, min 7, max 7) → semanal/provável; `SIEG` (mediana 31) →
mensal/provável, batendo com o baseline; `ARLETE` (mediana 7, máximo 64) → rebaixada a
`insuficiente` pela checagem de extremos.

> **Lição:** revisão de código não pega classificador mal calibrado. Só executar contra o dado real
> mostra que a saída é absurda — e a saída absurda era plausível o bastante para passar despercebida
> num relatório.

#### As guardas que sobreviveram ao mutante — e as três que não

Dos 12 mutantes, **3 sobreviveram na primeira rodada**, cada um denunciando uma guarda que lia a
coisa errada:

| Mutante sobrevivente | Por que a guarda não pegou |
|---|---|
| apagar a coluna do schema de leitura | procurava no arquivo inteiro, e a entrada `coluna: true` do `.omit()` casava o mesmo regex |
| remover o descascamento do sufixo `(N)` | as duas funções usam o mesmo `regexp_replace`; removê-lo de uma deixava o texto na outra |
| trocar o vetor de Páscoa | a mensagem do `RAISE EXCEPTION` repete a data esperada, e a guarda achava o texto ali |

As três foram corrigidas por **escopo**: bloco do schema de leitura, corpo da função, e a
**comparação** em vez da mensagem. Todas as 12 são pegas hoje.

---

## 8. Guardrails (valem em toda onda)

1. **Coluna que depende do tempo não vira coluna** — vira view/função *(lição da migration 095: 123
   de 126 contas vencidas ficaram presas em "a vencer" por meses, em silêncio)*.
2. **Objeto novo em `analytics`** → `GRANT` explícito para `authenticated` **E** `REVOKE EXECUTE
   ... FROM PUBLIC, anon` explícito *(lição 097/099, **confirmada na Onda 1**: sem o REVOKE as
   funções nasceram chamáveis com a anon key; o `ALTER DEFAULT PRIVILEGES` da 098 não persiste)*.
3. **Tabela nova** → RLS + `REVOKE` de escrita de `authenticated`; o default do Supabase é
   permissivo *(lição 056/057/079/081)*.
3b. **Validação de identificador precisa de camadas INDEPENDENTES, e o DV não é uma delas
   sozinho** *(lição O6 da Onda 3)*: sequência aleatória fecha módulo 11 em ~1/11 dos casos. Some
   domínio (modelo/UF) + plausibilidade temporal. E **olhe o dado depois de gravar** — o falso
   positivo apareceu num `min()`/`max()` trivial, não em teste.
4. **Teste nunca assere número absoluto** — oráculo diferencial ou janela histórica fechada.
4b. **Teste que promete garantia tem de entregá-la** *(lição O9–O11 da Onda 2)*. Se o nome ou o
   comentário diz "ANTES de", "alinhado com X" ou "cabe no limite de Y", a asserção precisa
   **observar** aquilo — não um número mágico nem uma chamada isolada. Duas ferramentas:
   **guarda cross-layer** (ler o outro arquivo e comparar, como `log.test.ts` faz com as
   migrations) e **validação por mutante** (introduzir o defeito e conferir que fica vermelho).
   Toda guarda que faz parsing leva **sanidade do parser** — um regex que para de casar
   transforma o teste em `0 === 0`, verde para sempre.
5. **Deploy Python** → `check_deploy_parity.py --update` no mesmo commit; cópia em produção é
   manual, feita pelo usuário.
6. **Nada chega ao usuário sem tool.**
7. **Uma onda por vez**, com o protocolo da seção 3 cumprido do início ao fim.

---

## 9. Auditoria do plano — 2026-07-31

Revisão adversarial do próprio roadmap, conferindo cada onda contra o **código e o banco reais**
(não contra a memória do que foi escrito). Resultado: **1 defeito crítico**, 4 médios, 3 menores.

### 🔴 Crítico (corrigido)

| # | Achado | Correção |
|---|---|---|
| A1 | **Onda 6.1 quebraria a extração de e-mails.** `competence_date` contém **`YYYY-MM`** (mês), não data — `'2026-06'::date` é erro de sintaxe. O formato é contrato de 3 camadas (prompt do Claude, CSV template, Zod). Convertida a coluna, **todo INSERT do reader passaria a falhar** | Trocado por **coluna nova derivada** `competence_month` (`GENERATED ... to_date(...)`), mantendo `competence_date` TEXT e intocada |

> Este achado é a razão de ser desta auditoria: o plano prometia "não quebrar nada existente" e
> continha uma alteração que pararia o pipeline. Ele só apareceu ao conferir o **conteúdo real** da
> coluna e o **prompt de extração** — não estava visível na descrição do item.

### ⚠️ Médios (corrigidos)

| # | Achado | Correção |
|---|---|---|
| A2 | Onda 4 declarava "retomável por checkpoint" **sem definir onde** o checkpoint viveria | Definido: `data/varredura_checkpoint.json` (arquivo local; estado efêmero, não merece tabela) |
| A3 | **Rate limit** estava na Onda 8 de 9 — sendo o **único item com risco financeiro aberto hoje** (sem teto de custo na Claude API) | **Promovido para a Onda 1** (item 1.5) |
| A4 | Ondas que tocam `skills/` não listavam **deploy em produção** como item, embora seja manual e já tenha acumulado 13 pendências no passado | Item 3.7 explícito; e registrado que a **Onda 4 não exige deploy** (roda de qualquer máquina com `.env`) |
| A5 | Onda 6 acrescenta colunas na fato sem prever atualização de **`packages/shared`** (fonte única de tipos) e da `vw_payables` | Item 6.7 + nota de dependência transversal |

### 🟡 Menores (corrigidos)

| # | Achado | Correção |
|---|---|---|
| A6 | Ondas 8 e 9 sem **esforço** declarado (7 de 9 tinham) | Declarados |
| A7 | Ambiguidade: item 1.4 dizia "= Fase 4 do chat", mas a Fase 4 tem **3 itens** e o 1.4 cobria só os testes | Texto precisado: 1.4 cobre os testes de regressão; few-shot segue na Onda 8 |
| A8 | Só a Onda 1 tinha métrica de sucesso explícita | Critérios de pronto na tabela abaixo |

### 🔵 Segunda passada — confirmação do gancho no reader (2026-07-31)

Verificação dirigida: *"o reader será mesmo atualizado para gravar em outras tabelas o que não
entra em `financial_account_control`?"* **Sim — e está nas Ondas 2 e 3.** Mas conferir contra o
código revelou duas imprecisões, ambas corrigidas:

| # | Achado | Correção |
|---|---|---|
| A9 | O plano dizia que o gancho fiscal ficaria "no ponto `skipped_nonpayable`" — mas existem **7 pontos distintos** desse contador, e só alguns são documento fiscal | Movido para o **Passo 1** de `extract_and_store_accounts`: um único ponto, que grava sempre que houver **chave de acesso válida**, inclusive quando a linha **vira conta** (o boleto de transporte que carrega a chave do CT-e, hoje perdida) |
| A10 | O plano supunha que todo e-mail tem corpo guardado — mas `_register_ignored` grava **sem corpo algum**, nem `body_preview` (*"não baixamos o corpo"*). Os **545 ignorados** ficariam fora da busca textual | Item **2.3** criado como decisão explícita (manter × passar a baixar o corpo do ignorado), com recomendação de **passar a baixar**; e registrado que o truncamento existe em **dois** pontos do código |

**Resumo do que o reader passa a fazer, por onda:**

| Onda | Alteração no `read_emails.py` | Grava em |
|---|---|---|
| 2 | Deixa de truncar o corpo em 500 chars (2 pontos) · opcionalmente passa a guardar o corpo do ignorado | `email_control.body_full` |
| 3 | No Passo 1, registra todo documento com chave de acesso válida | `fiscal_document` |
| 5 | Extrai itens/conteúdo via LLM | `fiscal_document_item` |

Em **nenhuma** dessas o reader passa a criar conta a pagar onde hoje não cria — a regra de
`financial_account_control` fica intacta.

### 🟣 Terceira passada — auditoria pós-focos de despesas/DRE (2026-07-31)

Revisão das adições feitas depois da 2ª passada (Ondas fiscais, varredura, focos de auditoria).
**1 defeito crítico — introduzido pela própria correção do achado A1.**

| # | Achado | Correção |
|---|---|---|
| 🔴 **A11** | **A coluna gerada `competence_month` quebraria o INSERT.** Medido: `to_date('2026-13-01','YYYY-MM-DD')` lança **`22008: date/time field value out of range`**; texto livre lança erro de parsing. Como `competence_date` vem do **Claude**, um desvio de formato pararia a extração — o mesmo dano que a correção de A1 queria evitar | Expressão **blindada por regex** (`CASE WHEN competence_date ~ '^\d{4}-(0[1-9]|1[0-2])$' THEN … ELSE NULL END`), validada no banco: mês 13 → NULL, lixo → NULL, válido → data. Hoje há **0** valores fora do padrão — o risco era **futuro** |
| ⚠️ A12 | Itens 1.6/1.7 precisam do **nome** do tipo, mas a `vw_payables` expõe só `chart_subgroup_type_id` | Registrado o JOIN com `financial_type_group` — e **verificado** que ela tem policy para `authenticated` + `GRANT SELECT`, logo funciona sob `SECURITY INVOKER` |
| ⚠️ A13 | Critério de pronto da Onda 4 dizia "mesma **contagem** de contas ao fim" — **impraticável**: o reader agendado roda a cada 5 min e cria contas legítimas durante a varredura | Trocado por comparação do **conjunto de ids** capturado antes de iniciar |
| ⚠️ A14 | A linha "Tributos" do demonstrativo poderia ser implementada por ids de subgrupo hardcoded | Fixado que sai da **natureza do grupo** (`= 4`). Verificado: todo o Passivo é "Passivo Tributário" — 40 contas, R$ 2.214.143,31, batendo com a linha |

> **A lição desta passada:** o achado A11 **não existia antes da 2ª auditoria** — ele nasceu da
> correção do A1. Toda correção introduz superfície nova, e uma auditoria só do que foi planejado
> originalmente teria passado direto por ele. Vale para as ondas: **quem corrige, reaudita**.

### ✅ Verificado e correto (não mexer)

| # | Verificação | Resultado |
|---|---|---|
| V1 | **Numeração de migrations** | **103–118, sem lacuna nem colisão.** O 115 aparece 2× de propósito (itens 6.4 e 6.5 na mesma migration) |
| V2 | **Acrescentar colunas em `vw_payables` quebra as 6 tools?** | **Não.** Nenhuma função usa `SELECT *` (0 ocorrências na migration 098; 10 referências nomeadas). Além disso, `CREATE OR REPLACE VIEW` só permite **acrescentar no fim** — o próprio PostgreSQL recusa mudança de ordem/tipo |
| V3 | **Referências cruzadas** após as duas renumerações | Consistentes (conferidas por varredura) |
| V4 | **Cobertura das solicitações** | As 6 demandas estão endereçadas — ver tabela abaixo |

### Rastreabilidade das solicitações

| Solicitação | Onde ficou |
|---|---|
| Tabelas agregadas / retroalimentadas | **Descartada** (seção 5) com gatilho objetivo na Onda 9 |
| Campos novos preenchidos automaticamente | **Onda 6** (derivar, nunca inventar) |
| Registrar dados de anexos + corpo de e-mail | **Ondas 2, 3 e 5** |
| Perguntas pré-definidas (PDF de auditoria) | **Seção 6** + entrega na Onda 1 |
| NF-e, NFS-e, CF-e, cupom e itens de produto | **Ondas 3, 5 e 9** |
| Varredura completa da caixa postal | **Onda 4** |
| **Foco de auditoria: despesas fixas e variáveis** | **Onda 1** (itens 1.6 e 1.7) — dado já existe, faltava o eixo na tool |
| **Foco de auditoria: DRE** | **Descartado** (0 receitas) → entregue como **"Demonstrativo de Custos e Despesas"** na Onda 1; DRE completo só via integração de receitas (Onda 9) |

### Critério de "pronto" por onda

| Onda | Está pronta quando… |
|---|---|
| 1 | as **18** sugestões respondem no chat · a bateria de regressão passa · o rate limit rejeita excesso · o **demonstrativo FECHA** (soma das linhas = total de saídas do período, incluindo tributos e não-classificado) |
| 2 | um e-mail novo grava corpo > 500 chars e a busca textual o encontra |
| 3 | um CT-e novo vira linha em `fiscal_document` com DV válido **e** a purga (dry-run) o preserva |
| 4 | dry-run reporta o total da caixa; ao fim, **nenhum `id` NOVO** em `financial_account_control` cuja origem seja a varredura — comparar o conjunto de ids capturado antes de iniciar, **não a contagem** (o reader agendado roda a cada 5 min e cria contas legítimas durante a passada) |
| 5 | uma NF-e com N itens produz N linhas, e o total dos itens **não** aparece em nenhum relatório financeiro |
| 6 | `competence_month` preenchida, pipeline gravando normalmente, suíte Python verde |
| 7 | ✅ uma edição manual gera linha em `audit_log`, com o autor certo — e a curadoria de /consulta continua funcionando (regressão classe 074) |
| 8 | ✅ few-shot revisado e **gate de acesso por grupo ativo** — grupo não liberado recebe 403 curado, a tentativa aparece no `ai_chat_log` e a cota do grupo chega ao rate limit |
| 9 | — (condicional) |

---

## 10. Relacionado

- `docs/arquitetura-chat-ia-pagamentos.md` — desenho do chat (§11 roadmap, §15 ADRs)
- `docs/padrao-execucao.md` — gates de aceite e robustez
- `CLAUDE.md` — regras mandatórias, invariantes do pipeline e histórico de migrations
