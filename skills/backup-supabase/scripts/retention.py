"""Retenção — remove pastas de backup mais antigas que N dias.

Só apaga subpastas cujo nome casa o carimbo de tempo do backup
(YYYY-MM-DD_HHMMSS), nunca outros arquivos — defesa contra apagar algo
fora do escopo esperado.
"""

from __future__ import annotations

import logging
import re
import shutil
from datetime import datetime, timedelta
from pathlib import Path

log = logging.getLogger("backup.retention")

# Nome de uma pasta de backup: 2026-07-03_020000
_BACKUP_DIR_RE = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{6}$")
_PARSE_FMT = "%Y-%m-%d_%H%M%S"


def apply_retention(backups_root: Path, keep_days: int) -> int:
    """Apaga backups anteriores a `keep_days`. Retorna quantos foram removidos."""
    if not backups_root.is_dir():
        return 0

    cutoff = datetime.now() - timedelta(days=keep_days)
    removed = 0

    for entry in backups_root.iterdir():
        if not entry.is_dir() or not _BACKUP_DIR_RE.match(entry.name):
            continue
        try:
            created = datetime.strptime(entry.name, _PARSE_FMT)
        except ValueError:
            # Nome não parseável apesar do regex — usa o mtime como fallback.
            created = datetime.fromtimestamp(entry.stat().st_mtime)
        if created < cutoff:
            try:
                shutil.rmtree(entry)
                removed += 1
                log.info("Backup antigo removido: %s", entry.name)
            except OSError as e:  # NÃO-fatal
                log.warning("Não foi possível remover %s: %s", entry.name, e)

    if removed:
        log.info("Retenção: %d backup(s) além de %d dias removido(s).", removed, keep_days)
    return removed
