# progress.md — estado atual do `pagamentos`

> **Verdade com prazo de validade.** Este é o único arquivo do projeto cujo conteúdo se espera
> que esteja errado no mês seguinte. Invariante (o que não pode quebrar) vive no `CLAUDE.md`;
> o porquê e as medições vivem em `docs/`; procedimento vive nas skills de `.claude/skills/`.
>
> 🔴 **Contador que o comando responde melhor NÃO se escreve aqui.** Antes de anotar um número,
> pergunte se existe comando que o produz — se existir, anote o comando, não o número.
>
> **Atualizado em:** 2026-08-20

---

## Como derivar o estado (preferir sempre ao número escrito)

| Pergunta | Comando |
|---|---|
| Qual a última migration aplicada? | `ls supabase/migrations \| tail -1` |
| Qual o número da próxima? | a última + 1 — **nunca reserve número com antecedência** (lição da Onda 5: 109/110/111 foram reservados e consumidos por outro trabalho) |
| Quantos arquivos no manifesto de deploy? | `node -e "console.log(require('./scheduler/deploy-manifest.json').length)"` |
| Produção está em paridade? | `py -3 scheduler\check_deploy_parity.py` **na máquina de produção** (exit 1 em divergência) |
| Qual o total da suíte? | `npm test` (Node) · `py -3 -m pytest tests/ -q` (Python) — medir com `--maxWorkers=1` no `frontend-vite` |

---

## Roadmap de enriquecimento de dados — 9 ondas

Plano e invariantes de cada onda: [docs/roadmap-enriquecimento-dados.md](docs/roadmap-enriquecimento-dados.md).
**Execução é uma onda por vez**, cumprindo o protocolo de 5 passos da §3 do plano.

| # | Onda | Status |
|---|---|---|
| 1 | 9 colunas na `vw_payables` · `demonstrativo_despesas` · rate limit | ✅ concluída |
| 2 | `body_full` + `body_search` + `buscar_emails` | ✅ concluída · deploy aplicado |
| 3 | `fiscal_document` pela chave de acesso · `documentos_fiscais` | ✅ concluída · deploy aplicado |
| 4 | varredura histórica da caixa postal | ✅ concluída (sem migration, sem deploy) |
| 5 | conteúdo do CT-e | ⚠️ **PARCIAL — só o item 5.3.** 5.1/5.2 (itens de NF-e) **suspensos** por falta de população |
| 6 | `dim_date` · colunas derivadas · recorrência/parcelamento | ✅ concluída |
| 7 | trilha de auditoria (`audit_log`) · 2 tools | ✅ concluída · validada em produção |
| 8 | gate de acesso ao chat por grupo · prova do recorte de RLS | ✅ concluída |
| 9 | onda **condicional** — 7 gatilhos medidos, 1 ocorreu | ⚠️ **1 de 7 itens** (pontualidade) |

**Próxima:** retomar a Onda 5 depende de o acervo de DANFEs crescer — ver "Pendências".

---

## Produção (pipeline Python)

Procedimento completo na skill **`deploy-producao`**. Histórico de cada deploy:
[docs/deploy/historico-deploys.md](docs/deploy/historico-deploys.md).

| Item | Estado |
|---|---|
| Último deploy | **2026-09-15** — falha da RPC de fornecedor vai a `/erros` · contribuinte de guia e beneficiário = pagadora ⇒ sk 1 · `invoice_number` = Nº do Documento (com a correção da cauda Espécie/Aceite) · dedup de parcelas. Arquivos copiados: `extract_pdf.py`, `read_emails.py`, `deploy-manifest.json`. Migrations 138–142 **já aplicadas** (base compartilhada). PR #253, merge `3b66e47` — o manifesto da `main` tem o mesmo hash conferido em produção |
| Paridade verificada | ✅ **em produção** (2026-09-15) — `check_deploy_parity.py`: **32/32 conferem, 0 faltando, 0 divergentes, 0 extras**; hash do manifesto confere com o DEV. Validação funcional: **7/7 `True`** (`rpc_falha`, `contribuinte`, `beneficiario_pagadora`, `dedup_parcela`, `sondagem_sem_email`, `docnum`, `cauda_corrigida`). ⏳ Last Run Result do Email Reader e 1º e-mail processado depois do deploy: a confirmar |
| Tarefas agendadas | 5 ativas — Email Reader (5 min) · Cobrança (10:00) · Backup (02:00) · Baixa (08:00) · Gatilhos Roadmap (dia 1, 07:00) |

⏳ **Não exercitado em produção ainda:** a captura **automática** de conteúdo de CT-e a partir
de um e-mail novo (Onda 5). O backfill cobriu o acervo e o fluxo tem teste; falta chegar a
próxima fatura agregada (são semanais). Conferir com
`SELECT count(*) FROM fiscal_document WHERE content_extracted_at >= '<data>'`.

---

## Banco

- **Última migration:** derivar (ver tabela acima). Changelog: [docs/db/historico-migrations.md](docs/db/historico-migrations.md).
- **Regras para migration nova:** skill `migrations-supabase`.
- **A base é COMPARTILHADA dev+prod** — migration aplicada vale para os dois; não há passo
  separado de banco no deploy.

---

## Pendências

| Item | Estado | Gatilho de reabertura |
|---|---|---|
| Onda 5 — itens de NF-e (5.1/5.2) | **SUSPENSO** | acervo de DANFEs crescer (eram 15, com 6 detectáveis) |
| CT-e via DACTE individual (5.3-b, com LLM) | **não implementado** | layout por transportadora inviabiliza regex |
| Handler SIEG (boleto por link) | **ADIADO** | entrar uma fatura SIEG **em aberto** para validar o download |
| Lmed/mdnet (boleto por link) | **ADIADO** | tem CAPTCHA com imagem — sem solução automática |
| DKIM no DNS (cobrança) | ✅ **RESOLVIDO em 2026-09-01** | Return Path + DKIM configurados e autenticados via subdomínio `envio.otimotex.com.br` (CNAME `envio`→`smtplw.com`, CNAME `_dmarc.envio`→`_dmarc.smtpdlv.com.br`, TXT `smtp._domainkey.envio`) — confirmado por consulta pública ao DNS. Ver [env_reference.md](skills/cobranca-vencidos/references/env_reference.md) |
| RBAC completo (`permission`/`group_*`) | **desenhado, não implementado** | [docs/design/permissoes-por-grupo.md](docs/design/permissoes-por-grupo.md) |
| Upload no `/contas` pré-preencher campos | **ideia, não implementar ainda** | decisão registrada na memória |
| Guia de arrecadação lida por **Vision** não recebe as duas correções de guia | ✅ **RESOLVIDO em 2026-08-20** | As duas regras passaram a valer nas **3** fontes visuais. O ramo Vision virou `_build_records_vision` (a assimetria com `_build_records_text` era o defeito); a data-limite chega pelo campo novo **`payment_deadline`** do prompt e quem decide adotá-la é `apply_arrecadacao_deadline`, gated pelo barcode e **compartilhada com o caminho de texto**; texto disponível (tier 2, página espelhada) vence o campo do modelo. O valor ganhou 2ª barreira contra OCR (`arrecadacao_value_refuted`, ≥10× ⇒ não sobrescreve e anota). Fechada de carona a lacuna do `docx_vision` no gate `barcode_self_refuted` (era tupla literal). Suíte **1593** (+26), **7 mutantes** vermelhos. **Nenhum dado histórico precisou de correção** — a medição de 2026-08-19 achou 0 divergências nas 9 guias auditáveis. Detalhe em [docs/knowledge/pipeline-extracao.md](docs/knowledge/pipeline-extracao.md) |
| Risco residual do Vision: a data-limite **transcrita pelo modelo** entrava sem contraprova | ✅ **RESOLVIDO em 2026-08-20** (2ª rodada) | Sobrava a assimetria: o **valor** cruzava com o documento e a **data** era validada só na FORMA. Reproduzido antes de corrigir — `payment_deadline` de **2126** gravava conta que **nunca vence** (invisível em KPI, aging e cobrança); **2016**, nascida vencida há dez anos. Agora `arrecadacao_deadline_refuted` cruza com o vencimento que o modelo leu do **mesmo documento** (teto **180 dias** × folga real medida de **0–3**), em **duas direções**, **opt-in pela procedência** (a data do TEXTO é determinística e entra sem cruzamento) e com referência **por item** (carnê). `_iso_date` deixou de aceitar dígito a mais depois da data. **Medição do acervo:** 988 contas, **0** com `due_date` a mais de 180 dias da extração; guias por Vision entre **−11 e +16 dias** — classe nunca ocorrida, guarda preventiva. Suíte **1608** (+14), **8 mutantes** vermelhos |
| Fallback 3 de fornecedor (por NOME do bloco encaminhado) morto no caminho de PDF | **achado, não corrigido** | lê `payload['email_body_excerpt']`, que o caminho de anexo nunca povoa. Não revivido de propósito: desemboca em `resolve_supplier`, que **cria** fornecedor |
| 8 guias JUCE antigas sem texto extraível | **não reclassificadas** | são escaneadas/`.docx` e já estão pagas; provar o acrônimo exigiria leitura por Vision (custo de API). As legíveis foram conferidas e **nenhuma era DAR/DARE** |
| Empresa pagadora LE BLANC (`sk_company = 4`) | ✅ **pipeline em produção (2026-09-11)** · chat de IA aguardando PR | migration 135 aplicada; falta o `tools.ts`/`gateway.ts` (filtro pela empresa 4) ir ao Vercel via PR para `main`. Detalhe em [docs/knowledge/pipeline-extracao.md](docs/knowledge/pipeline-extracao.md) |
| TanStack Query em `Consulta`/`Emails` | **rollout pendente** | padrão já aplicado em `SuppliersPage` |
| Fornecedor = razão social da pagadora + lembrete de vencimento (Leadster, 2026-09-14) | ✅ **pipeline em produção (2026-09-14)** · dados ✅ (migrations 136 e 137 aplicadas) | paridade ✅ 32/32; 1º sinal no dado: conta 1474 confirmada pelo lembrete de ~17/09. Residuais aceitos: assunto com texto ANTES da razão social ("Confirmação de Títulos TEXTIL…", conta 160) não é pego pela guarda exata; entre a fatura sem data e o 1º lembrete a conta aparece `vencido`. Detalhe em [docs/knowledge/pipeline-extracao.md](docs/knowledge/pipeline-extracao.md) |
| Falha da RPC de fornecedor caía no pagador (SINDMESTRES, contas 895/1396 — 2026-09-15) | dados ✅ (migrations 138 e 139 aplicadas) · ✅ **pipeline em produção (2026-09-15)** | paridade ✅ 32/32 e validação `rpc_falha: True`. Sinal no dado: uma falha da RPC aparece em `/erros` como `db_erro` "Falha ao resolver fornecedor — … — RPC de fornecedor falhou: …", nunca como conta sob a OTIMOTEX. Detalhe em [docs/knowledge/pipeline-extracao.md](docs/knowledge/pipeline-extracao.md) |
| Contribuinte de guia de tributo virava fornecedor-apelido (13 guias em sk 4/1400/1415 — 2026-09-15) + favorecido real vence o CNPJ do contribuinte | dados ✅ (migration 140 aplicada) · ✅ **pipeline em produção (2026-09-15)** | validação `contribuinte: True`. A varredura da sonda P2 da 140 deve seguir em zero para guias gravadas depois de 2026-09-15 (o 1400 removido continua casando pela RPC por nome; quem o impede é a regra). Detalhe em [docs/knowledge/pipeline-extracao.md](docs/knowledge/pipeline-extracao.md) |
| Boleto com BENEFICIÁRIO = a própria pagadora criava fornecedor-apelido (conta 933 no sk 1227 — 2026-09-15) | dados ✅ (migration 141 aplicada) · ✅ **pipeline em produção (2026-09-15)** | validação `beneficiario_pagadora: True`. A varredura da sonda P3 da 141 deve seguir em zero. ⚠️ Residual: um boleto "CONFECCOES OTIMOTEX" **sem** CNPJ extraído não dispara a regra e casa o 1227 removido. Detalhe em [docs/knowledge/pipeline-extracao.md](docs/knowledge/pipeline-extracao.md) |
| `invoice_number` = Nº do Documento nas contas antigas (`reprocess_document_number.py` — 2026-09-15) | ✅ **executado em modo real** em 2026-09-15, 14:44–14:50 UTC · dados ✅ (5 contas corrigidas pela migration 142) · ✅ pipeline em produção (2026-09-15, `docnum`/`cauda_corrigida: True`) | **338 contas** alteradas, 1 evento cada no `audit_log`: só `invoice_number`, `ator_via='servico'`, e em todas o valor anterior era cópia do nosso número. **Restantes na seleção do script: 240** (132 `pdf_vision`, 108 `pdf_text`) — PDF escaneado, leitura ambígua ou ficha que imprime o próprio nosso número; ficam para revisão manual. O parser da execução levava a Espécie/Aceite de 6 letras junto do número em 5 contas (**123, 558, 1051** "… RECIBO"; **147, 1043** "… DM NAO ACEITO"). Parser corrigido (review max, [docs/review/2026-09-15-Features-max.md](docs/review/2026-09-15-Features-max.md)) e as 5 contas corrigidas pela **migration 142** (aplicada em 2026-09-15, 17:56 UTC; valores conferidos no PDF). 🔴 **O script roda no DEV e importa o `extract_pdf.py` do repositório** — é o arquivo local que precisa estar corrigido antes de reexecutar, não o de produção. Conferir: `SELECT count(*) FROM financial_account_control WHERE invoice_number ~ '\d' AND invoice_number ~ '\s[^\s\d]+$'` deve dar 0. Derivar o lote: `SELECT count(DISTINCT registro_id) FROM audit_log WHERE tabela='financial_account_control' AND campos_alterados @> ARRAY['invoice_number'] AND criado_em BETWEEN '2026-09-15 14:40+00' AND '2026-09-15 14:55+00'` |
| CABERNET 0107-1507 (`email_control` 888) | **irrecuperável, sem perda** | fora da INBOX e sem anexo no Storage — não há o que reprocessar. A quinzena está coberta pela conta **574** (venc. 22/07, paga), do e-mail 893 que trouxe o mesmo boleto 1h23 depois. O erro 257 fica como histórico |

---

## Gatilhos da Onda 9 (medição mensal)

Medidos em **2026-08-13**: dos 7 gatilhos, **só um ocorreu** (pontualidade de pagamento →
migration 121, 12ª tool). Seguem sem evidência: CF-e/NFC-e (0 documentos), NFS-e (1 conta),
text-to-SQL (0 pergunta descoberta no log), tabelas agregadas (tools em 2–7 ms contra teto de
500), receitas/DRE (0 entradas) e conciliação (sem integração).

A série vive em **`analytics.roadmap_trigger_snapshot`** (migration 122), alimentada pela tarefa
agendada *Pagamentos - Gatilhos Roadmap* (skill `roadmap-gatilhos`, dia 1 às 07:00).
**Não copie a série para cá** — consulte a tabela.

```sql
SELECT trigger_key, measured_on, fired, metrics
FROM analytics.roadmap_trigger_snapshot ORDER BY measured_on DESC, trigger_key;
```

---

## Triagem de backlog — SonarCloud (não reinvestigar do zero)

Análise **CI-based** desde 2026-07-18 (`sonar-project.properties` + `.github/workflows/sonarcloud.yml`).
O gate julga só código **novo** (`new_*`); o backlog do `main` é dívida que **não bloqueia PR**.

| Achado | Decisão |
|---|---|
| 106 issues Python | 100% code smells; as 9 "vulnerabilidades" eram falsos positivos |
| 4× `S8707` (path de CLI em `extract_pdf.py`) | **Won't Fix** — CLI de operador confiável; suprimido por `sonar.issue.ignore.multicriteria` |
| `S1192` de vocabulário de domínio (mime types, "nota fiscal"…) | **não corrigir** — a constante piora a legibilidade |
| `S3776`/`S8786`/`S7632` no núcleo de `read_emails.py` | **não corrigir em sweep** — função a função, com A/B sobre dados reais (precedente: `extract_from_email_body`, 61→17) |
| 37 smells mecânicos + 1 blocker (077) + S6418/S6819/S6845/S125 | ✅ corrigidos |

⚠️ Resolver issue na UI ("Won't Fix") **não é permanente** — o engine reabre ao re-basear.
A supressão durável é o `sonar-project.properties` versionado.

---

## Snapshot da suíte (informativo — derive antes de citar)

Medido em **2026-08-17**: Node **1.583** (frontend-vite 908 em 146 arquivos · api-backend 620 ·
packages/shared 53 · portal-next 2) e Python **1.486**.

🔴 **Ao fechar uma onda, cite o INCREMENTO, não o total** — o incremento é propriedade da onda e
não envelhece; o total muda a cada PR. Meça contra o commit anterior num `git worktree` isolado.
