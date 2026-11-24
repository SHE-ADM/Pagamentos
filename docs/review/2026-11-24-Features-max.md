# Code Review — Features (2026-11-24)

## Resumo

Alvo: nenhum (review do diff completo)
Modo: max (passo de ataque + verificação adversarial)
Delta: 25 arquivos alterados, 12 novos, +1764/−232 linhas versionadas e 3.628 linhas em arquivos novos
Régua: `CLAUDE.md` (global, workspace e projeto), skills `pipeline-extracao`, `testes-e-gates`, `deploy-producao`, `scripts-manutencao`, `docs/knowledge/pipeline-extracao.md`
Gates: pytest 2319 passed · vulture 11 itens, 0 em símbolo do delta · `tests/test_doc_links.py` 10 passed · paridade do manifesto 34/34 · CRLF 0 arquivos · lint/typecheck/Vitest não executados (o delta não toca nenhum arquivo Node) · e2e não executado (não se aplica; exige navegador)
Verificação adversarial: 8 contestações; 2 confirmados, 4 enfraquecidos, 0 refutados

Revisado o trabalho do incidente de 18 a 21/11/2026 (fila do Email Reader parada por um anexo) e
as quatro ressalvas do relatório: classificação de erro da API, sonda de saúde, quarentena, janela
`SINCE`, isolamento de exceção por e-mail, alerta ativo, imagem decorativa, status `duplicidade`,
guarda de 24 h da purga e o script de cobertura da caixa. O código de produção resistiu ao passo
de ataque: nenhum defeito bloqueante nele. O único bloqueante está num teste novo, que só passa
com a chave da API do `.env` local e reprova o `pytest` do CI. A auditoria por mutante rodou 117
mutantes sobre o código novo: 113 vermelhos, 4 verdes (os 4 viraram achados).

## Achados

### 🔴 Bloqueantes

- [tests/test_poison_attachment.py:239] `test_conteudo_invalido_com_nome_hostil_e_falha_do_documento` depende da `ANTHROPIC_API_KEY` do `.env` local. `[verificado]`
  Falha:     sem a variável (CI: `.github/workflows/sonarcloud.yml:85` roda `pytest tests/` sem `env:` e sem `.env`), `extract_with_vision` levanta por chave ausente antes de `_vision_source_block`; o registro sai `erro_api`, o teste falha e o passo de pytest reprova todo push em `Features` e todo PR para `main`. Localmente o verde vem de estado herdado do ambiente, e o ramo que o nome promete só é exercitado por acaso.
  Evidência: `ANTHROPIC_API_KEY= py -3 -m pytest tests -q` → `1 failed, 2318 passed` (`AssertionError: 'billing' not found in 'ERRO_API: ANTHROPIC_API_KEY não definida no .env'`); com `sk-test` → verde. Os 8 runs verdes recentes do CI não contam: o arquivo é untracked e nunca rodou lá. É o único teste do arquivo sem `mock.patch.dict`.
  Correção:  fixar a chave no teste com `mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-test"})` e travar a ausência de chamada com `mock.patch("anthropic.Anthropic")` + `assert_not_called()`.
  Regra:     `CLAUDE.md` § 2 — "Teste não pode depender de estado LOCAL herdado do ambiente".
  Veredito:  CONFIRMADO (3 de 3 lentes: impacto no CI, reprodução na suíte inteira, reprodução inline)

### 🟡 Recomendados

- [tests/test_poison_email_isolation.py:330] `test_run_reader_busca_com_a_janela_ampliada` promete que o critério entregue ao IMAP é o calculado, mas só observa um dos três argumentos do call site. `[verificado]`
  Falha:     um refactor que troque `ctrl.latest_received_at()` por `None` ou `known_ids` por `set()` na chamada de `_search_since` em `run_reader` desliga a marca-d'água (máquina parada deixa buraco) ou a neutralização da linha órfã (janela presa em 15 dias) e nenhum teste fica vermelho.
  Evidência: os dois mutantes no call site → suíte inteira sem nenhum vermelho novo; o mutante de controle (`pending_api` → `{}`) fica vermelho. Todos os dublês fixam `latest_received_at.return_value = None` e um `known_ids` que nunca coincide com a pendência.
  Correção:  dois casos que executam `run_reader`: um com marca-d'água antiga e sem pendência, outro com pendência cujo e-mail já está em `known_ids`; validar por mutante.
  Regra:     `CLAUDE.md` § 2 — "Testar a função PURA não cobre o CALL SITE".
  Veredito:  CONFIRMADO

### 🔵 Opcionais

- [skills/email-reader/scripts/read_emails.py — `_search_since`] a marca-d'água mais antiga que o piso de 15 dias é descartada sem log; a janela volta a `hoje − days` e nada avisa. Medido: 14 dias de parada cobre tudo, 15 dias volta a "ontem". `[verificado, rebaixado]` — ENFRAQUECIDO: não é regressão (antes a janela era sempre fixa), o piso está documentado na skill e o cenário exige 15 dias sem nenhum e-mail registrado. O mínimo defensável é um `log.warning` no call site e a ressalva na docstring ("máquina parada por dias não deixa buraco" vale até 14 dias).
- [tests/test_purge_recent_objects.py:75] `test_instante_sem_fuso_e_lido_como_utc` não distingue UTC de fuso local (mutante `astimezone()` fica verde). `[verificado, rebaixado]` — ENFRAQUECIDO: o ramo é defensivo (a Storage API devolve `…Z`) e, no pior fuso, sobram 10 h de folga contra uma janela real de minutos.
- [tests/test_reader_alert.py:254] `test_carimbo_de_outra_pendencia_tambem_segura_o_alerta` não separa "todas as pendências" de "só as dos parados" (mutante fica verde). `[verificado, rebaixado]` — ENFRAQUECIDO: a consequência do defeito seria um aviso repetido dentro das 6 h, nunca o silêncio.
- [tests/test_poison_email_isolation.py:76, tests/test_reader_alert.py:128, tests/test_run_reader_uid_crash.py:75] os testes que executam `run_reader` dependem de `EMAIL_KEYWORDS` conter "boleto". `[verificado, rebaixado]` — ENFRAQUECIDO: o padrão é preexistente, o default do código contém "boleto" e o CI (sem `.env`) passa; só quebra com um `.env` local sem essa keyword (46 testes).
- [skills/email-reader/scripts/read_emails.py:111] `_isolated_failures` levanta `OverflowError` com `1e400` no payload, e o laço de `pending_api_errors` fica fora do `try` — contrariando "qualquer coisa que não seja um inteiro vale 0" e "nunca levanta". Só alcançável com dado que ninguém grava.
- [skills/email-reader/scripts/read_emails.py — `_on_uid_crash`] o e-mail registrado como `falha` pelo crash não tem a linha `erro_api` anterior apagada; fica uma linha órfã em `/erros`.
- [skills/email-reader/scripts/read_emails.py:7528] a linha "Extração parcial" é gravada a cada run enquanto o mesmo e-mail seguir adiado por outro anexo (até ~6 linhas antes da quarentena).

## Pendências (trabalho incompleto)

- [repositório] o código dos dois lotes já roda em produção (paridade 34/34), mas nada foi commitado: produção e `origin` divergem até o commit e o PR — recomendada (depende de pedido explícito).
- [`.env` de produção] `READER_ALERT_TO` não definida: o alerta ativo está desligado em produção. Já registrado em `progress.md`; fecha com `reader_alert.py --test` saindo com exit 0 — recomendada (ação manual do usuário).
- [auditoria por mutante] mutantes planejados que não rodaram: recusa de documento no caminho de texto (`extract_pdf.py:2010-2012`), `_try_barcode_vision`, linha `erro_api` única por e-mail, ramo de extração parcial, ordem remetente-de-sistema × alerta em `_header_ignore_reason`, e a guarda `SomenteLeituraTest` do `check_inbox_coverage` — opcional.

## Drift código × documentação

- `_search_since` (docstring: "máquina parada por dias não deixa buraco") diverge do comportamento medido além de 14 dias; a skill `pipeline-extracao` declara o piso, a docstring não — decisão pendente do usuário (ver o 1º opcional).
- `_quarantine_due` e a skill dizem que uma "parada só do Vision passaria na sonda", mas `api_health_probe` envia um bloco de IMAGEM; o cenário que passa na sonda parece ser o de bloco `document` (PDF). Não verifiquei contra a API — decisão pendente do usuário.

## Não coberto

- Os 8 arquivos de teste novos (2.827 linhas) foram lidos e auditados por subagente, com mutantes numa cópia isolada; eu li por inteiro o código de produção, `conftest.py`, `check_inbox_coverage.py`, `reader_alert.py`, a migration 154 e o diff dos testes alterados.
- A sonda, a quarentena e o alerta não foram exercitados contra a API Anthropic, o SMTP nem a caixa IMAP reais; o `--test` do canal e o `check_inbox_coverage.py` não foram executados neste review.
- Paridade com a máquina de produção: o manifesto confere com o working tree (34/34), mas não há como verificar daqui se os arquivos de deploy mudaram depois da cópia.
- Migration 154: lida e conferida quanto a idempotência e sondas; não reexecutada contra o banco.
- Purga: a corrida entre a listagem e o DELETE (a inspeção de conteúdo leva mais de 10 minutos) só é fechada pela guarda de 24 h; reuso da mesma chave por um reprocessamento concorrente não foi medido.
- Gates Node (lint, typecheck, Vitest, ts-prune) e SonarCloud: não executados — o delta não toca arquivo Node, e o Sonar só roda no CI.

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| B1 | Teste depende da `ANTHROPIC_API_KEY` do `.env` local | ✅ corrigido | `tests/test_poison_attachment.py:239` fixa a chave com `mock.patch.dict` e trava a ausência de chamada à API; a suíte inteira com a chave vazia foi de `1 failed, 2318 passed` para `2321 passed` |
| R1 | Call site de `_search_since` só observava um dos três argumentos | ✅ corrigido | `tests/test_poison_email_isolation.py`: dois casos novos que executam `run_reader` (marca-d'água; ids conhecidos, com sanidade). Mutantes no call site: `latest_received_at()` → `None` e `known_ids` → `set()` ficaram VERMELHOS; ambos revertidos e conferidos por `cmp` |
| O1 | Marca-d'água além do piso descartada sem log | ⏸️ adiado | ENFRAQUECIDO na contestação; decidir entre só logar ou limitar a marca-d'água ao piso é escolha sua |
| O2 | Teste do fuso na purga não distingue UTC de local | ⏸️ adiado | ENFRAQUECIDO; sem consequência prática medida |
| O3 | Teste da carência não separa "todas as pendências" | ⏸️ adiado | ENFRAQUECIDO; pior caso é um aviso repetido |
| O4 | Testes dependem de `EMAIL_KEYWORDS` conter "boleto" | ⏸️ adiado | ENFRAQUECIDO; preexistente, o CI passa |

Gates após a correção: pytest 2321 (+2) · pytest com a chave vazia 2321 · paridade do manifesto 34/34 · CRLF 0
Baseline (Passo 3):    pytest 2319 · pytest com a chave vazia 1 failed, 2318 passed · paridade 34/34 · CRLF 0
Re-review do diff da correção: sem achado novo (só os dois arquivos de teste mudaram; nenhum arquivo de produção nem de deploy foi alterado, e o hash do `read_emails.py` segue igual ao do manifesto)

Não corrigido por decisão sua: os dois itens de drift, os opcionais sem contestação e as pendências (commit/PR, `READER_ALERT_TO` em produção, mutantes que não rodaram).
Nada foi commitado.
