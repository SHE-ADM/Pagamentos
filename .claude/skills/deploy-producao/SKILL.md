---
name: deploy-producao
description: >-
  Levar o pipeline Python do projeto `pagamentos` para a máquina de PRODUÇÃO
  (C:\Sheild\API\Pagamentos) e responder "produção está atualizada?". Cobre os 4 pipelines
  agendados (email-reader, cobranca-vencidos, backup-supabase, baixa-automatica): quais
  arquivos copiar, em que ORDEM, o manifesto de paridade, o comando de validação e as
  armadilhas que já quebraram produção antes (módulo novo importado no topo, manifesto
  esquecido, dependência nova, tarefa do Agendador que não muda de horário sozinha). Acione
  SEMPRE que o usuário disser "deploy", "copiar para produção", "atualizar produção",
  "produção está atualizada?", "check_deploy_parity", "publicar o reader", ou quando uma
  alteração em `skills/*/scripts/*.py` ou `scheduler/*.ps1` estiver pronta para ir ao ar —
  mesmo sem dizer "skill".
---

# Deploy para produção — pipeline Python

## Regra que não se negocia

🔴 **A máquina de produção fica em OUTRO LOCAL FÍSICO. Você (Claude) NÃO a enxerga e NUNCA
executa nada nela.** `C:\Sheild\API\Pagamentos` não existe no ambiente de desenvolvimento.

Toda instalação em produção — cópia de arquivos, `setup-*-task.ps1`, `pip install`, reinício de
serviço, qualquer comando — é feita **pelo próprio usuário, manualmente**. Não tente, não se
ofereça para tentar, não simule que foi feito. **Seu trabalho termina em:** (1) o código correto no
repositório e (2) instruções copiáveis — arquivos, ordem, comando de validação e o que esperar.

Produção **não é um clone git**: é um deploy mínimo (`scheduler/` + `skills/` + `.env` + `data/` +
`logs/`), sem `.git`. Não existe `git pull` lá.

## Passo 1 — O que mudou?

Liste os arquivos de deploy alterados. **Conte pelo que MUDOU, não pelo que a feature precisa:**

```bash
git status --porcelain -- 'skills/*/scripts/*.py' 'scheduler/*.ps1' scheduler/deploy-manifest.json
git diff --stat HEAD -- 'skills/*/scripts/*.py' 'scheduler/*.ps1'
```

🔴 **Um arquivo que entra no manifesto entra na lista de cópia.** O manifesto guarda **hash**, não
intenção: se você omitir da instrução um arquivo cujo hash mudou (porque "a feature funciona sem
ele"), o verificador vai acusá-lo **para sempre** depois de uma cópia que a doc chamou de completa
— e alerta que grita sem parar é alerta que se aprende a ignorar.

`scripts/` (na raiz) **não** é território de deploy: fica fora dos `DEPLOY_GLOBS`. São scripts
manuais de manutenção, rodados do dev.

## Passo 2 — Regravar o manifesto (no DEV, antes de instruir)

```bash
py -3 scheduler/check_deploy_parity.py --update
```

🔴 **No mesmo commit da alteração.** E o **`deploy-manifest.json` VIAJA JUNTO** com os `.py` na
lista de cópia — é a régua que o verificador lê **do diretório de produção**.

Se um arquivo **NOVO** passou a ser necessário em produção, ele precisa entrar em `DEPLOY_GLOBS`
antes — é o caso que ninguém percebe faltar (aconteceu com `febraban.py` e com `fiscal_key.py`).

## Passo 3 — Montar a instrução de cópia

Tabela `De (dev) → Para (produção)`, **na ordem de cópia**, terminando pelo manifesto.
**Os arquivos, pré-requisitos e o comando de validação de cada um dos 4 pipelines estão em
[pipelines.md](pipelines.md) — consulte antes de montar a lista.**

🔴 **Módulo NOVO importado no topo vem PRIMEIRO — ou os dois juntos.** `extract_pdf.py` importa
`febraban.py` e `fiscal_key.py` no topo: com o módulo ausente o import falha e **nenhum PDF é
extraído**, não só a feature nova. A assimetria entre os pipelines é deliberada — `read_emails.py`
**degrada** (avisa no log, `Deploy parcial?`) e `extract_pdf.py` **estoura**, para um rename futuro
aparecer alto e cedo em vez de virar silêncio.

Caminho correto é `skills\<pipeline>\scripts\`, **nunca** `scheduler\` — o `run_reader.ps1` executa
`$PROJECT_ROOT\skills\email-reader\scripts\read_emails.py`.

**Os deltas de `read_emails.py` são cumulativos:** cada cópia carrega as pendências anteriores.

Verifique também, e diga explicitamente quando **não** se aplicar:

| Item | Quando entra |
|---|---|
| **`.env`** | só quando a mudança lê variável nova (ex.: `EMAIL_KEYWORDS`). O `.env` **não é versionado** — é edição manual no arquivo de produção |
| **Dependência Python** | módulo novo (`pypdf`) exige `py -3 -m pip install` na máquina do scheduler; copiar arquivo não basta |
| **Migration** | a Supabase é **compartilhada dev+prod** — migration já aplicada **não** tem passo de banco em produção |
| **`setup-*-task.ps1`** | 🔴 copiar arquivo **NÃO** move uma tarefa já registrada no Agendador. Horário/gatilho novo exige **re-executar** o `setup-*-task.ps1` como Administrador |

## Passo 4 — Comando de validação

Um `py -3 -c "…"` que prove que **a alteração** chegou, não só que o arquivo mudou. Diga o
resultado esperado.

```powershell
cd C:\Sheild\API\Pagamentos
py -3 -c "import sys; sys.path.insert(0,'skills/email-reader/scripts'); import read_emails as R; print(hasattr(R,'<simbolo novo>'))"
```

Quando o horário da cópia for incerto, a presença de uma constante prova só que o arquivo mudou —
use `inspect.getsource` da função para provar que a alteração está lá:

```powershell
py -3 -c "import sys, inspect; sys.path.insert(0,'skills/email-reader/scripts'); import read_emails as R; print('grava:', 'body_full' in inspect.getsource(R.process_message))"
```

⚠️ **O console de produção é PowerShell.** A quebra de linha dentro do comando vai como `\r\n`
**literal** (a barra invertida não é escape do PowerShell), **nunca** como `` `r`n ``, que vira
CR/LF real e parte a string Python no meio (`SyntaxError: unterminated string literal`). Forma que
funciona nos dois shells: **aspas duplas externas + aspas simples internas + `\r\n`**. Trocar as
aspas de lugar também quebra.

## Passo 5 — Conferir a paridade (o usuário roda, em produção)

```powershell
cd C:\Sheild\API\Pagamentos
py -3 scheduler\check_deploy_parity.py
```

Compara o SHA-256 dos arquivos de deploy com o manifesto e sai com **exit 1** em divergência —
portanto agendável. Fim de linha é normalizado (CRLF copiado não vira falso positivo).

**Como ler o resultado:**

| Saída | Significado |
|---|---|
| `FALTANDO` | arquivo não foi copiado |
| `DIVERGENTE` **+ validação funcional OK** | 🔴 **o manifesto é que está velho** — copie o manifesto antes de recopiar qualquer `.py` |
| `EXTRA` casando `DEPLOY_GLOBS` | 🔴 **manifesto obsoleto** — produção não cria arquivo |

🔴 **NUNCA editar o manifesto à mão em produção, nem rodar `--update` lá.** Ajustar um hash faz o
verificador dizer "OK" sobre arquivo que não é o do repositório; `--update` em produção regrava a
régua a partir do que está lá, transformando desatualização em "paridade" instantânea. Nos dois
casos a ferramenta passa a **mentir a favor** — o pior estado possível para ela.

Conferir se o manifesto chegou íntegro, antes mesmo do verificador:

```powershell
(Get-FileHash deploy-manifest.json -Algorithm SHA256).Hash
py -3 -c "import json;print(len(json.load(open('deploy-manifest.json'))['files']))"
```

## Passo 6 — Registrar

Acrescente uma entrada em `docs/deploy/historico-deploys.md`: data, o que mudou, arquivos e **a
lição não-óbvia**, se houver. O passo-a-passo operacional não se repete ali — ele é este arquivo.

Se a mudança tiver invariante novo, ele vai para o `CLAUDE.md`, não para o histórico.

## Duas exclusões deliberadas em `DEPLOY_EXCLUDE` (não "completar" a lista)

- `scheduler/deploy-prod.ps1` roda **no dev** (copia PARA produção) e o usuário **não o usa** — ele
  prefere cópia manual. Não proponha esse script.
- O **próprio verificador** fica de fora: um manifesto que se auto-inclui muda de hash a cada edição
  do script e acusaria "produção desatualizada" falsamente.

Incluir qualquer um dos dois produz um `FALTANDO` eterno.

## Por que este procedimento existe

Até 2026-07-29 o estado de produção só era conhecido relendo avisos espalhados pela documentação. O
resultado foram **13 deploys pendentes acumulados**, o mais antigo com 19 dias — correções mescladas
em `main` que não valiam em produção, sem nada apontando isso. **Arquivo esquecido não dá erro:** o
pipeline segue rodando a versão velha e o bug "corrigido" continua acontecendo.

Histórico do que cada deploy fez: `docs/deploy/historico-deploys.md`.
