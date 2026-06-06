"""
app.py — Backend local do pagamentos

Expõe a leitura de e-mails financeiros (read_emails.run_reader) como API HTTP,
para que o frontend dispare a busca por um botão em vez de rodar o script no
terminal. Roda na máquina onde estão as credenciais IMAP e a service_role do
Supabase (ambas no .env da raiz do projeto, carregado pelo próprio read_emails).

Execução:
    python server/app.py
    # → http://127.0.0.1:8000  (o Vite faz proxy de /api para esta porta)
"""

import sys
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


@app.get("/api/health")
def health():
    """Sonda simples para o frontend saber se o backend está no ar."""
    return jsonify({"status": "ok"})


@app.post("/api/emails/read")
def read_emails_endpoint():
    """
    Dispara a leitura IMAP.

    Body JSON (todos opcionais):
      days       int  — últimos N dias (0 = apenas não lidos / UNSEEN)
      all        bool — processar TODOS os e-mails (ignora UNSEEN)
      dry_run    bool — listar sem baixar anexos nem gravar
      mark_seen  bool — marcar como lidos após processar
    """
    body = request.get_json(silent=True) or {}

    # ── Validação de entrada ──────────────────────────────────────────────
    try:
        days = int(body.get("days", 0) or 0)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Parâmetro 'days' inválido"}), 400
    days = max(0, min(days, MAX_DAYS))

    all_      = bool(body.get("all", False))
    dry_run   = bool(body.get("dry_run", False))
    mark_seen = bool(body.get("mark_seen", False))

    # ── Execução ──────────────────────────────────────────────────────────
    try:
        summary = read_emails.run_reader(
            days=days, all_=all_, dry_run=dry_run, mark_seen=mark_seen
        )
        return jsonify({"ok": True, "summary": summary})
    except RuntimeError as e:
        # Falha de IMAP (credenciais, rede, etc.) — erro tratado
        return jsonify({"ok": False, "error": str(e)}), 502
    except Exception as e:  # noqa: BLE001 — superfície de erro p/ o frontend
        return jsonify({"ok": False, "error": f"Erro inesperado: {e}"}), 500


if __name__ == "__main__":
    # threaded=True: a extração de PDF pode ser demorada; evita travar a sonda.
    app.run(host="127.0.0.1", port=8000, threaded=True)
