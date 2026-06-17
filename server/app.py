"""
app.py — Backend local do pagamentos

Expõe a leitura de e-mails financeiros (read_emails.run_reader) como API HTTP,
para que o frontend dispare a busca por um botão em vez de rodar o script no
terminal. Roda na máquina onde estão as credenciais IMAP e a service_role do
Supabase (ambas no .env da raiz do projeto, carregado pelo próprio read_emails).

Dois modos de disparo:
  - POST /api/emails/read        → síncrono (bloqueia até terminar; ponte da Next API)
  - POST /api/emails/read/start  → assíncrono (dispara em thread, responde na hora)
  - GET  /api/emails/progress    → progresso do job assíncrono em andamento

Execução:
    python server/app.py
    # → http://127.0.0.1:8000  (o Vite faz proxy de /api para esta porta)
"""

import sys
import time
import threading
from pathlib import Path

from flask import Flask, request, jsonify

# ---------------------------------------------------------------------------
# Importa a skill email-reader sem duplicar lógica.
# read_emails.py carrega o .env da raiz do projeto por conta própria.
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR  = PROJECT_ROOT / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import read_emails  # noqa: E402  (depende do sys.path acima)

# Limites de validação de entrada
MAX_DAYS = 365

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Estado de progresso do job assíncrono (compartilhado entre a thread de
# leitura e as requisições GET /api/emails/progress). Protegido por lock.
# ---------------------------------------------------------------------------
_progress_lock = threading.Lock()
_progress = {
    "running": False,
    "phase": "idle",        # idle | iniciando | lendo | concluído | erro
    "total": 0,             # e-mails encontrados no servidor
    "done": 0,              # e-mails já percorridos
    "processed": 0,         # financeiros extraídos
    "skipped_keyword": 0,
    "skipped_dup": 0,
    "started_at": None,     # epoch (s)
    "finished_at": None,    # epoch (s)
    "summary": None,        # dict de run_reader ao concluir
    "error": None,          # mensagem ao falhar
}


def _parse_read_params(body: dict):
    """Valida/normaliza os parâmetros do corpo. Lança ValueError se 'days' inválido."""
    days = int(body.get("days", 0) or 0)  # ValueError tratado pelo chamador
    days = max(0, min(days, MAX_DAYS))
    return {
        "days":      days,
        "all_":      bool(body.get("all", False)),
        "dry_run":   bool(body.get("dry_run", False)),
        "mark_seen": bool(body.get("mark_seen", False)),
    }


def _on_progress(ev: dict) -> None:
    """Callback passado ao run_reader — atualiza o estado compartilhado."""
    keys = ("phase", "total", "done", "processed", "skipped_keyword", "skipped_dup")
    with _progress_lock:
        for k in keys:
            if k in ev:
                _progress[k] = ev[k]


def _run_job(params: dict) -> None:
    """Executa run_reader em background e registra o resultado no progresso."""
    try:
        summary = read_emails.run_reader(on_progress=_on_progress, **params)
        with _progress_lock:
            _progress.update({
                "running": False, "phase": "concluído",
                "summary": summary, "finished_at": time.time(),
            })
    except Exception as e:  # noqa: BLE001 — superfície de erro para o GET /progress
        with _progress_lock:
            _progress.update({
                "running": False, "phase": "erro",
                "error": str(e), "finished_at": time.time(),
            })


@app.get("/api/health")
def health():
    """Sonda simples para o frontend saber se o backend está no ar."""
    return jsonify({"status": "ok"})


@app.post("/api/emails/read")
def read_emails_endpoint():
    """
    Dispara a leitura IMAP de forma SÍNCRONA (bloqueia até terminar).
    Mantido para a ponte da Next API. O frontend usa /start + /progress.
    """
    body = request.get_json(silent=True) or {}
    try:
        params = _parse_read_params(body)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Parâmetro 'days' inválido"}), 400

    try:
        summary = read_emails.run_reader(**params)
        return jsonify({"ok": True, "summary": summary})
    except RuntimeError as e:
        return jsonify({"ok": False, "error": str(e)}), 502
    except Exception as e:  # noqa: BLE001 — superfície de erro p/ o frontend
        return jsonify({"ok": False, "error": f"Erro inesperado: {e}"}), 500


@app.post("/api/emails/read/start")
def read_emails_start():
    """
    Dispara a leitura IMAP de forma ASSÍNCRONA: inicia a thread e responde na
    hora, evitando segurar um request HTTP por vários minutos (o que fazia o
    proxy derrubar a conexão e o frontend "achar que travou"). O andamento é
    consultado por GET /api/emails/progress.
    """
    body = request.get_json(silent=True) or {}
    try:
        params = _parse_read_params(body)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Parâmetro 'days' inválido"}), 400

    with _progress_lock:
        if _progress["running"]:
            return jsonify({"ok": True, "started": False, "already_running": True})
        # Reseta o estado e marca como rodando ANTES de soltar o lock (evita corrida
        # com um segundo clique disparando outra thread).
        _progress.update({
            "running": True, "phase": "iniciando", "total": 0, "done": 0,
            "processed": 0, "skipped_keyword": 0, "skipped_dup": 0,
            "started_at": time.time(), "finished_at": None,
            "summary": None, "error": None,
        })

    threading.Thread(target=_run_job, args=(params,), daemon=True).start()
    return jsonify({"ok": True, "started": True})


@app.get("/api/emails/progress")
def read_emails_progress():
    """Snapshot do progresso do job assíncrono (+ elapsed em segundos)."""
    with _progress_lock:
        snap = dict(_progress)
    if snap["started_at"]:
        end = snap["finished_at"] or time.time()
        snap["elapsed"] = round(end - snap["started_at"], 1)
    else:
        snap["elapsed"] = 0
    return jsonify({"ok": True, "progress": snap})


if __name__ == "__main__":
    # threaded=True: a extração de PDF pode ser demorada; evita travar a sonda.
    app.run(host="127.0.0.1", port=8000, threaded=True)
