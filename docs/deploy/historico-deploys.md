# Histórico de deploys

## 2026-08-07 — Vision multi-boleto: carnê escaneado deixava de virar conta

**Sintoma:** e-mail com boletos escaneados ficava `extraído` com **0 contas** e uma linha
`sem_valor` em `/erros`. Medido: 3 e-mails do dia, **21 boletos, R$ 315.556,57**, recuperados por
`scripts/reprocess_message.py` depois da correção.

**Arquivos:** `skills/pdf-contas-pagar/scripts/extract_pdf.py` (núcleo) ·
`skills/pdf-contas-pagar/scripts/febraban.py` (`barcode_self_refuted`) ·
`skills/email-reader/scripts/read_emails.py` (assinatura de e-mail) · `deploy-manifest.json`.

**Segunda entrega do mesmo dia — barcode corrompido pelo OCR:** auditadas as 442 contas com
código de barras, **18 estavam corrompidas** (valor 10×, fator impossível), todas `pdf_vision`
— fecha em 442 com 349 consistentes + 68 não-boleto + 7 em que só o valor diverge (preservados).
Foram limpas (`barcode = NULL`) com prova por hash — 784 contas antes e depois, conteúdo idêntico.
O gate `barcode_self_refuted` impede novas. **Contraintuitivo, mas é o ponto:** apagar o código
REDUZ duplicata — corrompido, ele não casa o boleto real na 2ª via e a dedup cria conta nova;
ausente, ela recai nas impressões 2/3 (documento+valor, valor+vencimento), que funcionam.

**Sem** `.env` obrigatório (`VISION_MAX_TOKENS` tem default 8000), **sem** dependência nova,
**sem** migration, **sem** `setup-*-task.ps1`.

**Implantado em produção em 2026-08-10** (informado pelo operador), a partir do merge do PR #219
em `main` (`3f9e87c`). O que foi para a máquina inclui uma **terceira** correção da mesma onda, que
não estava na entrega original de 07/08 e veio do code review: o `EXTRACTION_PROMPT` é
**compartilhado** pelos dois caminhos, então o modelo passou a devolver ARRAY também no `pdf_text`
— onde ele caía num `except` genérico e virava **1 conta de regex marcada como sucesso**, perdendo
os demais pagáveis. Ou seja, a correção do multi-boleto reintroduziu, pela outra porta, exatamente
a perda silenciosa que existia para matar. Hoje `_build_records_text` detecta ≥2 itens e devolve
`_failure_record`, que cai no fallback tier-2 (Vision). **Lição:** ao ensinar UM caminho a consumir
um formato novo de resposta, verifique quem mais recebe o mesmo prompt.

SHA-256 dos três arquivos nesta versão (conferíveis na máquina de produção):
`read_emails.py` `bc7c89a1…76aa0a7` · `extract_pdf.py` `0b3afd8f…602654586` ·
`febraban.py` `1ccb90f8…4666bcb1ce`. A fonte da verdade do estado continua sendo
`py -3 scheduler\check_deploy_parity.py` **executado em produção** (exit 0 = paridade).

**Lições não-óbvias:**

- **`stop_reason` ignorado torna o truncamento invisível.** A resposta cortada no teto de tokens
  não gera erro nenhum: o JSON pela metade só "não parseia", e o registro vazio resultante era
  logado contra o DOCUMENTO (`sem_valor`) em vez de contra o EXTRATOR. Todo teto de tokens precisa
  de uma checagem do motivo de parada — o número sozinho não avisa quando é atingido.
- **O split por página não cobre o que mais precisa dele.** `_payable_pages` lê TEXTO; o carnê
  escaneado não tem nenhum. Justamente o arquivo com N boletos era o que ia inteiro numa leitura só.
  A saída foi aceitar **N registros por leitura**, não melhorar a detecção de páginas.
- **Ao conferir o resultado, `gmail_message_id` casa com `LIKE '<id>#%'`.** A igualdade simples
  mostrou "1 conta" logo após o pipeline gravar 6 — quase virou um diagnóstico de perda inexistente.

---

## Deploys anteriores do pipeline Python (produção)

Registro condensado dos deploys manuais para `C:\Sheild\API\Pagamentos`. Extraído do `CLAUDE.md`
em 2026-08-04, quando os blocos somavam ~490 linhas de passo-a-passo **já cumprido**.

**Isto é histórico, não procedimento.** O procedimento vivo está no `CLAUDE.md`:

- **"COMO SABER SE PRODUÇÃO ESTÁ ATUALIZADA"** — `check_deploy_parity.py` é a fonte da verdade do
  estado; as lições transversais (manifesto viaja junto, `EXTRA` = régua obsoleta, contar pelo que
  MUDOU, nunca `--update` em produção) vivem lá.
- **"Deploy manual do Email Reader em produção"** — quais arquivos copiar e como validar.

Cada entrada guarda **o que mudou** e **a lição não-óbvia**, quando houver. O passo-a-passo
operacional foi descartado por já ter sido executado; o texto integral continua recuperável em
`git show <commit>:CLAUDE.md` (o corte é do commit de 2026-08-04).

> A regra de negócio de cada item **não** está aqui — ela vive na seção correspondente do
> `CLAUDE.md` (ex.: "Normalização de `document_type`", "Auto-resolução de fornecedor"). Aqui fica
> só o que diz respeito a **levar aquilo para produção**.

---

## 2026-08-04

| # | Mudança | Arquivos |
|---|---|---|
| 5º | **HOTFIX `pdf_links`** — o 4º deploy do dia quebrou o caminho principal (todo e-mail com anexo → `falha`) | `read_emails.py` + manifesto |
| 4º | E-mail não-pagável deixa de virar `falha` (`email_sem_conteudo_extraivel`, `is_disposable_sender`) | `read_emails.py` + manifesto |
| 3º | Guarda de TÍTULO na dedup por nosso número + status `duplicidade` para dedup só-PDF | `read_emails.py` + manifesto |
| 2º | Guia de arrecadação: valor = total a recolher (do barcode) e vencimento = data-limite | `febraban.py`, `extract_pdf.py` + manifesto |
| 1º | Fornecedor rotulado no corpo vence o nome do anexo sem identificador forte | `read_emails.py` + manifesto |

**Lições que ficaram:**

- 🔴 **Ordem de cópia importa quando o módulo é importado no topo.** O `extract_pdf.py` do 2º
  deploy importa `amount_from_arrecadacao`/`arrecadacao_dv_refuted` de `febraban.py` **no topo** —
  com o `febraban.py` antigo o import falha e **nenhum PDF é extraído**, não só a guia. Copie o
  módulo novo primeiro, ou os dois juntos. Assimetria deliberada: o `read_emails.py` **degrada**
  (avisa no log e segue), o `extract_pdf.py` **estoura** — é o que faz um rename futuro aparecer
  alto e cedo em vez de virar silêncio.
- ⚠️ **Comando de uma linha para produção é PowerShell — a quebra de linha vai como `\r\n`, nunca
  como `` `r`n ``.** O PowerShell escapa com backtick, então dentro de aspas duplas o `` `r`n ``
  vira CR/LF **reais**, que partem a string Python no meio (`SyntaxError: unterminated string
  literal`). A barra invertida não é escape do PowerShell, então `\r\n` chega literal ao Python,
  que o interpreta. Forma que funciona nos dois shells: **aspas duplas externas + aspas simples
  internas + `\r\n`**. Trocar as aspas de lugar também quebra (com aspas simples externas o
  PowerShell consome as duplas ao repassar ao executável nativo).
- O 5º deploy é a origem da **lição 6 da §2** do `CLAUDE.md` (guarda de wiring por texto não cobre
  o call site executado). A lição está lá, não aqui.

---

## 2026-08-03 — corpo PLACEHOLDER ("conteúdo em HTML")

`read_emails.py` passou a cair no HTML quando o texto plano é só o aviso de que a mensagem está em
HTML. Copiado com o manifesto.

**Lição:** o manifesto esquecido produz um **veredito enganoso** — o `check_deploy_parity.py` lê o
manifesto **do diretório de produção**, então com a régua velha o arquivo recém-copiado aparece
como `DIVERGENTE` e o script manda recopiar justamente o que está certo. Sinal que distingue os
dois lados: **a validação funcional responde `True` e o verificador acusa divergência ⇒ o problema
é o manifesto**. O branch/merge não influencia — produção não é clone git.

---

## 2026-08-01 — Onda 3: documento fiscal pela chave de acesso

`fiscal_key.py` (**arquivo NOVO**), `extract_pdf.py` (reexport) e `read_emails.py` (gancho), mais o
manifesto — que foi de 26 para 27 arquivos.

**Lições:** o `extract_pdf.py` importa `fiscal_key` no topo → sem ele, `ModuleNotFoundError` e
**nenhum PDF extraído**; copiar o novo primeiro. E foi aqui que se descobriu que **`EXTRA` casando
`DEPLOY_GLOBS` significa manifesto obsoleto**, não arquivo sobrando (produção não cria arquivo) —
a lição está no bloco de paridade do `CLAUDE.md`.

---

## 2026-07-31 — Onda 2: corpo completo do e-mail

`read_emails.py` passou a gravar `email_control.body_full`. Migrations 105/106 já aplicadas na
Supabase compartilhada.

**Lição de verificação:** a presença de uma constante prova só que o arquivo mudou; para provar que
a **alteração** está lá, use `inspect.getsource` da função em produção —
`print('grava:', 'body_full' in inspect.getsource(R.process_message))`. Vale para qualquer deploy
do reader em que o horário da cópia seja incerto.

**Nota:** e-mail processado logo ANTES da cópia fica sem `body_full` e a dedup **não** o
reprocessa. Esperado; esses corpos eram alvo da Onda 4.

---

## 2026-07-28 — quatro deploys

| Mudança | Arquivos |
|---|---|
| Endurecimento do caminho do corpo + **`febraban.py` (arquivo NOVO)** | `read_emails.py`, `extract_pdf.py`, `febraban.py` |
| Regra de SEGURADORA + porta livre no guard SSRF + PDF espelhado | `read_emails.py`, `extract_pdf.py` |
| Tabela de faturas achatada no corpo | `read_emails.py`, `extract_pdf.py` |
| Ignorar "Recebemos o seu pagamento" · notificação de cobrança de plataforma | `read_emails.py` |

**Lição:** o `febraban.py` foi o **primeiro** arquivo novo a revelar que `DEPLOY_GLOBS` precisa ser
estendido — sem ele o corpo degrada para validação só por comprimento **e avisa no log**
(`[BARCODE] … Deploy parcial?`). É assim que se detecta uma cópia incompleta.

---

## 2026-07-23 · 2026-07-20 · 2026-07-16 · 2026-07-15 · 2026-07-10 · 2026-07-06

Todos em `read_emails.py` (salvo onde indicado), todos com migrations já aplicadas na Supabase
compartilhada — portanto **sem passo de banco** em produção.

| Data | Mudança |
|---|---|
| 07-23 | NFS-e/NF-e combinada com boleto vira conta · remetente encaminhado no corpo + "Fatura No:" |
| 07-20 | Descartar extrato/relatório que acompanha o boleto |
| 07-17 | `sk_company` como chave de relacionamento · empresa pagadora por precedência (3 empresas) |
| 07-16 | Contato do fornecedor · dedup por nosso número · **Beneficiário Final** (`extract_pdf.py`) |
| 07-15 | Vínculo do anexo do e-mail (migration 079) |
| 07-10 | `pix` deixa de ser tipo de documento (`extract_pdf.py` junto) · autoria `created_by` |
| 07-06 | Cartório + classificação contábil forçada — **único que exigiu `.env`** (`EMAIL_KEYWORDS`) |

**Lições:**

- **Os deltas de `read_emails.py` são cumulativos.** Cada cópia carrega as pendências anteriores —
  por isso a lista acima não precisa ser aplicada em ordem, basta a versão mais recente.
- **`sk_company` degradou com segurança** porque `company_id` foi preservado (NOT NULL UNIQUE): o
  código antigo seguiu funcionando entre a migration e a cópia. Migration que **substitui** coluna
  deve manter a antiga até o deploy do consumidor.
- **07-06 é o único caso de `.env`** nesta série. O `.env` não é versionado, então mudança em
  `EMAIL_KEYWORDS` exige edição manual no arquivo de produção — não vem junto com o `.py`.

---

## 2026-06-29 — dependência nova: `pypdf`

A descriptografia de boletos com senha e o split de carnê exigem `pypdf` na máquina do scheduler:
`py -3 -m pip install "pypdf~=6.13"`. Sem ele, `import extract_pdf` falha e a extração para.
**Dependência nova é o único caso em que copiar arquivo não basta** — está no `CLAUDE.md`, junto do
procedimento.
