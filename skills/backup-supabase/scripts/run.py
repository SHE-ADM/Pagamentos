"""Entry-point do backup do Supabase (banco + Storage).

Chamado pelo Windows Task Scheduler (scheduler/run_backup.ps1) 1x por dia às
02:00. Orquestra: pg_dump do banco -> download do bucket attachments ->
manifesto -> retenção. Exit code 0 em sucesso, != 0 em falha operacional
(o wrapper .ps1 marca a tarefa como vermelha e grava no Event Log).

Uso:
    py -3 skills/backup-supabase/scripts/run.py
    py -3 skills/backup-supabase/scripts/run.py --dry-run     # valida sem gravar
    py -3 skills/backup-supabase/scripts/run.py --skip-storage # só o banco
    py -3 skills/backup-supabase/scripts/run.py --skip-db      # só o Storage
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime
from pathlib import Path

# Módulos irmãos (mesma pasta) — padrão dos scripts do projeto.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import config  # noqa: E402
from backup_db import DbBackupError, dump_database, pg_dump_version  # noqa: E402
from backup_storage import StorageBackup, StorageBackupError  # noqa: E402
from retention import apply_retention  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("backup.run")


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Backup do Supabase (banco + Storage).")
    p.add_argument("--dry-run", action="store_true",
                   help="Valida config e conectividade sem gerar arquivos.")
    p.add_argument("--skip-db", action="store_true", help="Não faz backup do banco.")
    p.add_argument("--skip-storage", action="store_true",
                   help="Não faz backup do Storage.")
    return p.parse_args(argv)


# ---------------------------------------------------------------------------
# Dry-run — só valida, não grava nada
# ---------------------------------------------------------------------------
def _dry_run(args: argparse.Namespace) -> int:
    log.info("MODO DRY-RUN — nada será gravado.")
    ok = True

    if not args.skip_db:
        try:
            pg_dump_exe = config.find_pg_dump()
            log.info("pg_dump: %s", pg_dump_version(pg_dump_exe))
            if not config.db_url():
                raise config.ConfigError("SUPABASE_DB_URL não definido no .env.")
            log.info("SUPABASE_DB_URL definido. Schemas: %s",
                     ",".join(config.db_schemas()))
        except (config.ConfigError, DbBackupError) as e:
            ok = False
            log.exception("Banco: %s", e)

    if not args.skip_storage:
        try:
            sb = StorageBackup(config.supabase_url(), config.supabase_service_key(),
                               config.storage_bucket())
            total = sb.count_objects()
            log.info("Storage '%s': %d objeto(s) seriam baixados.",
                     config.storage_bucket(), total)
        except StorageBackupError as e:
            ok = False
            log.exception("Storage: %s", e)

    log.info("Retenção configurada: %d dias em %s",
             config.retention_days(), config.output_dir())
    log.info("Dry-run %s.", "OK" if ok else "encontrou problemas")
    return 0 if ok else 1


# ---------------------------------------------------------------------------
# Execução real
# ---------------------------------------------------------------------------
def _run(args: argparse.Namespace) -> int:
    started = datetime.now()
    run_id = config.timestamp()
    run_dir = config.output_dir() / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    log.info("===== Backup %s =====", run_id)
    log.info("Destino: %s", run_dir)

    manifest: dict = {
        "run_id": run_id,
        "started_at": started.isoformat(timespec="seconds"),
        "db": None,
        "storage": None,
        "errors": [],
    }
    exit_code = 0

    # 1) Banco de dados -----------------------------------------------------
    if args.skip_db:
        log.info("Banco: pulado (--skip-db).")
    else:
        try:
            pg_dump_exe = config.find_pg_dump()
            dump_file = dump_database(
                config.db_url(), run_dir / "db", config.db_schemas(), pg_dump_exe,
            )
            manifest["db"] = {
                "file": str(dump_file.relative_to(run_dir)),
                "bytes": dump_file.stat().st_size,
                "schemas": config.db_schemas(),
                "pg_dump": pg_dump_version(pg_dump_exe),
            }
        except (config.ConfigError, DbBackupError) as e:
            exit_code = 1
            manifest["errors"].append(f"db: {e}")
            log.exception("Backup do banco FALHOU: %s", e)

    # 2) Storage ------------------------------------------------------------
    if args.skip_storage:
        log.info("Storage: pulado (--skip-storage).")
    else:
        try:
            sb = StorageBackup(config.supabase_url(), config.supabase_service_key(),
                               config.storage_bucket())
            summary = sb.download_all(run_dir / "storage")
            manifest["storage"] = summary
            if summary["failed"] > 0:
                log.warning("Storage: %d arquivo(s) falharam no download.",
                            summary["failed"])
        except StorageBackupError as e:
            exit_code = 1
            manifest["errors"].append(f"storage: {e}")
            log.exception("Backup do Storage FALHOU: %s", e)

    # 3) Manifesto ----------------------------------------------------------
    manifest["finished_at"] = datetime.now().isoformat(timespec="seconds")
    manifest["duration_seconds"] = round((datetime.now() - started).total_seconds(), 1)
    manifest["status"] = "ok" if exit_code == 0 else "erro"
    (run_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8",
    )

    # 4) Retenção (sempre roda; não afeta o exit code do backup atual) ------
    try:
        apply_retention(config.output_dir(), config.retention_days())
    except Exception as e:  # NÃO-fatal
        log.warning("Retenção falhou: %s", e)

    dur = manifest["duration_seconds"]
    if exit_code == 0:
        log.info("===== Backup OK em %ss =====", dur)
    else:
        log.error("===== Backup com ERRO em %ss: %s =====",
                  dur, "; ".join(manifest["errors"]))
    return exit_code


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        return _dry_run(args) if args.dry_run else _run(args)
    except Exception as e:  # rede de segurança — nunca deixa exceção escapar sem log
        log.exception("Erro inesperado no backup: %s", e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
