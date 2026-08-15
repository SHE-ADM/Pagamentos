# -*- coding: utf-8 -*-
"""Medidor mensal dos 7 gatilhos condicionais da ONDA 9.

    py -3 skills/roadmap-gatilhos/scripts/run.py [--dry-run]

POR QUE ESTE SCRIPT EXISTE
    A Onda 9 do roadmap (docs/roadmap-enriquecimento-dados.md §4) e CONDICIONAL: cada item so
    entra quando o gatilho dele ocorre. Implementar antes disso e construir para um cenario que
    nao existe — foi o que aconteceu com os itens 5.1/5.2, suspensos depois de medida a populacao
    real (15 DANFEs).

    O valor de remedir NAO esta no alerta: nenhum gatilho vira de um mes para o outro. Esta na
    SERIE. Ver NFS-e ir de 1 para 3 e para 8 antecipa a decisao; tres vereditos "false" isolados
    nao dizem nada. Por isso cada execucao grava em `analytics.roadmap_trigger_snapshot`
    (migration 122), e nao apenas imprime.

🔴 SOMENTE LEITURA sobre o negocio. A UNICA escrita e a propria serie. Um medidor que altera o
    que mede deixa de ser medidor.

🔴 CONTAGEM POR `count=exact` + `head=true`, NUNCA trazendo linhas. Alem de barato, evita a
    armadilha registrada na Onda 3: o PostgREST corta a resposta no "Max rows" (1.000) e devolve
    HTTP 200 — quem conta as linhas recebidas subnotifica em silencio. Contagem vem do header
    `Content-Range`, que nao e truncado.

EXIT CODE
    0  todos os 7 gatilhos medidos (e gravados, fora do --dry-run).
    1  algum gatilho falhou. Os demais continuam sendo medidos e gravados — falha isolada, no
       padrao do `cobranca-vencidos`: um gatilho indisponivel nao pode custar a serie inteira.

    🔴 A COMPARACAO com a medicao anterior (`_buscar_estado_anterior`, Onda 10) NAO participa
       deste contrato. E diagnostico — detecta quando um `fired` MUDOU de valor desde a ultima
       medicao gravada, e loga alto quando isso acontece — mas falha nela NUNCA vira exit code 1.
       A tarefa agendada trata qualquer exit != 0 como falha operacional; "mudou de estado" e o
       PRODUTO esperado desta rotina, nao um erro, e nao pode acender o alarme errado.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

try:
    from dotenv import load_dotenv
except ImportError:                                          # pragma: no cover - ambiente sem dep
    load_dotenv = None                                       # type: ignore[assignment]

log = logging.getLogger("roadmap-gatilhos")

# A raiz do projeto a partir deste arquivo: skills/roadmap-gatilhos/scripts/run.py -> 3 niveis.
RAIZ = Path(__file__).resolve().parents[3]

# Timeout EXPLICITO em toda I/O de rede. Sem ele, o urllib herda o default do socket (que pode ser
# "nenhum") e uma conexao pendurada trava a tarefa agendada indefinidamente — a mesma classe de
# falha que o IMAP_TIMEOUT do reader existe para evitar.
HTTP_TIMEOUT_SECONDS = 30
HTTP_MAX_ATTEMPTS = 3
HTTP_RETRY_BACKOFF = 2.0

# Caminho HTTP LEVE, so para a checagem DIAGNOSTICA de estado anterior (Onda 10) — nunca para
# medicao. 1 tentativa, timeout curto: 7 buscas a mais com o retry pesado do `_request` (3 x 30s
# cada) estufariam o pior caso que o comentario de BUDGET_SECONDS ja documenta ("~15 requisicoes
# x 3 tentativas x 30s"). Aqui o pior caso adicional fica em 7 x 10s = 70s, e e essa a folga que
# o guard de `_tempo_esgotado()` em torno da chamada considera.
HTTP_DIAG_TIMEOUT_SECONDS = 10.0

# 🔴 TETO DE TEMPO DA MEDICAO INTEIRA — a tarefa agendada tem `ExecutionTimeLimit` de 15 min
# (setup-gatilhos-task.ps1), e o pior caso de rede passa disso: ~15 requisicoes x 3 tentativas x
# 30 s de timeout + backoff da ~24 min. Sem este teto, quem encerra o processo e o AGENDADOR, e o
# jeito como ele encerra e o problema: mata sem exit code proprio, sem o log de resumo e sem
# gravar os gatilhos que JA tinham sido medidos — a medicao inteira do mes se perde por causa dos
# ultimos. Com o teto, o script para sozinho, grava o que apurou e sai 1.
#
# 10 min deixa 5 de folga para a gravacao e o encerramento dentro do limite da tarefa.
BUDGET_SECONDS = 600.0

# Instante (relogio MONOTONICO) em que a medicao tem de parar. `monotonic` e nao `time()`: ajuste
# de horario/horario de verao no meio da execucao poderia encurtar ou eternizar o orcamento.
_deadline: float | None = None


def _tempo_esgotado() -> bool:
    """True quando o orcamento acabou. Sem deadline definido (import em teste), nunca esgota."""
    return _deadline is not None and time.monotonic() >= _deadline

SNAPSHOT_TABLE = "roadmap_trigger_snapshot"
ANALYTICS = "analytics"

# Fuso da SERIE: `measured_on` e gravado pelo banco com DEFAULT
# `(NOW() AT TIME ZONE 'America/Sao_Paulo')::date` (migration 122). UTC-3 FIXO aqui e
# deliberado: o Brasil nao tem mais horario de verao (desde 2019), e `zoneinfo` no Windows
# exigiria o pacote `tzdata` — esta skill e zero-dependencia (so urllib + dotenv).
_TZ_SERIE = timezone(timedelta(hours=-3))


def _hoje_serie() -> str:
    """A data de HOJE como o banco a grava em `measured_on` (America/Sao_Paulo), ISO."""
    return datetime.now(_TZ_SERIE).date().isoformat()

# Nomes de tabela em constantes: eles aparecem em varios medidores, e um typo so seria descoberto
# na execucao agendada (HTTP 404 -> gatilho isolado falha). Fonte unica tambem deixa obvio, na
# leitura, QUAIS tabelas este medidor toca — todas em modo somente-leitura.
T_CONTAS = "financial_account_control"
T_FISCAL = "fiscal_document"
T_EMAILS = "email_control"
T_CHAT_LOG = "ai_chat_log"

# ---------------------------------------------------------------------------
# LIMIARES — versionados no codigo, e gravados em `criterion` a cada medicao
# ---------------------------------------------------------------------------
# 🔴 O criterio vai para o banco JUNTO do veredito. Sem isso, um `fired = false` de hoje fica
# inauditavel quando o limiar mudar: nao daria para saber se o gatilho nao ocorreu ou se a regua
# era outra. Mudar um numero aqui e uma decisao de produto — e ela fica rastreavel na serie.

# NFS-e: cada municipio e um layout proprio (nao ha chave nacional). 30 notas espalhadas por 10
# prefeituras NAO amortizam o trabalho; 20 da mesma, sim. O limiar e sobre o total porque a
# concentracao por municipio nao e extraivel hoje — e a leitura manual do acervo que decide.
NFSE_MIN_CONTAS = 20

# Text-to-SQL: antes de tudo e preciso AMOSTRA. Com 8 interacoes nao ha o que interpretar.
TEXT_TO_SQL_MIN_AMOSTRA = 100
TEXT_TO_SQL_PCT_DESCOBERTO = 10.0

# Tabelas agregadas: o gatilho real e "alguma tool passar de ~500 ms warm", e medir isso exige
# EXPLAIN ANALYZE — que o service_role nao consegue rodar por REST (ele nao tem EXECUTE nas
# tools, e isso e proposital). O que este script mede e o PROXY: o volume da fato. A degradacao
# e DECLARADA no criterio, nunca silenciosa.
AGREGADOS_PROXY_LINHAS = 50_000


class MedicaoError(RuntimeError):
    """Falha ao medir UM gatilho. Nao interrompe os demais."""


# ---------------------------------------------------------------------------
# Infra HTTP
# ---------------------------------------------------------------------------
def _carrega_env() -> tuple[str, str]:
    """URL e service key do .env da raiz. Falha CEDO e com mensagem util."""
    if load_dotenv is not None:
        load_dotenv(RAIZ / ".env")

    url = (os.getenv("SUPABASE_URL") or "").strip().rstrip("/")
    key = (os.getenv("SUPABASE_SERVICE_KEY") or "").strip()
    faltando = [n for n, v in (("SUPABASE_URL", url), ("SUPABASE_SERVICE_KEY", key)) if not v]
    if faltando:
        raise SystemExit(
            f"Variavel(is) ausente(s) no .env: {', '.join(faltando)}. "
            "O medidor le com service_role (a serie e escrita so por ele)."
        )
    return url, key


def _http_transitorio(codigo: int) -> bool:
    """429 e 5xx sao do SERVIDOR, nao do pedido — repetir tem chance real de suceder.

    🔴 A distincao importa porque esta serie e MENSAL. Um 503 momentaneo do Supabase tratado como
    definitivo derruba aquele gatilho e o deixa SEM PONTO por 30 dias — um buraco silencioso na
    serie, que e justamente o produto desta rotina (e o mesmo prejuizo que o `StartWhenAvailable`
    da tarefa agendada existe para evitar).

    4xx fora do 429 continua definitivo: repetir um 400/403/404 nao muda o resultado, so atrasa a
    tarefa e adia o diagnostico do erro real.
    """
    return codigo == 429 or 500 <= codigo <= 599


def _request(url: str, key: str, *, metodo: str = "GET", corpo: bytes | None = None,
             extra: dict[str, str] | None = None) -> tuple[int, dict[str, str], bytes]:
    """Uma requisicao ao PostgREST, com retry/backoff em falha TRANSITORIA.

    Transitorio = falha de rede esperada (timeout, DNS, conexao) OU resposta 429/5xx do servidor.
    Erro HTTP definitivo (4xx fora do 429) volta na hora. O segredo NUNCA entra em log — nem em
    caso de erro.
    """
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    }
    headers.update(extra or {})

    ultimo_erro: Exception | None = None
    for tentativa in range(1, HTTP_MAX_ATTEMPTS + 1):
        req = urllib.request.Request(url, data=corpo, headers=headers, method=metodo)
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as e:
            # 🔴 O corpo e lido AQUI, antes de decidir repetir: `e.read()` so entrega uma vez, e
            # depois do backoff o objeto da tentativa anterior ja teria sido descartado.
            resposta = (e.code, dict(e.headers or {}), e.read())
            # Orcamento estourado: devolve o que tem em vez de dormir para tentar de novo — o
            # tempo restante e do encerramento, nao de mais uma tentativa.
            if (tentativa == HTTP_MAX_ATTEMPTS or not _http_transitorio(e.code)
                    or _tempo_esgotado()):
                return resposta
            espera = HTTP_RETRY_BACKOFF * tentativa
            log.info("HTTP %d transitorio; tentativa %d/%d em %.0fs",
                     e.code, tentativa, HTTP_MAX_ATTEMPTS, espera)
            time.sleep(espera)
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            ultimo_erro = e
            if tentativa < HTTP_MAX_ATTEMPTS and not _tempo_esgotado():
                espera = HTTP_RETRY_BACKOFF * tentativa
                log.info("falha de rede (%s); tentativa %d/%d em %.0fs",
                         e, tentativa, HTTP_MAX_ATTEMPTS, espera)
                time.sleep(espera)
            elif _tempo_esgotado():
                break

    raise MedicaoError(f"rede indisponivel apos {HTTP_MAX_ATTEMPTS} tentativas: {ultimo_erro}")


def _request_leve(alvo: str, key: str) -> tuple[int, bytes] | None:
    """GET de UMA tentativa, sem retry/backoff — so para checagem DIAGNOSTICA (Onda 10).

    Ao contrario de `_request`, nunca insiste e nunca levanta: qualquer falha (rede, timeout,
    HTTP fora de 200/206) devolve None. Quem chama decide como reportar — aqui a falha nao pode
    custar o gatilho, entao nao ha por que repetir com backoff.
    """
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
        "Accept-Profile": ANALYTICS,
    }
    req = urllib.request.Request(alvo, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=HTTP_DIAG_TIMEOUT_SECONDS) as resp:
            if resp.status not in (200, 206):
                return None
            return resp.status, resp.read()
    except urllib.error.HTTPError:
        return None
    except (urllib.error.URLError, OSError, TimeoutError):
        return None


def _contar(url: str, key: str, tabela: str, filtros: str = "", *, schema: str = "public") -> int:
    """Contagem via `Content-Range`, sem trazer linha nenhuma.

    🔴 Nao substituir por `len(json)`: o PostgREST corta em "Max rows" e responde 200, entao
    contar linhas recebidas devolve um numero menor com cara de certo (a licao da Onda 3).
    """
    alvo = f"{url}/rest/v1/{tabela}?select=id"
    if filtros:
        alvo += f"&{filtros}"
    extra = {"Prefer": "count=exact", "Range-Unit": "items", "Range": "0-0"}
    if schema != "public":
        extra["Accept-Profile"] = schema

    status, headers, body = _request(alvo, key, extra=extra)
    if status not in (200, 206):
        raise MedicaoError(f"{tabela}: HTTP {status} — {body[:160].decode('utf-8', 'replace')}")

    faixa = headers.get("Content-Range") or headers.get("content-range") or ""
    total = faixa.split("/")[-1] if "/" in faixa else ""
    if not total.isdigit():
        raise MedicaoError(f"{tabela}: Content-Range sem total utilizavel ({faixa!r})")
    return int(total)


def _rpc(url: str, key: str, funcao: str, params: dict[str, Any]) -> Any:
    """Chama uma funcao do schema `analytics`.

    `Content-Profile` (e NAO `Accept-Profile`) e o header que seleciona o schema em POST /rpc —
    com o outro, o PostgREST procura a funcao em `public` e devolve PGRST202, um erro que aponta
    para o lugar errado.
    """
    status, _, body = _request(
        f"{url}/rest/v1/rpc/{funcao}", key, metodo="POST",
        corpo=json.dumps(params).encode("utf-8"),
        extra={"Content-Type": "application/json", "Content-Profile": ANALYTICS},
    )
    if status != 200:
        raise MedicaoError(f"rpc {funcao}: HTTP {status} — {body[:160].decode('utf-8', 'replace')}")
    return json.loads(body or b"null")


def _buscar_estado_anterior(url: str, key: str, chave: str) -> bool | None:
    """`fired` do ultimo registro de um DIA ANTERIOR deste `trigger_key` (Onda 10).

    🔴 O REGISTRO DO PROPRIO DIA FICA FORA da busca (`measured_on=lt.hoje`). Reexecucao no mesmo
    dia e cenario NORMAL — e a razao de o UPSERT da migration 122 existir. Sem o filtro, a 2a
    execucao do dia leria a linha que a 1a acabou de gravar, a comparacao viraria "hoje contra
    hoje" (`mudou=false`) e o `merge-duplicates` SOBRESCREVERIA o `mudou=true` que a 1a execucao
    registrou — apagando da serie o marcador de transicao, com o resumo negando o alarme que
    motivou a reexecucao. Com o filtro, remedir no mesmo dia e idempotente tambem nesta metrica.

    🔴 DIAGNOSTICO, nao faz parte do contrato de medicao: uma falha aqui NUNCA conta para o exit
    code (ver docstring do modulo, secao EXIT CODE). Devolve None em duas situacoes bem
    diferentes: (a) 1a medicao deste gatilho — sem registro de dia anterior, e isso e NORMAL,
    nada e logado; ou (b) a busca falhou de qualquer forma (rede, HTTP inesperado, JSON
    ilegivel, campo ausente ou nao-booleano) — aqui SIM entra em WARNING, para nao ficar
    engolido em silencio.
    """
    alvo = (f"{url}/rest/v1/{SNAPSHOT_TABLE}?trigger_key=eq.{urllib.parse.quote(chave)}"
            f"&select=fired&order=measured_on.desc&limit=1"
            f"&measured_on=lt.{_hoje_serie()}")
    resultado = _request_leve(alvo, key)
    if resultado is None:
        log.warning("%s: nao consegui checar o estado anterior (rede/HTTP) — sem comparacao "
                    "nesta execucao", chave)
        return None

    _, corpo = resultado
    try:
        linhas = json.loads(corpo or b"[]")
    except (json.JSONDecodeError, UnicodeDecodeError):
        log.warning("%s: resposta ilegivel ao checar o estado anterior — sem comparacao", chave)
        return None

    if not linhas:
        return None                                    # 1a medicao: nada a comparar, e normal

    anterior = linhas[0].get("fired")
    if not isinstance(anterior, bool):
        log.warning("%s: campo 'fired' anterior ausente ou nao-booleano (%r) — sem comparacao",
                    chave, anterior)
        return None
    return anterior


# ---------------------------------------------------------------------------
# Os 7 medidores. Cada um devolve (fired, metrics, criterion).
# ---------------------------------------------------------------------------
Medicao = tuple[bool, dict[str, Any], str]


def medir_dpo_pontualidade(url: str, key: str) -> Medicao:
    """Ja DISPAROU (Onda 9, migration 121) — segue medido para acompanhar a COBERTURA.

    O numero que importa aqui deixou de ser "da para medir?" e passou a ser "quanto do acervo a
    metrica alcanca?". A cobertura cresce sozinha com o tempo (as contas do backfill nao voltam,
    mas as novas nascem com carimbo real), e e util saber quando ela deixa de ser ressalva.
    """
    # A data de corte vem da FONTE UNICA no banco, nunca fixada aqui (ver migration 121/122).
    corte = _rpc(url, key, "payment_date_confiavel_desde", {})
    if not isinstance(corte, str) or len(corte) != 10:
        raise MedicaoError(f"data de corte inesperada: {corte!r}")

    pagas = _contar(url, key, T_CONTAS, "status_id=eq.8")
    reais = _contar(url, key, T_CONTAS,
                    f"status_id=eq.8&payment_date=gte.{corte}")
    pct = round(100.0 * reais / pagas, 1) if pagas else 0.0

    return (
        True,
        {"pagas_total": pagas, "com_carimbo_real": reais, "cobertura_pct": pct,
         "corte": corte},
        "JA ENTREGUE na Onda 9 (migration 121). Continua medido para acompanhar a cobertura: "
        "as contas pagas antes do corte carregam a data do backfill da 096 e ficam fora da "
        "metrica. Quando a cobertura se aproximar de 100 pct, a ressalva do prompt pode ser "
        "revista.",
    )


def medir_cfe_nfce(url: str, key: str) -> Medicao:
    """Gatilho: aparecer QUALQUER documento modelo 59 (CF-e) ou 65 (NFC-e).

    O limiar e 1 porque o custo de entrada e baixo: o parser da Onda 3 ja aceita os dois modelos e
    ja os registraria sozinho. O que o gatilho decide e se vale tratamento proprio.
    """
    achados = _contar(url, key, T_FISCAL, "model=in.(59,65)")
    total = _contar(url, key, T_FISCAL)
    return (
        achados > 0,
        {"cfe_nfce": achados, "documentos_fiscais_total": total},
        "dispara com >= 1 documento modelo 59/65. O parser da Onda 3 ja os aceita e registra; o "
        "gatilho decide se vale tratamento especifico.",
    )


def medir_nfse(url: str, key: str) -> Medicao:
    """Gatilho: volume que amortize a extracao por layout MUNICIPAL (nao ha chave nacional)."""
    contas = _contar(url, key, T_CONTAS, "document_type=eq.nfse")
    emails = _contar(url, key, T_EMAILS, "or=(subject.ilike.*nfs-e*,subject.ilike.*nfse*)")
    return (
        contas >= NFSE_MIN_CONTAS,
        {"contas_nfse": contas, "emails_com_termo_no_assunto": emails,
         "limiar": NFSE_MIN_CONTAS},
        f"dispara com >= {NFSE_MIN_CONTAS} contas do tipo nfse. Sem chave nacional, cada "
        "municipio e um layout: o volume precisa estar CONCENTRADO para amortizar, e a "
        "concentracao por municipio nao e extraivel por consulta — confira o acervo a mao antes "
        "de decidir.",
    )


def medir_text_to_sql(url: str, key: str) -> Medicao:
    """Gatilho: as tools nao cobrirem as perguntas do `ai_chat_log`.

    🔴 PONTO CEGO CONHECIDO, e ele e a parte mais importante desta medicao: o log NAO registra
    "o modelo respondeu que nao consegue". Quando falta capacidade, o modelo declara a limitacao
    com educacao e a interacao fica com `error IS NULL` e tools chamadas — ou seja, CONTA COMO
    SUCESSO. As duas lacunas ja conhecidas (fornecedor x classificacao contabil, e empresa em
    gasto_por_periodo) foram descobertas LENDO o log a mao, nao por consulta.

    Por isso o veredito automatico aqui e conservador e o criterio manda revisar manualmente
    assim que houver amostra. Um `fired = false` deste gatilho significa "nada detectavel por
    consulta", nunca "as tools cobrem tudo".
    """
    total = _contar(url, key, T_CHAT_LOG, schema=ANALYTICS)
    com_erro = _contar(url, key, T_CHAT_LOG, "error=not.is.null", schema=ANALYTICS)
    truncadas = _contar(url, key, T_CHAT_LOG, "truncated=is.true", schema=ANALYTICS)
    descobertas = com_erro + truncadas
    pct = round(100.0 * descobertas / total, 1) if total else 0.0

    amostra_ok = total >= TEXT_TO_SQL_MIN_AMOSTRA
    return (
        amostra_ok and pct >= TEXT_TO_SQL_PCT_DESCOBERTO,
        {"interacoes": total, "com_erro": com_erro, "truncadas": truncadas,
         "pct_descoberto": pct, "amostra_minima": TEXT_TO_SQL_MIN_AMOSTRA,
         "amostra_suficiente": amostra_ok},
        f"dispara com >= {TEXT_TO_SQL_MIN_AMOSTRA} interacoes E >= {TEXT_TO_SQL_PCT_DESCOBERTO} "
        "pct delas com erro/truncagem. ATENCAO: pergunta que o modelo declarou NAO cobrir fica "
        "com error nulo e conta como sucesso — o ponto cego nao e detectavel por consulta. "
        "Havendo amostra, REVISE o log a mao antes de concluir que as tools cobrem tudo.",
    )


def medir_tabelas_agregadas(url: str, key: str) -> Medicao:
    """Gatilho REAL: alguma tool passar de ~500 ms warm. Aqui se mede um PROXY, e isso e dito.

    Medir latencia de tool exige EXPLAIN ANALYZE, e o service_role nao executa as tools por REST
    — nao por acidente: o EXECUTE e exclusivo de `authenticated`, que e o que faz a RLS decidir o
    recorte do chat. Abrir isso para medir latencia trocaria uma garantia de seguranca por
    conveniencia de diagnostico. O proxy honesto e o VOLUME da fato.
    """
    contas = _contar(url, key, T_CONTAS)
    documentos = _contar(url, key, T_FISCAL)
    return (
        contas >= AGREGADOS_PROXY_LINHAS,
        {"contas": contas, "documentos_fiscais": documentos,
         "proxy_limiar_linhas": AGREGADOS_PROXY_LINHAS, "latencia_medida": False},
        f"PROXY por volume: dispara com >= {AGREGADOS_PROXY_LINHAS} contas. O gatilho real e "
        "latencia (>~500 ms warm), que exige EXPLAIN ANALYZE e nao e mensuravel por REST com "
        "service_role — de proposito, ja que o EXECUTE das tools e exclusivo de authenticated. "
        "Atingido o volume, remeca a latencia a mao antes de decidir.",
    )


def medir_receitas_dre(url: str, key: str) -> Medicao:
    """Gatilho DECISORIO, nao mensuravel: o negocio precisar de DRE de verdade.

    Mede-se o que existe (entradas: zero) para a serie registrar que a premissa da decisao segue
    valendo. Este gatilho nunca vai "disparar sozinho" — e correto que nao dispare.
    """
    contas = _contar(url, key, T_CONTAS)
    entradas = _contar(url, key, T_CONTAS, "amount=lt.0")
    return (
        False,
        {"contas": contas, "linhas_de_entrada": entradas, "decisao_de_negocio": True},
        "NAO e gatilho mensuravel: depende de decisao do dono do produto (opcao B, 2026-07-31). "
        "A medicao registra que o sistema segue sem receitas — condicao que sustenta a decisao. "
        "Esforco G: integrar receitas do Firebird muda a natureza do produto.",
    )


def medir_conciliacao(url: str, key: str) -> Medicao:
    """Gatilho: existir integracao bancaria ou extrato. Nao ha fonte — nada a derivar."""
    pagas = _contar(url, key, T_CONTAS, "status_id=eq.8")
    return (
        False,
        {"contas_pagas": pagas, "fonte_bancaria": None},
        "sem integracao bancaria nem extrato: o valor efetivamente pago NAO e derivavel de nada "
        "que exista hoje. Depende de um projeto de entrada de dados, nao de um item de onda.",
    )


MEDIDORES: dict[str, Callable[[str, str], Medicao]] = {
    "dpo_pontualidade": medir_dpo_pontualidade,
    "cfe_nfce": medir_cfe_nfce,
    "nfse": medir_nfse,
    "text_to_sql": medir_text_to_sql,
    "tabelas_agregadas": medir_tabelas_agregadas,
    "receitas_dre": medir_receitas_dre,
    "conciliacao_bancaria": medir_conciliacao,
}


# ---------------------------------------------------------------------------
# Gravacao da serie
# ---------------------------------------------------------------------------
def _upsert(url: str, key: str, linhas: list[dict[str, Any]]) -> tuple[bool, str]:
    """UPSERT de um lote. Devolve (ok, motivo) em vez de levantar — quem chama decide o que fazer.

    Sem `resolution=merge-duplicates`, a segunda execucao do dia levantaria 409 e a serie ficaria
    com o primeiro valor — que e o comportamento errado: a medicao mais recente do dia e a boa.
    """
    status, _, body = _request(
        f"{url}/rest/v1/{SNAPSHOT_TABLE}?on_conflict=trigger_key,measured_on", key,
        metodo="POST", corpo=json.dumps(linhas).encode("utf-8"),
        extra={"Content-Type": "application/json", "Content-Profile": ANALYTICS,
               "Prefer": "resolution=merge-duplicates,return=minimal"},
    )
    if status in (200, 201, 204):
        return True, ""
    return False, f"HTTP {status} — {body[:200].decode('utf-8', 'replace')}"


def gravar(url: str, key: str, linhas: list[dict[str, Any]]) -> list[str]:
    """Grava a serie e devolve as chaves que NAO entraram.

    🔴 ISOLAMENTO ATE O ULTIMO PASSO. O laco de medicao ja isola um gatilho quebrado dos demais,
    mas a gravacao era um lote unico: UMA linha recusada (chave fora do dominio, metrica que o
    jsonb rejeita, valor fora de faixa) devolveria 4xx e levaria os outros seis junto — a serie
    perderia o mes inteiro por causa de um gatilho. O lote continua sendo a via normal (uma
    requisicao, barata); em caso de falha, cada linha e tentada sozinha, para que o estrago fique
    do tamanho do defeito.

    NAO se refaz o lote linha a linha quando a falha e de TRANSPORTE (rede/5xx/timeout): ali o
    `_request` ja repetiu com backoff e insistir 7 vezes so gastaria o orcamento de tempo sem
    mudar o resultado. O sinal e o proprio `MedicaoError`, que o `_request` levanta apenas nesse
    caso — 4xx volta como status, e e esse que merece o desmembramento.
    """
    if not linhas:
        return []

    ok, motivo = _upsert(url, key, linhas)
    if ok:
        return []

    log.error("gravacao em lote falhou (%s); tentando linha a linha para isolar a culpada", motivo)
    recusadas: list[str] = []
    # `enumerate`, nunca `linhas.index(linha)`: `index` casa por IGUALDADE, entao duas linhas de
    # conteudo identico devolveriam a posicao da primeira e o corte sairia errado.
    for i, linha in enumerate(linhas):
        chave = str(linha.get("trigger_key", "?"))
        try:
            ok_linha, motivo_linha = _upsert(url, key, [linha])
        except MedicaoError as e:                    # transporte: insistir nas demais e inutil
            log.error("gravacao de %s: %s — abortando o desmembramento", chave, e)
            recusadas.extend(str(l.get("trigger_key", "?")) for l in linhas[i:])
            break
        if not ok_linha:
            log.error("gravacao de %s recusada: %s", chave, motivo_linha)
            recusadas.append(chave)

    if len(recusadas) == len(linhas):
        raise MedicaoError(f"gravacao da serie: nenhuma linha entrou — {motivo}")
    return recusadas


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Mede os 7 gatilhos condicionais da Onda 9.")
    parser.add_argument("--dry-run", action="store_true",
                        help="mede e imprime, sem gravar a serie")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    url, key = _carrega_env()

    global _deadline                                         # noqa: PLW0603 - ver BUDGET_SECONDS
    _deadline = time.monotonic() + BUDGET_SECONDS

    linhas: list[dict[str, Any]] = []
    falhas: list[str] = []

    for chave, medidor in MEDIDORES.items():
        # Orcamento no INICIO de cada gatilho: parar aqui preserva o que ja foi medido e ainda
        # deixa tempo para gravar. Deixar o Agendador matar o processo perderia tudo.
        if _tempo_esgotado():
            restantes = [c for c in MEDIDORES if c not in {l["trigger_key"] for l in linhas}
                         and c not in falhas]
            log.error("orcamento de %.0fs esgotado; %d gatilho(s) nao medido(s): %s",
                      BUDGET_SECONDS, len(restantes), ", ".join(restantes))
            falhas.extend(restantes)
            break

        # Isolamento por gatilho (padrao do cobranca-vencidos): um indisponivel nao pode custar a
        # serie inteira. A falha e contada para o exit code, nunca engolida.
        try:
            disparou, metricas, criterio = medidor(url, key)
        except MedicaoError as e:
            log.error("gatilho %s: %s", chave, e)
            falhas.append(chave)
            continue
        except Exception:                                    # noqa: BLE001 - ver comentario
            # Erro INESPERADO (bug aqui, contrato mudado) merece traceback: sem ele, um defeito de
            # codigo se disfarcaria de "gatilho indisponivel" por meses.
            log.exception("gatilho %s: falha inesperada", chave)
            falhas.append(chave)
            continue

        # 🔴 COMPARACAO DE ESTADO (Onda 10) — diagnostica, nunca custa o gatilho. Guardada pelo
        # mesmo orcamento de tempo da medicao: se ja estiver esgotado, pula em vez de gastar mais
        # 10s por gatilho restante. `except Exception` e defesa em profundidade contra um bug na
        # propria funcao nova — `_buscar_estado_anterior` ja engole tudo que espera, mas um erro
        # de programacao aqui NAO pode disfarcar uma medicao boa de falha.
        anterior: bool | None = None
        if _tempo_esgotado():
            log.info("%s: checagem de estado anterior pulada (orcamento esgotado)", chave)
        else:
            try:
                anterior = _buscar_estado_anterior(url, key, chave)
            except Exception:                                # noqa: BLE001 - ver comentario acima
                log.warning("%s: falha inesperada ao checar o estado anterior", chave,
                           exc_info=True)
                anterior = None

        mudou = None if anterior is None else (anterior != disparou)
        metricas["mudou_desde_ultima_medicao"] = mudou
        if mudou:
            log.error("MUDANCA DE ESTADO: gatilho %s foi de %s para %s — releia o roadmap "
                      "antes do proximo mes", chave, anterior, disparou)

        linhas.append({"trigger_key": chave, "fired": disparou,
                       "metrics": metricas, "criterion": criterio})
        log.info("%-22s %s  %s", chave, "DISPAROU" if disparou else "nao",
                 json.dumps(metricas, ensure_ascii=False))

    if args.dry_run:
        log.info("--dry-run: %d gatilho(s) medido(s), NADA gravado", len(linhas))
    elif not linhas:
        # 🔴 "serie atualizada: 0 linha(s)" era o log deste caminho, e ele MENTE: nada foi gravado
        # porque nada foi medido. O exit code ja seria 1 (ha falhas), mas quem le o log tem de
        # entender o que aconteceu sem cruzar com outra linha.
        log.error("nenhum gatilho foi medido com sucesso: NADA gravado, a serie fica sem o ponto "
                  "de hoje")
    else:
        try:
            recusadas = gravar(url, key, linhas)
            gravadas = len(linhas) - len(recusadas)
            log.info("serie atualizada: %d de %d linha(s) em analytics.%s",
                     gravadas, len(linhas), SNAPSHOT_TABLE)
            if recusadas:
                log.error("linha(s) recusada(s) na gravacao: %s", ", ".join(recusadas))
                falhas.extend(recusadas)
        except MedicaoError as e:
            log.error("%s", e)
            falhas.append("gravacao")

    disparados = [l["trigger_key"] for l in linhas if l["fired"]]
    mudaram = [l["trigger_key"] for l in linhas if l["metrics"].get("mudou_desde_ultima_medicao")]
    log.info("resumo: %d medido(s), %d falha(s); disparado(s): %s; mudou de estado: %s",
             len(linhas), len(falhas), ", ".join(disparados) or "nenhum",
             ", ".join(mudaram) or "nenhum")

    if falhas:
        log.error("gatilho(s) com falha: %s", ", ".join(falhas))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
