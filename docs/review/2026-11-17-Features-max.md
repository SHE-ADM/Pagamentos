# Code Review — Features, working tree (2026-11-17)

## Resumo
Alvo: nenhum (review do diff completo)
Modo: max (ataque + adversarial)
Delta: 6 arquivos alterados, 1 novo (`tests/test_aviso_reminder.py`, 120 linhas), +83/−9 linhas (sem ruído de EOL: `--ignore-cr-at-eol` dá o mesmo stat)
Régua: CLAUDE.md (raiz), `.claude/skills/pipeline-extracao`, `.claude/skills/testes-e-gates`, `docs/knowledge/pipeline-extracao.md`
Gates: pytest 2118 passed · vulture sem achado no delta (9 avisos preexistentes: 7 rotas Flask, falsos positivos documentados, e 2 em `febraban.py`, fora do diff) · ruff não é gate do projeto (sem `[tool.ruff]`) · lint/typecheck TS não aplicáveis (o delta não toca TS) · manifesto: SHA-256 do `read_emails.py` = `171a5e64…c8a2f4f`, igual ao registrado
Verificação adversarial: 1 contestação; 0 confirmados, 1 enfraquecido, 0 refutados

A mudança faz `subject_is_reminder` também descartar o aviso COMBINADO (reiteração ordinal ou aviso pós-pagamento) antes do download. O regex é linear (sem risco de ReDoS), trata nulo e vazio, e a mudança é mínima. O teste executa o call site `run_reader` e foi validado por mutante: com o ramo do aviso removido, 3 testes ficam vermelhos. Os casos de ataque levantados não aparecem no histórico real (medição no banco). Sem bloqueante e sem recomendado.

## Achados

### 🔴 Bloqueantes
Nenhum

### 🟡 Recomendados
Nenhum. O único candidato (O1 abaixo) foi rebaixado pela contestação.

### 🔵 Opcionais
- [skills/email-reader/scripts/read_emails.py:2615 / 8609] [verificado, rebaixado] Reiteração ordinal ("Último aviso", "Aviso final") é descartada sem conferir se a dívida original foi registrada. Se a 1ª emissão nunca virou conta, o boleto anexado ao aviso vira `ignorado`. A contestação mostrou três coisas: o risco não é novo (o mesmo gate já valia para "lembrete"), o descarte fica visível em `/emails` com motivo, e o histórico medido tem 0 casos. Decisão de negócio possível: status de revisão quando houver anexo PDF e nenhuma conta aberta do remetente.
- [read_emails.py:2631] NBSP no assunto é descartado por `_strip_accents_lower` ANTES do colapso de espaços, o que cola as palavras: "Último aviso" vira "ultimoaviso" e o filtro não casa. É falso negativo (direção conservadora). Medido: 19 de 3.584 assuntos têm NBSP, 0 perto de "aviso". Correção: colapsar `\s+` antes do strip.
- [read_emails.py:2616] `\d{1,2}\s*[oa]` aceita espaço: "Pedido 5 o aviso" e "NF 12 a aviso" casam. Medido: 0 ocorrências no histórico.
- [read_emails.py:2616] "1.º aviso", "2a. aviso", "1ºaviso" e "Sexto aviso" não casam. São falsos negativos conservadores.
- [read_emails.py:8607/8613] O comentário "Assunto com 'lembrete'" e a tag de log `[IGN lembrete]` não mencionam o aviso combinado. O motivo gravado ("Lembrete/aviso") já está correto.

## Pendências (trabalho incompleto)
Nenhuma. Nenhum marcador TODO/FIXME/skip/print no diff nem no arquivo novo.

## Drift código × documentação
Nenhum. `docs/knowledge/pipeline-extracao.md`, a skill `pipeline-extracao`, `progress.md` e `historico-deploys.md` descrevem o mesmo comportamento do código.

## Não coberto
- A verificação em produção registrada em `historico-deploys.md`/`progress.md` (paridade 32/32, smoke 9/9, `LastTaskResult` 0) é relato do usuário e não foi reexecutada: a máquina de produção é inacessível por regra.
- A medição "o filtro pega só 3 dos 3.579 e-mails" não foi refeita sobre o regex completo; as contagens próprias deste review cobrem só NBSP e o ordinal com espaço.
- Docs (`.md`) revisados por leitura, sem gate além de `tests/test_doc_links.py`, que passou dentro do pytest.

---

## Correções aplicadas (pedido explícito do usuário: "resolver todas as observações opcionais")

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| O1 | Reiteração descartada sem conferir a conta original | ⏸️ mantido por decisão do usuário | Regra de negócio confirmada em 2026-11-17: segue `ignorado`, visível em `/emails`, recuperável por `reprocess_message.py` (0 casos no histórico) |
| O2 | NBSP cola as palavras antes do colapso | ✅ corrigido | `read_emails.py` `subject_is_reminder`: colapso de `\s+` ANTES do strip; mutante M1 morto |
| O3 | `\d{1,2}\s*[oa]` aceitava "5 o aviso" | ✅ corrigido | Marcador ordinal COLADO ao número; mutante M2 morto |
| O4 | "1.º", "2a.", "1ºaviso", "Sexto aviso" não casavam | ✅ corrigido | `\.?` em torno do marcador, `\s*` antes de "aviso", ordinais até "décimo"; mutantes M3/M4 mortos |
| O5 | Comentário e tag `[IGN lembrete]` defasados | ✅ corrigido | Comentário cita o aviso combinado; tag `[IGN lembrete/aviso]` (sem consumidor no repo) |

Gates após a correção: pytest 2118 · vulture só com os avisos antigos · stat igual com `--ignore-cr-at-eol`
Baseline (Passo 3):    pytest 2118 · vulture só com os avisos antigos
Regressão no histórico (3.585 assuntos, só leitura): o regex novo casa os MESMOS 3 e-mails do anterior (3628, 3164, 2262)
Re-review do diff da correção: sem achado novo
Manifesto regravado: `read_emails.py` → `94d7a615…03708006`

Também alterado: `docs/knowledge/pipeline-extracao.md` (a regra do ordinal descreve o comportamento novo).
Não alterado: `historico-deploys.md`/`progress.md` registram o deploy de 2026-11-17 com o SHA `171A5E64…`, e a produção agora DIVERGE do repositório até uma nova cópia.
Nada foi commitado.
