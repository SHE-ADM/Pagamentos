# progress.md — estado atual do `pagamentos`

> **Verdade com prazo de validade.** Este é o único arquivo do projeto cujo conteúdo se espera
> que esteja errado no mês seguinte. Invariante (o que não pode quebrar) vive no `CLAUDE.md`;
> o porquê e as medições vivem em `docs/`; procedimento vive nas skills de `.claude/skills/`.
>
> 🔴 **Contador que o comando responde melhor NÃO se escreve aqui.** Antes de anotar um número,
> pergunte se existe comando que o produz — se existir, anote o comando, não o número.
>
> **Atualizado em:** 2026-08-18

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
| Último deploy | **2026-08-17** — anexos `.docx` (`docx_content.py` novo, `extract_pdf.py`, `read_emails.py`) |
| Paridade verificada | ✅ na aplicação do deploy, com smoke de import na própria máquina |
| Tarefas agendadas | 5 ativas — Email Reader (5 min) · Cobrança (08:00) · Backup (02:00) · Baixa (08:00) · Gatilhos Roadmap (dia 1, 07:00) |

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
| DKIM no DNS (cobrança) | **a configurar** | melhora entregabilidade; SPF já autentica, não é pré-requisito |
| RBAC completo (`permission`/`group_*`) | **desenhado, não implementado** | [docs/design/permissoes-por-grupo.md](docs/design/permissoes-por-grupo.md) |
| Upload no `/contas` pré-preencher campos | **ideia, não implementar ainda** | decisão registrada na memória |
| TanStack Query em `Consulta`/`Emails` | **rollout pendente** | padrão já aplicado em `SuppliersPage` |

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
