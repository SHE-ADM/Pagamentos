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
| `body_preview` — teto de 500 chars | **439 de 1.133 (39%) truncados** |
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

**Decisão a tomar no início da onda (item 2.3):**

| Opção | Efeito |
|---|---|
| **A — manter como está** | Busca textual cobre só e-mail com keyword. Mais barato, mantém o fluxo atual intacto |
| **B — passar a baixar o corpo também do ignorado** | Busca cobre a caixa inteira. Custo: baixar o corpo (texto, **não** anexo) de todo e-mail; muda o fluxo de `_register_ignored` |

Recomendação: **B**, porque o corpo é texto puro (barato — o custo alto é o anexo, que permanece
não sendo baixado) e é exatamente o material que a Onda 4 tentaria recuperar depois via IMAP. Fazer
agora evita reprocessar mais tarde.

**Truncamento em dois lugares** — ambos precisam mudar: `SupabaseControl.register`
(`(rec.get("body_preview") or "")[:500]`) e `process_message` (`body_text[:500]`).

**Backfill:** **impossível** para os 439 truncados — o texto só existe no IMAP. Reprocessáveis
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
| 3.7 | 📦 **Deploy em produção** — `read_emails.py` + `purge_orphan_attachments.py` + `check_deploy_parity.py --update` no mesmo commit | — |

#### ⚠️ 3.4 é BLOQUEADOR — sem ele a purga destrói o trabalho desta onda

`purge_orphan_attachments.py` considera **órfão** todo objeto não referenciado por
`financial_account_attachment.storage_key` **ou** `financial_account_control.source_file`.
Ele **não conhece** `fiscal_document`. Rodado após esta onda, apagaria exatamente os PDFs de CT-e e
NF-e recém-registrados — de forma **irreversível**, reportando "órfãos removidos" com naturalidade,
sem nenhum sinal de erro.

O item 3.4 **precisa entrar junto da 3.1**, não depois. É arquivo de deploy (`scripts/`), portanto
exige `check_deploy_parity.py --update` no mesmo commit.

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
| 439 corpos truncados em 500 chars | `body_preview` nunca guardou o texto completo |
| Documentos fiscais anteriores ao pipeline | e-mails nunca processados |

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

| Item | O quê | Migration |
|---|---|---|
| 5.1 | Tabela `fiscal_document_item` (1:N → `fiscal_document`) — **itens de produto da NF-e** | 109 |
| 5.2 | Extração por LLM do DANFE: código, descrição, NCM, CFOP, quantidade, unidade, valor unitário, valor total | — |
| 5.3 | Campos de conteúdo do CT-e: peso, volumes, origem/destino, valor do frete, NF vinculada | 110 |
| 5.4 | Tool `itens_nota_fiscal(...)` / extensão de `documentos_fiscais` | 111 |

**Destrava:** *"o que compramos deste fornecedor?"*, análise por NCM/CFOP, custo de frete por rota
— perguntas hoje impossíveis em qualquer camada do sistema.

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

---

### ONDA 6 — Campos derivados na tabela fato

**Por quê:** enriquecer o que já existe, **derivando** — nunca inventando.

| Item | O quê | Migration | Nota |
|---|---|---|---|
| 6.1 | **`competence_month` DATE — coluna NOVA e derivada** (`competence_date` permanece TEXT) + trigger de default | 112 | 🔴 ver o alerta abaixo — **não converter o tipo** |
| 6.2 | **`dim_date` + feriados nacionais** | 113 | 100% gerável, risco zero |
| 6.3 | **`installment_number` / `installment_total`** — parse do `invoice_number` | 114 | o pipeline já gera `doc/parcela`, só não estrutura |
| 6.4 | **`days_late`** como **coluna gerada** (`GENERATED ALWAYS AS STORED`) | 115 | depende só da própria linha |
| 6.5 | **`extraction_confidence`** derivado de `extraction_source` | 115 | permite o chat qualificar ("veio de OCR") |
| 6.6 | **Recorrência por cadência** — função/tabela auxiliar | 116 | ⚠️ **por cadência, não por valor** — só 3 de 11 têm valor estável |

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

### ONDA 7 — Governança / auditoria

| Item | O quê | Migration |
|---|---|---|
| 7.1 | Popular `audit_log` (existe com **0 linhas**) via trigger em `financial_account_control` | 117 |
| 7.2 | Tool de auditoria | 118 |

**Destrava:** *"quais usuários vêm alterando campos sensíveis"* — hoje irrespondível, pois só o
**último** editor é guardado (456 contas editadas por usuário real, 367 com situação alterada).
**Esforço:** M.

---

### ONDA 8 — Hardening do chat (Fase 4 do roadmap original)

| Item | O quê |
|---|---|
| 8.1 | ~~Rate limit~~ — **promovido para a Onda 1 (item 1.5)** pela auditoria de 2026-07-31 |
| 8.2 | Tuning de few-shot a partir do `ai_chat_log` acumulado |
| 8.3 | **Gate de uso da IA por usuário** — **decisão do usuário: é o ÚLTIMO item de todos** |

**Esforço:** P–M.

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
| §5 — *quais usuários alteram campos sensíveis* | ⚠️ **Adiada (Onda 7)** — só o último editor é guardado; `audit_log` vazio |
| §4 — *falha da esteira de extração* | 🟡 Parcial na Onda 1; completa exige tool sobre `email_control` (Onda 2) |

---

## 7. Registro de execução

| Onda | Status | Migrations aplicadas | Data | Observações |
|---|---|---|---|---|
| 1 — Destravar colunas existentes | ⬜ não iniciada | — | — | — |
| 2 — Corpo de e-mail | ⬜ não iniciada | — | — | — |
| 3 — Fiscais camada 1 (chave: CT-e/NF-e/CF-e) | ⬜ não iniciada | — | — | — |
| **4 — Varredura histórica (passada única)** | ⬜ não iniciada | — | — | requer Ondas 2 e 3 |
| 5 — Fiscais camada 2 (itens de NF-e via LLM) | ⬜ não iniciada | — | — | requer Onda 3 |
| 6 — Campos derivados | ⬜ não iniciada | — | — | — |
| 7 — Auditoria | ⬜ não iniciada | — | — | — |
| 8 — Hardening | ⬜ não iniciada | — | — | — |
| 9 — Condicional (NFS-e, CF-e, DPO…) | ⬜ não iniciada | — | — | — |

---

## 8. Guardrails (valem em toda onda)

1. **Coluna que depende do tempo não vira coluna** — vira view/função *(lição da migration 095: 123
   de 126 contas vencidas ficaram presas em "a vencer" por meses, em silêncio)*.
2. **Objeto novo em `analytics`** → `REVOKE EXECUTE ... FROM PUBLIC` explícito *(lição 097/099)*.
3. **Tabela nova** → RLS + `REVOKE` de escrita de `authenticated`; o default do Supabase é
   permissivo *(lição 056/057/079/081)*.
4. **Teste nunca assere número absoluto** — oráculo diferencial ou janela histórica fechada.
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
| 7 | uma edição manual gera linha em `audit_log` |
| 8 | few-shot revisado e gate de uso por usuário ativo |
| 9 | — (condicional) |

---

## 10. Relacionado

- `docs/arquitetura-chat-ia-pagamentos.md` — desenho do chat (§11 roadmap, §15 ADRs)
- `docs/padrao-execucao.md` — gates de aceite e robustez
- `CLAUDE.md` — regras mandatórias, invariantes do pipeline e histórico de migrations
