"""Configuração central da skill backup-supabase.

Carrega o .env da raiz do projeto (mesmo padrão de read_emails/cobranca),
resolve caminhos de saída e localiza o executável pg_dump. Sem efeitos
colaterais além de ler variáveis de ambiente.
"""

from __future__ import annotations

import os
import shutil
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Raiz do projeto e .env
# scripts/config.py -> parents[3] = raiz do projeto (mesma profundidade que
# skills/email-reader/scripts/read_emails.py)
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parents[3]
load_dotenv(PROJECT_ROOT / ".env")

# ---------------------------------------------------------------------------
# Constantes padrão (sobrescritíveis por .env — "explícito sobre implícito")
# ---------------------------------------------------------------------------
DEFAULT_SCHEMAS = "public"
DEFAULT_BUCKET = "attachments"
DEFAULT_RETENTION_DAYS = 30
TIMESTAMP_FMT = "%Y-%m-%d_%H%M%S"

# Locais comuns do pg_dump no Windows (PostgreSQL nativo tem precedência sobre
# o binário embutido no pgAdmin, por ser a versão completa do servidor).
_PG_DUMP_GLOBS = (
    r"C:\Program Files\PostgreSQL\*\bin\pg_dump.exe",
    # pgAdmin: instala em ...\runtime\ (sem subpasta) OU ...\<versão>\runtime\
    r"C:\Program Files\pgAdmin 4\runtime\pg_dump.exe",
    r"C:\Program Files\pgAdmin 4\*\runtime\pg_dump.exe",
    r"C:\Program Files (x86)\pgAdmin 4\runtime\pg_dump.exe",
    r"C:\Program Files (x86)\pgAdmin 4\*\runtime\pg_dump.exe",
)


class ConfigError(RuntimeError):
    """Configuração ausente ou inválida — mensagem já pronta para o log."""


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


# ---------------------------------------------------------------------------
# Getters de configuração
# ---------------------------------------------------------------------------
def supabase_url() -> str:
    return _env("SUPABASE_URL").rstrip("/")


def supabase_service_key() -> str:
    return _env("SUPABASE_SERVICE_KEY")


def db_url() -> str:
    """Connection string do Postgres (a MESMA usada no pgAdmin).

    Ex.: postgresql://postgres.<ref>:<senha>@<host-pooler>:5432/postgres
    """
    return _env("SUPABASE_DB_URL")


def db_schemas() -> list[str]:
    raw = _env("BACKUP_DB_SCHEMAS", DEFAULT_SCHEMAS)
    return [s.strip() for s in raw.split(",") if s.strip()]


def storage_bucket() -> str:
    return _env("BACKUP_STORAGE_BUCKET", DEFAULT_BUCKET)


def retention_days() -> int:
    raw = _env("BACKUP_RETENTION_DAYS", str(DEFAULT_RETENTION_DAYS))
    try:
        value = int(raw)
        return value if value > 0 else DEFAULT_RETENTION_DAYS
    except ValueError:
        return DEFAULT_RETENTION_DAYS


def output_dir() -> Path:
    """Pasta raiz dos backups (padrão: backups/ na raiz do projeto)."""
    override = _env("BACKUP_OUTPUT_DIR")
    return Path(override) if override else PROJECT_ROOT / "backups"


def timestamp() -> str:
    return datetime.now().strftime(TIMESTAMP_FMT)


# ---------------------------------------------------------------------------
# Detecção do pg_dump
# ---------------------------------------------------------------------------
def find_pg_dump() -> str:
    """Retorna o caminho do pg_dump.exe.

    Ordem: PG_DUMP_PATH no .env -> PATH -> instalações comuns (PostgreSQL,
    pgAdmin). Levanta ConfigError com instruções se não encontrar.
    """
    explicit = _env("PG_DUMP_PATH")
    if explicit:
        if Path(explicit).is_file():
            return explicit
        raise ConfigError(
            f"PG_DUMP_PATH aponta para um arquivo inexistente: {explicit}"
        )

    on_path = shutil.which("pg_dump")
    if on_path:
        return on_path

    for pattern in _PG_DUMP_GLOBS:
        base = Path(pattern).anchor
        rel = pattern[len(base):]
        matches = sorted(Path(base).glob(rel), reverse=True)  # versão maior 1º
        if matches:
            return str(matches[0])

    raise ConfigError(
        "pg_dump.exe não encontrado. Instale o PostgreSQL 17 client ou defina "
        "PG_DUMP_PATH no .env apontando para o pg_dump.exe (o pgAdmin traz um em "
        r"'C:\Program Files\pgAdmin 4\<versão>\runtime\pg_dump.exe')."
    )
