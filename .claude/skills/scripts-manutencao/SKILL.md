---
name: scripts-manutencao
description: >-
  Operar os scripts de manutenção do pipeline de contas a pagar (projeto `pagamentos`): leitura
  de e-mails sob demanda, reprocessadores (link, corpo, ignorados, CT-e, beneficiário final,
  Message-ID isolado), backfills (documento fiscal, contatos do fornecedor, corpo-placeholder),
  purga de anexos órfãos e varredura histórica da caixa postal. Diz QUAL script usar para cada
  sintoma, em que ORDEM rodar, quais são destrutivos e o que cada `--dry-run` prova de fato.
  Acione SEMPRE que o usuário disser "reprocessar", "reprocessa esse e-mail", "rodar o backfill",
  "purgar anexos órfãos", "limpar o bucket", "varredura histórica", "conta não foi extraída",
  "e-mail ficou em falha", "recuperar boleto", ou citar um script de `scripts/` — mesmo sem dizer
  "skill".
---

# Scripts de manutenção do pipeline

Todos rodam **no DEV** (`py -3`, a partir da raiz do repositório) contra a **Supabase compartilhada
dev+prod**. Ficam em `scripts/`, **fora dos `DEPLOY_GLOBS`** — não entram no manifesto e nunca são
copiados para produção.

🔴 **Escrevem no banco real.** Todo script destrutivo ou de escrita em massa tem `--dry-run`:
**rode-o primeiro, sempre**, e leia o relatório antes de aplicar. Onde o `--dry-run` não prova a
mesma coisa que a execução, está avisado abaixo.

## Qual script para qual sintoma

| Sintoma | Script |
|---|---|
| E-mail novo não foi lido | `read_emails.py --days 7` (ou `--all --mark-seen`) |
| `status=pendente` (anexo salvo, PDF não extraído) | `retry_extraction.py` |
| `status=falha` e o boleto está **atrás de link** | `reprocess_link_emails.py` |
| `status=falha` e a conta está **no corpo** do e-mail | `reprocess_body_emails.py` |
| Um e-mail específico, inclusive **imagem inline** (recibo colado) | `reprocess_message.py --message-id "<…>"` |
| Ampliou keyword/regra e há `ignorado` que agora casa | `reprocess_ignored_emails.py` |
| Boleto securitizado com fornecedor errado (cedente em vez do beneficiário final) | `reprocess_beneficiario_final.py` |
| Corpo gravado é só o aviso "conteúdo em HTML" | `backfill_placeholder_bodies.py` |
| Contato do fornecedor (telefone/WhatsApp/PIX) vazio | `backfill_supplier_contacts.py` |
| Chave fiscal dos PDFs que já estão no bucket | `backfill_fiscal_documents.py` |
| Bucket acumulando objeto que nenhuma linha referencia | `purge_orphan_attachments.py` |

**O detalhe de cada um vive na própria docstring do script** (`py -3 scripts/<nome>.py --help`, ou
abra o arquivo) — elas são longas e mantidas junto do código, então não divergem. O que segue aqui
é só o que **não** cabe numa docstring: ordem entre scripts e riscos de operação.

## Ordem importa

**Link antes de corpo.** `reprocess_link_emails.py` e `reprocess_body_emails.py` varrem a mesma
fila (`status='falha'`) e são complementares: rode o de **link** primeiro (o boleto real, com linha
digitável) e só depois o de **corpo** — senão o corpo cria a conta sem barcode e o boleto vira
duplicata.

🔴 **Antes de qualquer reprocessador, confira que a fila `falha` é fila de verdade.** Se um bug
recente marcou `falha` em e-mails que **já têm conta gravada**, o reprocessador tentará extrair de
novo. Meça primeiro:

```sql
SELECT e.id, e.status,
       (SELECT count(*) FROM financial_account_control f WHERE f.gmail_message_id = e.message_id) AS contas
  FROM email_control e WHERE e.status = 'falha';
```

Linha com `contas > 0` é status errado, não trabalho pendente — corrija o status antes de rodar.

## Os destrutivos

### `purge_orphan_attachments.py` — apaga do bucket, IRREVERSÍVEL

Remove objetos que **nenhuma** linha referencia. O backup diário (skill `backup-supabase`) cobre o
bucket, mas não conte com isso: **`--dry-run` sempre**.

🔴 **Ele decide também pelo CONTEÚDO**, não só por `storage_key`: baixa cada candidato e preserva o
que carrega chave fiscal válida. É o que impede apagar um DACTE legítimo cuja chave já foi
registrada por outro objeto (`access_key` é UNIQUE, então só o primeiro consta em
`fiscal_document`). Falha ao baixar ou ao ler ⇒ **PRESERVA** — a função autoriza remoção
irreversível; na dúvida, não autoriza. Essa inspeção roda **também no `--dry-run`**, senão o
relatório prometeria apagar o que a execução preservaria.

Preserva ainda: e-mail em `pendente`/`falha`, objeto citado em `email_processing_errors` e as três
fontes de "referenciado" (`financial_account_attachment.storage_key`,
`financial_account_control.source_file`, `fiscal_document.storage_key`).

### `reprocess_cte_accounts.py` — faz **hard delete** de contas

Alinha dados já gravados à regra de CT-e/transporte: re-rotula boletos de transporte e **exclui**
CT-e fiscais que não são boleto. Rodado uma vez (2026-07-02). Só use de novo se a regra mudar, e
com `--dry-run` antes.

### `varredura_historica.py` — passada única sobre a INBOX

Estritamente **aditiva**: nunca grava conta, nunca marca `\Seen` (caixa em EXAMINE + `BODY.PEEK`),
só preenche `body_full` quando NULO (filtro na URL, atômico) e nunca sobrescreve objeto do bucket.
Os quatro invariantes estão travados por teste com mutante.

⚠️ **`data/pdfs_inbox` é território proibido para ele** — `retry_extraction.py` resolve PDFs **pelo
nome** lá dentro a partir do banco, então um arquivo com nome colidente viraria conta pela porta
dos fundos. Ele usa `tempfile`; upload que falha vai para a quarentena `data/varredura_pdfs/`.

**Ordem operacional:** `--dry-run` → `--dry-run --deep` → `--limit 50` real (conferindo
`count(*)`/`max(id)` de `financial_account_control` antes e depois) → passada completa →
reexecutar para provar idempotência.

> A Onda 4 já foi executada e **está fechada**. A lição que ficou: a INBOX guarda ~3 meses, então
> ~77% do acervo já não estava lá — quando um plano se justifica por *"a fonte é volátil, corra"*,
> o primeiro passo é **MEDIR a fonte**, não escrever o coletor.

## `--fix-provenance` não é varredura (não confundir)

`backfill_fiscal_documents.py --fix-provenance` **não baixa PDF nenhum**: só preenche
`gmail_message_id`/`sender_email`/`subject`/`received_at` das linhas gravadas sem eles. Existe
porque **reexecutar o backfill não conserta esse caso** — o INSERT usa `ignore-duplicates`, que
ignora em vez de atualizar. É conservador: só toca linha com `sender_email IS NULL` e nunca os
campos de identidade (`access_key`/`model`/`emitter_cnpj`/`storage_key`).

## Ao escrever um script novo

🔴 **Use `scripts/supabase_rest.py`** — não copie o `_rest` de ninguém. Ele existe porque duas
cópias divergiram e a divergência custou caro: o `_rest` sem paginação truncava em 1.000 linhas com
**HTTP 200**, sem exceção e sem sinal, e 40% dos documentos fiscais nasceram sem proveniência.

**Consulta REST cujo resultado vira dado gravado — ou decide apagar — precisa paginar.**

`storage_upload` nasce com `upsert=False` (modo seguro) e devolve `"ja_existe"` no HTTP 409 como
estado, não como erro. `rest_write` devolve `(ok, motivo)` e **nunca levanta**, para uma falha não
derrubar os itens seguintes do laço.
