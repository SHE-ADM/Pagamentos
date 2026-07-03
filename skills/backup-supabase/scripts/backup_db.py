"""Backup do banco de dados via pg_dump (formato custom, restaurável).

Gera um arquivo .dump por execução, comprimido e restaurável com pg_restore.
A senha do banco NUNCA vai na linha de comando (visível na lista de processos):
é passada via a variável de ambiente PGPASSWORD, e os demais campos vêm da
connection string decomposta.
"""

from __future__ import annotations

import logging
import os
import subprocess
import urllib.parse
from pathlib import Path

log = logging.getLogger("backup.db")

# pg_dump pode demorar em bases grandes — teto generoso, mas finito, para não
# travar o agendador indefinidamente.
DUMP_TIMEOUT_SECONDS = int(os.getenv("BACKUP_DB_TIMEOUT", "1800"))  # 30 min


class DbBackupError(RuntimeError):
    """Falha na geração do dump — mensagem pronta para o log."""


def _parse_db_url(url: str) -> dict:
    """Decompõe a connection string em host/port/user/password/dbname.

    Aceita o formato postgresql://user:pass@host:port/dbname (o mesmo do pgAdmin).
    """
    if not url:
        raise DbBackupError(
            "SUPABASE_DB_URL não definido no .env. Cole a MESMA connection string "
            "que funciona no pgAdmin (aba Session pooler do dashboard), no formato "
            "postgresql://postgres.<ref>:<senha>@<host-pooler>:5432/postgres"
        )
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("postgresql", "postgres"):
        raise DbBackupError(
            f"SUPABASE_DB_URL com esquema inesperado: '{parts.scheme}'. "
            "Use postgresql://..."
        )
    if not parts.hostname or not parts.username:
        raise DbBackupError(
            "SUPABASE_DB_URL incompleta — faltando host ou usuário."
        )
    return {
        "host": parts.hostname,
        "port": str(parts.port or 5432),
        "user": urllib.parse.unquote(parts.username),
        "password": urllib.parse.unquote(parts.password or ""),
        "dbname": (parts.path or "/postgres").lstrip("/") or "postgres",
    }


def pg_dump_version(pg_dump_exe: str) -> str:
    """Versão do pg_dump (para o manifesto e para alertar sobre incompatibilidade)."""
    try:
        out = subprocess.run(
            [pg_dump_exe, "--version"],
            capture_output=True, text=True, timeout=30,
        )
        return (out.stdout or out.stderr).strip()
    except Exception as e:  # pragma: no cover - diagnóstico best-effort
        return f"desconhecida ({e})"


def dump_database(
    db_url: str,
    out_dir: Path,
    schemas: list[str],
    pg_dump_exe: str,
) -> Path:
    """Executa o pg_dump e retorna o caminho do arquivo .dump gerado.

    - Formato custom (-Fc): comprimido e restaurável seletivamente.
    - --no-owner/--no-privileges: restauração limpa em outro projeto/role.
    - Um --schema por item de `schemas` (padrão: public).
    """
    conn = _parse_db_url(db_url)
    out_dir.mkdir(parents=True, exist_ok=True)

    schema_tag = "-".join(schemas) if schemas else "all"
    out_file = out_dir / f"db_{conn['dbname']}_{schema_tag}.dump"

    cmd = [
        pg_dump_exe,
        "--host", conn["host"],
        "--port", conn["port"],
        "--username", conn["user"],
        "--dbname", conn["dbname"],
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--verbose",
        "--file", str(out_file),
    ]
    for schema in schemas:
        cmd += ["--schema", schema]

    # Ambiente: senha via PGPASSWORD (fora do argv) + SSL exigido pelo Supabase.
    env = os.environ.copy()
    env["PGPASSWORD"] = conn["password"]
    env["PGSSLMODE"] = env.get("PGSSLMODE", "require")

    log.info(
        "pg_dump -> %s (host=%s db=%s schemas=%s)",
        out_file.name, conn["host"], conn["dbname"], ",".join(schemas) or "all",
    )

    try:
        proc = subprocess.run(
            cmd, env=env, capture_output=True, text=True,
            timeout=DUMP_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise DbBackupError(
            f"pg_dump excedeu o tempo limite de {DUMP_TIMEOUT_SECONDS}s."
        )
    except FileNotFoundError:
        raise DbBackupError(f"pg_dump não pôde ser executado: {pg_dump_exe}")

    if proc.returncode != 0:
        # stderr do pg_dump traz o motivo real (versão incompatível, auth, etc.).
        detail = (proc.stderr or "").strip()[-800:]
        # Remove o arquivo parcial para não parecer um backup válido.
        out_file.unlink(missing_ok=True)
        raise DbBackupError(
            f"pg_dump falhou (exit {proc.returncode}). Detalhe: {detail}"
        )

    if not out_file.exists() or out_file.stat().st_size == 0:
        raise DbBackupError("pg_dump terminou sem erro mas o arquivo ficou vazio.")

    size = out_file.stat().st_size
    log.info("Dump concluído: %s (%.2f MB)", out_file.name, size / 1_048_576)
    return out_file
