"""Backup dos arquivos do Storage (bucket attachments) via API REST.

Reusa o mesmo padrão de HTTP do read_emails.py: urllib (stdlib) + a
SUPABASE_SERVICE_KEY (ignora RLS). Lista o bucket (com paginação e recursão
defensiva em subpastas) e baixa cada objeto para storage/<bucket>/<key>.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

log = logging.getLogger("backup.storage")

_LIST_PAGE = 100          # itens por página no list
_DOWNLOAD_TIMEOUT = 120   # segundos por arquivo


class StorageBackupError(RuntimeError):
    """Falha global no backup do Storage (falha de item é apenas logada)."""


class StorageBackup:
    def __init__(self, base_url: str, service_key: str, bucket: str):
        if not base_url or not service_key:
            raise StorageBackupError(
                "SUPABASE_URL / SUPABASE_SERVICE_KEY ausentes no .env."
            )
        self.base = base_url.rstrip("/")
        self.bucket = bucket
        self.headers = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
        }

    # -- listagem -----------------------------------------------------------
    def list_objects(self, prefix: str = "") -> list[str]:
        """Retorna todas as chaves do bucket sob `prefix` (recursivo)."""
        keys: list[str] = []
        offset = 0
        while True:
            rows = self._list_page(prefix, offset)
            if not rows:
                break
            for row in rows:
                name = row.get("name")
                if not name:
                    continue
                full = f"{prefix}{name}"
                # Pasta: entrada sem id e sem metadata -> recorre.
                if row.get("id") is None and row.get("metadata") is None:
                    keys.extend(self.list_objects(prefix=f"{full}/"))
                else:
                    keys.append(full)
            if len(rows) < _LIST_PAGE:
                break
            offset += _LIST_PAGE
        return keys

    def _list_page(self, prefix: str, offset: int) -> list:
        body = json.dumps({
            "prefix": prefix,
            "limit": _LIST_PAGE,
            "offset": offset,
            "sortBy": {"column": "name", "order": "asc"},
        }).encode()
        req = urllib.request.Request(
            f"{self.base}/storage/v1/object/list/{self.bucket}",
            data=body,
            headers={**self.headers, "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:200]
            raise StorageBackupError(
                f"Falha ao listar o bucket '{self.bucket}': {e.code} {detail}"
            )

    # -- download -----------------------------------------------------------
    def download_all(self, dest_dir: Path) -> dict:
        """Baixa todos os objetos para dest_dir. Retorna resumo com contagens.

        Falha de um arquivo é NÃO-fatal (logada e contabilizada em `failed`);
        o backup segue com os demais.
        """
        keys = self.list_objects()
        bucket_dir = dest_dir / self.bucket
        bucket_dir.mkdir(parents=True, exist_ok=True)

        downloaded = 0
        failed = 0
        total_bytes = 0

        for key in keys:
            try:
                data = self._download_object(key)
            except Exception as e:  # NÃO-fatal por item
                failed += 1
                log.warning("Falha ao baixar '%s': %s", key, e)
                continue
            target = bucket_dir / key
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            downloaded += 1
            total_bytes += len(data)

        log.info(
            "Storage: %d baixados, %d falhas, %.2f MB",
            downloaded, failed, total_bytes / 1_048_576,
        )
        return {
            "bucket": self.bucket,
            "listed": len(keys),
            "downloaded": downloaded,
            "failed": failed,
            "total_bytes": total_bytes,
        }

    def _download_object(self, key: str) -> bytes:
        quoted = urllib.parse.quote(key, safe="/")
        req = urllib.request.Request(
            f"{self.base}/storage/v1/object/{self.bucket}/{quoted}",
            headers=self.headers,
        )
        with urllib.request.urlopen(req, timeout=_DOWNLOAD_TIMEOUT) as r:
            return r.read()

    def count_objects(self) -> int:
        """Só conta os objetos (usado no --dry-run, sem baixar nada)."""
        return len(self.list_objects())
