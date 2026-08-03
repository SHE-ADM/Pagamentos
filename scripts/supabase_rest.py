"""Acesso REST/Storage ao Supabase — fonte UNICA para os scripts de manutencao.

POR QUE ESTE MODULO EXISTE (e por que nao duplicar de novo)
    `purge_orphan_attachments.py` e `backfill_fiscal_documents.py` tinham CADA UM sua copia de
    `_rest` e `_storage_list`. As copias divergiam no que importa: o `_storage_list` paginava,
    o `_rest` NAO — e o mesmo defeito teve de ser corrigido duas vezes, em dois arquivos, no
    mesmo dia. Um cluster de funcoes que precisa da MESMA correcao em dois lugares e um modulo
    esperando para nascer; mesmo motivo do `febraban.py`.

O DEFEITO QUE ORIGINOU ISTO (nao regredir)
    O Supabase corta a resposta no "Max rows" do projeto (1000) e devolve **HTTP 200** — sem
    erro, sem excecao, sem sinal. Medido em 2026-08-01: `email_control` tem 1158 linhas e a
    chamada crua devolvia 1000, o que gravou 68 de 172 documentos fiscais (40%) sem
    proveniencia. Consulta cujo resultado vira DADO GRAVADO — ou decide o que APAGAR — precisa
    paginar.

Sem dependencia externa (urllib da stdlib), como o resto dos scripts.
"""

import json
import urllib.error
import urllib.parse
import urllib.request

# Teto "Max rows" do Supabase. Paginamos ate a pagina vir incompleta.
PAGE_SIZE = 1000

# Teto de paginas por consulta. Existe para o caso patologico em que o servidor ignora o
# `offset` e devolve sempre a mesma pagina cheia: sem isto o laco roda para sempre acumulando
# memoria, e travamento silencioso e pior que erro. 1000 paginas = 1 milhao de linhas, ordens
# de grandeza acima de qualquer tabela deste projeto.
MAX_PAGES = 1000

# Falhas de REDE esperadas — distintas de erro de PROTOCOLO (HTTPError, que carrega corpo e
# codigo). `HTTPError` e subclasse de `URLError`, mas o inverso NAO vale: um `except HTTPError`
# sozinho deixa timeout/DNS/conexao recusada PROPAGAREM e derrubarem o laco inteiro.
NETWORK_ERRORS = (urllib.error.URLError, OSError, TimeoutError)


class RestError(RuntimeError):
    """Falha de acesso ao Supabase que o chamador deve tratar (nao um bug de codigo)."""


def rest_get(base: str, headers: dict, path: str, order: str = "id") -> list:
    """GET no PostgREST, PAGINADO ate esgotar.

    `order` fixo torna a paginacao DETERMINISTICA: sem ORDER BY o PostgREST nao garante a mesma
    ordem entre requisicoes, e o offset puro pularia linhas. Se o `path` ja trouxer um `order=`,
    o dele prevalece — acrescentar um segundo deixaria o desempate a cargo do servidor.
    """
    sep = "&" if "?" in path else "?"
    ordena = "" if "order=" in path else f"order={order}&"
    rows: list = []
    for pagina in range(MAX_PAGES):
        url = f"{base}/rest/v1/{path}{sep}{ordena}limit={PAGE_SIZE}&offset={pagina * PAGE_SIZE}"
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers),
                                        timeout=60) as r:
                page = json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise RestError(f"{path}: HTTP {e.code} {e.read().decode(errors='replace')[:150]}") from e
        except NETWORK_ERRORS as e:
            raise RestError(f"{path}: falha de rede ({e})") from e
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            return rows
    raise RestError(f"{path}: mais de {MAX_PAGES} paginas — o servidor esta ignorando o offset?")


def rest_write(base: str, headers: dict, path: str, payload: dict,
               method: str = "POST", prefer: str = "") -> tuple:
    """POST/PATCH no PostgREST. Devolve `(ok, corpo_ou_motivo)` — NUNCA levanta.

    Escrita item-a-item dentro de laco: uma falha nao pode derrubar os itens seguintes. Quem
    chama decide se conta como erro, e o motivo volta legivel para o log.

    O `ok` diz apenas que a requisicao foi aceita. Com `resolution=ignore-duplicates`, o
    PostgREST responde 201 mesmo sem inserir — para distinguir INSERT real de duplicata
    ignorada, peca `return=representation` no `prefer` e olhe o corpo (lista vazia = ja existia).
    """
    h = dict(headers)
    if prefer:
        h["Prefer"] = prefer
    req = urllib.request.Request(f"{base}/rest/v1/{path}", data=json.dumps(payload).encode(),
                                 headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            corpo = r.read()
        return True, (json.loads(corpo) if corpo else None)
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code} {e.read().decode(errors='replace')[:150]}"
    except NETWORK_ERRORS as e:
        return False, f"falha de rede ({e})"


def storage_list(base: str, headers: dict, bucket: str, com_metadata: bool = False):
    """Objetos do bucket, paginados. Devolve lista de nomes, ou `{nome: metadata}`.

    `id` nulo = PLACEHOLDER DE PASTA (ex.: a entrada "manual" dos anexos da migration 079), nao
    um objeto: baixa-lo devolve HTTP 400. Os PDFs do pipeline sao flat na raiz, entao pular as
    pastas nao perde nada.

    `com_metadata=True` devolve o `metadata` de cada objeto (`size`, `mimetype`, `eTag`) em vez
    de so o nome. Serve a quem precisa decidir se o objeto ja no bucket e o MESMO arquivo que
    esta prestes a subir: o nome coincidir NAO prova identidade de conteudo, e o HTTP 409 do
    upload tampouco (ele diz apenas "ja existe um objeto com essa chave").
    """
    names: list = []
    meta: dict = {}
    for pagina in range(MAX_PAGES):
        body = json.dumps({"prefix": "", "limit": PAGE_SIZE,
                           "offset": pagina * PAGE_SIZE}).encode()
        req = urllib.request.Request(f"{base}/storage/v1/object/list/{bucket}",
                                     data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                page = json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise RestError(f"storage/list: HTTP {e.code} "
                            f"{e.read().decode(errors='replace')[:150]}") from e
        except NETWORK_ERRORS as e:
            raise RestError(f"storage/list: falha de rede ({e})") from e
        if not page:
            return meta if com_metadata else names
        for o in page:
            if not (o.get("name") and o.get("id")):
                continue
            names.append(o["name"])
            meta[o["name"]] = o.get("metadata") or {}
        if len(page) < PAGE_SIZE:
            return meta if com_metadata else names
    raise RestError(f"storage/list: mais de {MAX_PAGES} paginas — offset ignorado?")


def storage_upload(base: str, headers: dict, bucket: str, key: str, data: bytes,
                   content_type: str = "application/octet-stream",
                   upsert: bool = False) -> tuple:
    """Sobe um objeto ao bucket. Devolve `(estado, detalhe)` — NUNCA levanta.

    Estados: `"subiu"` · `"ja_existe"` (HTTP 409, NAO e falha) · `"erro"`.

    `upsert=False` e o DEFAULT deliberado, e o unico modo usado pela varredura historica: subir
    com `x-upsert: true` SOBRESCREVERIA o objeto que ja esta no bucket — exatamente o que os
    invariantes de uma passada aditiva proibem. `SupabaseControl.upload_attachment` do reader
    hardcoda `true` (ele QUER sobrescrever, pois reprocessa o mesmo anexo), por isso nao serve
    aqui. O 409 volta como estado proprio porque "o objeto ja estava la" e sucesso do ponto de
    vista de quem so quer garantir que o arquivo exista.

    O `Content-Type` do arquivo SOBREPOE o do `headers` recebido — os scripts montam o header
    padrao com `application/json`, que gravaria o mime errado no objeto.
    """
    h = {k: v for k, v in headers.items() if k.lower() != "content-type"}
    h["Content-Type"] = content_type
    if upsert:
        h["x-upsert"] = "true"
    url = f"{base}/storage/v1/object/{bucket}/{urllib.parse.quote(key, safe='')}"
    req = urllib.request.Request(url, data=data, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            r.read()
        return "subiu", ""
    except urllib.error.HTTPError as e:
        detalhe = e.read().decode(errors="replace")[:150]
        if e.code == 409:
            return "ja_existe", detalhe
        return "erro", f"HTTP {e.code} {detalhe}"
    except NETWORK_ERRORS as e:
        return "erro", f"falha de rede ({e})"
