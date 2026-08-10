#!/usr/bin/env python3

import argparse
import contextlib
import hashlib
import json
import os
import sqlite3
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator


BACKUP_ROOT = "switchbridge-history-migration-backups"
LOCK_FILE = ".switchbridge-history-migration.lock"
LOCK_STALE_SECONDS = 30 * 60


class MigrationError(RuntimeError):
    pass


@dataclass(frozen=True)
class MigrationResult:
    rollout_updates: int
    thread_updates: int
    backup_dir: Path | None


@dataclass(frozen=True)
class FileFingerprint:
    device: int
    inode: int
    size: int
    mtime_ns: int
    sha256: str


@dataclass(frozen=True)
class RolloutCandidate:
    path: Path
    original: bytes
    rendered: bytes
    updates: int
    thread_ids: tuple[str, ...]
    fingerprint: FileFingerprint


@dataclass(frozen=True)
class AppliedRollout:
    path: Path
    fingerprint: FileFingerprint


@dataclass(frozen=True)
class RolloutProviderRecord:
    path: Path
    line_number: int
    provider: str
    thread_id: str | None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def stat_identity(stat_result: os.stat_result) -> tuple[int, int, int, int]:
    return (
        int(stat_result.st_dev),
        int(stat_result.st_ino),
        int(stat_result.st_size),
        int(stat_result.st_mtime_ns),
    )


def read_stable_file(path: Path) -> tuple[bytes, FileFingerprint]:
    try:
        before = path.stat()
        content = path.read_bytes()
        after = path.stat()
    except OSError as error:
        raise MigrationError(f"Cannot read rollout file {path}: {error}") from error
    if stat_identity(before) != stat_identity(after):
        raise MigrationError(f"Rollout changed while it was being read; migration aborted: {path}")
    return content, FileFingerprint(
        device=int(after.st_dev),
        inode=int(after.st_ino),
        size=int(after.st_size),
        mtime_ns=int(after.st_mtime_ns),
        sha256=sha256_bytes(content),
    )


def assert_file_unchanged(path: Path, expected: FileFingerprint) -> None:
    _, current = read_stable_file(path)
    if current != expected:
        raise MigrationError(f"Rollout changed after inventory; migration aborted without overwriting it: {path}")


def discover_rollouts(codex_home: Path) -> list[Path]:
    paths: list[Path] = []
    for root_name in ("sessions", "archived_sessions"):
        root = codex_home / root_name
        if not root.exists():
            continue
        paths.extend(sorted(path for path in root.rglob("*.jsonl") if path.is_file()))
    return sorted(paths)


def read_rollout_provider_records(codex_home: Path) -> list[RolloutProviderRecord]:
    records: list[RolloutProviderRecord] = []
    for path in discover_rollouts(codex_home):
        original, _ = read_stable_file(path)
        try:
            text = original.decode("utf-8")
        except UnicodeDecodeError as error:
            raise MigrationError(f"Invalid UTF-8 in {path}: {error}") from error

        for line_number, raw_line in enumerate(text.splitlines(), start=1):
            if not raw_line.strip():
                continue
            try:
                record = json.loads(raw_line)
            except json.JSONDecodeError as error:
                raise MigrationError(f"Invalid JSON in {path}:{line_number}: {error.msg}") from error
            if not isinstance(record, dict) or record.get("type") != "session_meta":
                continue
            payload = record.get("payload")
            if not isinstance(payload, dict):
                continue
            provider = payload.get("model_provider")
            if not isinstance(provider, str):
                continue
            thread_id = payload.get("id")
            records.append(RolloutProviderRecord(
                path=path,
                line_number=line_number,
                provider=provider,
                thread_id=thread_id if isinstance(thread_id, str) and thread_id else None,
            ))
    return records


def list_sqlite_provider_ids(database: Path) -> set[str]:
    if not database.exists():
        return set()
    try:
        readonly_uri = f"{database.resolve().as_uri()}?mode=ro"
        with sqlite3.connect(readonly_uri, uri=True) as connection:
            if not has_threads_provider_column(connection):
                return set()
            rows = connection.execute("SELECT DISTINCT model_provider FROM threads").fetchall()
    except sqlite3.DatabaseError as error:
        raise MigrationError(f"Cannot inspect SQLite database {database}: {error}") from error
    return {
        provider
        for (provider,) in rows
        if isinstance(provider, str) and provider.strip()
    }


def list_source_providers(codex_home: Path) -> list[str]:
    """Return provider IDs present in history without modifying CODEX_HOME."""
    provider_ids = {
        record.provider
        for record in read_rollout_provider_records(Path(codex_home))
        if record.provider.strip()
    }
    provider_ids.update(list_sqlite_provider_ids(Path(codex_home) / "state_5.sqlite"))
    return sorted(provider_ids)


def render_rollout(path: Path, source: str, target: str) -> RolloutCandidate | None:
    original, fingerprint = read_stable_file(path)
    try:
        text = original.decode("utf-8")
    except UnicodeDecodeError as error:
        raise MigrationError(f"Invalid UTF-8 in {path}: {error}") from error

    updates = 0
    rendered_lines: list[str] = []
    thread_ids: list[str] = []
    for line_number, raw_line in enumerate(text.splitlines(keepends=True), start=1):
        line = raw_line.rstrip("\r\n")
        line_ending = raw_line[len(line):]
        if not line.strip():
            rendered_lines.append(raw_line)
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise MigrationError(f"Invalid JSON in {path}:{line_number}: {error.msg}") from error
        if not isinstance(record, dict) or record.get("type") != "session_meta":
            rendered_lines.append(raw_line)
            continue
        payload = record.get("payload")
        if not isinstance(payload, dict) or payload.get("model_provider") != source:
            rendered_lines.append(raw_line)
            continue

        next_payload = dict(payload)
        next_payload["model_provider"] = target
        next_record = dict(record)
        next_record["payload"] = next_payload
        rendered_lines.append(
            json.dumps(next_record, ensure_ascii=False, separators=(",", ":")) + line_ending
        )
        updates += 1
        thread_id = payload.get("id")
        if isinstance(thread_id, str) and thread_id:
            thread_ids.append(thread_id)
    if updates == 0:
        return None
    return RolloutCandidate(
        path=path,
        original=original,
        rendered="".join(rendered_lines).encode("utf-8"),
        updates=updates,
        thread_ids=tuple(thread_ids),
        fingerprint=fingerprint,
    )


def scan_rollouts(codex_home: Path, source: str, target: str = "openai") -> list[RolloutCandidate]:
    candidates: list[RolloutCandidate] = []
    for path in discover_rollouts(codex_home):
        candidate = render_rollout(path, source, target)
        if candidate:
            candidates.append(candidate)
    return candidates


def validate_sqlite(database: Path) -> None:
    if not database.exists():
        return
    try:
        with sqlite3.connect(database) as connection:
            row = connection.execute("PRAGMA integrity_check").fetchone()
            if not row or row[0] != "ok":
                raise MigrationError(f"SQLite integrity_check failed for {database}: {row[0] if row else 'no result'}")
    except sqlite3.DatabaseError as error:
        raise MigrationError(f"Cannot validate SQLite database {database}: {error}") from error


def has_threads_provider_column(connection: sqlite3.Connection) -> bool:
    tables = connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'"
    ).fetchone()
    if not tables:
        return False
    columns = connection.execute("PRAGMA table_info(threads)").fetchall()
    return any(row[1] == "model_provider" for row in columns)


def count_thread_updates(database: Path, source: str) -> int:
    if not database.exists():
        return 0
    try:
        with sqlite3.connect(database) as connection:
            if not has_threads_provider_column(connection):
                return 0
            row = connection.execute(
                "SELECT COUNT(*) FROM threads WHERE model_provider = ?",
                (source,),
            ).fetchone()
            return int(row[0] if row else 0)
    except sqlite3.DatabaseError as error:
        raise MigrationError(f"Cannot inspect SQLite database {database}: {error}") from error


def lock_details(lock_path: Path) -> dict[str, object]:
    try:
        value = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def recover_stale_lock(lock_path: Path) -> bool:
    try:
        _, observed = read_stable_file(lock_path)
    except MigrationError:
        return not lock_path.exists()
    age_seconds = max(0.0, time.time() - (observed.mtime_ns / 1_000_000_000))
    if age_seconds < LOCK_STALE_SECONDS:
        return False

    try:
        _, current = read_stable_file(lock_path)
        if current != observed:
            return False
        lock_path.unlink()
        return True
    except FileNotFoundError:
        return True
    except (MigrationError, OSError):
        return False


@contextlib.contextmanager
def maintenance_lock(codex_home: Path) -> Iterator[None]:
    codex_home.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = codex_home / LOCK_FILE
    token = uuid.uuid4().hex
    metadata = {
        "version": 1,
        "pid": os.getpid(),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "token": token,
    }
    encoded = (json.dumps(metadata, separators=(",", ":")) + "\n").encode("utf-8")

    acquired = False
    for _ in range(3):
        try:
            descriptor = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError as error:
            if recover_stale_lock(lock_path):
                continue
            details = lock_details(lock_path)
            owner = f" pid={details['pid']}" if isinstance(details.get("pid"), int) else ""
            raise MigrationError(
                f"Another Codex history migration appears to be running:{owner} {lock_path}"
            ) from error
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            acquired = True
            break
        except Exception:
            with contextlib.suppress(OSError):
                os.close(descriptor)
            with contextlib.suppress(OSError):
                lock_path.unlink()
            raise

    if not acquired:
        raise MigrationError(f"Could not acquire Codex history migration lock: {lock_path}")

    try:
        yield
    finally:
        details = lock_details(lock_path)
        if details.get("token") == token:
            with contextlib.suppress(FileNotFoundError):
                lock_path.unlink()


@contextlib.contextmanager
def held_maintenance_lock(codex_home: Path) -> Iterator[None]:
    with maintenance_lock(codex_home):
        yield


def relative_to_home(path: Path, codex_home: Path) -> str:
    try:
        return str(path.relative_to(codex_home))
    except ValueError:
        return str(path)


def copy_sqlite_backup(source: Path, target: Path) -> None:
    if not source.exists():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(source) as src, sqlite3.connect(target) as dst:
        src.backup(dst)


def create_backup(codex_home: Path, candidates: list[RolloutCandidate], database: Path, source: str, target: str) -> Path:
    root = codex_home / BACKUP_ROOT
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    backup = root / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ") + f"-{os.getpid()}")
    backup.mkdir(mode=0o700)

    files: list[dict[str, str | int]] = []
    for candidate in candidates:
        rel = relative_to_home(candidate.path, codex_home)
        destination = backup / "files" / rel
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(candidate.original)
        os.chmod(destination, candidate.path.stat().st_mode & 0o777)
        files.append({
            "path": rel,
            "backup": str(Path("files") / rel),
            "sha256": candidate.fingerprint.sha256,
            "mode": candidate.path.stat().st_mode & 0o777,
        })

    database_entry = None
    if database.exists():
        db_backup = backup / "state_5.sqlite"
        copy_sqlite_backup(database, db_backup)
        database_entry = {
            "path": relative_to_home(database, codex_home),
            "backup": "state_5.sqlite",
            "sha256": sha256_file(db_backup),
            "mode": database.stat().st_mode & 0o777,
        }

    manifest = {
        "version": 1,
        "status": "prepared",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "source": source,
        "target": target,
        "rolloutFiles": files,
        "database": database_entry,
        "restore": [
            "Stop Codex before restoring.",
            "Copy each backup file from rolloutFiles.backup back to rolloutFiles.path under CODEX_HOME.",
            "If database is present, replace CODEX_HOME/state_5.sqlite with the backed up SQLite file.",
        ],
    }
    write_json_atomic(backup / "manifest.json", manifest)
    return backup


def write_json_atomic(path: Path, value: object) -> None:
    rendered = (json.dumps(value, indent=2) + "\n").encode("utf-8")
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("wb") as handle:
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()


def complete_manifest(backup: Path) -> None:
    manifest_path = backup / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["status"] = "complete"
    manifest["completedAt"] = datetime.now(timezone.utc).isoformat()
    write_json_atomic(manifest_path, manifest)


def replace_file_if_unchanged(
    path: Path,
    rendered: bytes,
    expected: FileFingerprint,
    mode: int,
) -> FileFingerprint:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("wb") as handle:
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        assert_file_unchanged(path, expected)
        os.replace(temporary, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()
    _, fingerprint = read_stable_file(path)
    if fingerprint.sha256 != sha256_bytes(rendered):
        raise MigrationError(f"Rollout verification failed immediately after replacement: {path}")
    return fingerprint


def rewrite_rollout_atomic(candidate: RolloutCandidate) -> AppliedRollout:
    mode = candidate.path.stat().st_mode & 0o777
    fingerprint = replace_file_if_unchanged(
        candidate.path,
        candidate.rendered,
        candidate.fingerprint,
        mode,
    )
    return AppliedRollout(candidate.path, fingerprint)


def restore_rollouts(backup: Path, changed: list[AppliedRollout], codex_home: Path) -> None:
    manifest = json.loads((backup / "manifest.json").read_text(encoding="utf-8"))
    by_path = {entry["path"]: entry for entry in manifest.get("rolloutFiles", [])}
    for change in reversed(changed):
        rel = relative_to_home(change.path, codex_home)
        entry = by_path.get(rel)
        if not entry:
            continue
        backup_path = backup / entry["backup"]
        original = backup_path.read_bytes()
        if sha256_bytes(original) != entry.get("sha256"):
            raise MigrationError(f"Backup checksum mismatch while restoring {change.path}")
        replace_file_if_unchanged(
            change.path,
            original,
            change.fingerprint,
            int(entry["mode"]),
        )


def collect_rollout_providers(codex_home: Path, source: str) -> dict[str, str]:
    providers: dict[str, str] = {}
    for record in read_rollout_provider_records(codex_home):
        if record.provider == source:
            raise MigrationError(
                f"Verification failed: {record.path}:{record.line_number} still uses provider {source!r}"
            )
        if record.thread_id is None:
            continue
        previous = providers.get(record.thread_id)
        if previous is not None and previous != record.provider:
            raise MigrationError(
                f"Verification failed: rollout metadata disagrees for thread {record.thread_id!r}"
            )
        providers[record.thread_id] = record.provider
    return providers


def verify(
    codex_home: Path,
    database: Path,
    source: str,
    target: str,
    connection: sqlite3.Connection | None = None,
    migrated_thread_ids: set[str] | None = None,
) -> None:
    rollout_providers = collect_rollout_providers(codex_home, source)
    expected_ids = migrated_thread_ids or set()
    for thread_id in expected_ids:
        if rollout_providers.get(thread_id) != target:
            raise MigrationError(
                f"Verification failed: rollout thread {thread_id!r} did not converge to provider {target!r}"
            )

    if database.exists():
        owns_connection = connection is None
        db = connection or sqlite3.connect(database)
        try:
            row = db.execute("PRAGMA integrity_check").fetchone()
            if not row or row[0] != "ok":
                raise MigrationError(f"SQLite integrity_check failed after migration: {row[0] if row else 'no result'}")
            if has_threads_provider_column(db):
                remaining = db.execute(
                    "SELECT COUNT(*) FROM threads WHERE model_provider = ?",
                    (source,),
                ).fetchone()
                if int(remaining[0] if remaining else 0) != 0:
                    raise MigrationError(f"Verification failed: SQLite threads still use provider {source!r}")
                columns = {row[1] for row in db.execute("PRAGMA table_info(threads)")}
                if "id" in columns:
                    sqlite_providers = dict(db.execute("SELECT id, model_provider FROM threads"))
                    for thread_id, rollout_provider in rollout_providers.items():
                        if thread_id not in sqlite_providers:
                            continue
                        sqlite_provider = sqlite_providers[thread_id]
                        if (
                            rollout_provider in (source, target)
                            or sqlite_provider in (source, target)
                        ) and sqlite_provider != rollout_provider:
                            raise MigrationError(
                                "Verification failed: JSONL and SQLite providers disagree for "
                                f"thread {thread_id!r}: {rollout_provider!r} != {sqlite_provider!r}"
                            )
                    for thread_id in expected_ids:
                        if thread_id in sqlite_providers and sqlite_providers[thread_id] != target:
                            raise MigrationError(
                                f"Verification failed: SQLite thread {thread_id!r} did not converge "
                                f"to provider {target!r}"
                            )
        finally:
            if owns_connection:
                db.close()


def update_threads(connection: sqlite3.Connection, source: str, target: str) -> int:
    if not has_threads_provider_column(connection):
        return 0
    cursor = connection.execute(
        "UPDATE threads SET model_provider = ? WHERE model_provider = ?",
        (target, source),
    )
    return int(cursor.rowcount if cursor.rowcount is not None else 0)


def run_migration(codex_home: Path, source: str, target: str, dry_run: bool = False) -> MigrationResult:
    codex_home = Path(codex_home)
    if not source or not target:
        raise MigrationError("Both source and target providers are required.")
    if source == target:
        return MigrationResult(0, 0, None)

    database = codex_home / "state_5.sqlite"
    if dry_run:
        candidates = scan_rollouts(codex_home, source, target)
        validate_sqlite(database)
        return MigrationResult(
            sum(candidate.updates for candidate in candidates),
            count_thread_updates(database, source),
            None,
        )

    with maintenance_lock(codex_home):
        candidates = scan_rollouts(codex_home, source, target)
        validate_sqlite(database)
        thread_updates = count_thread_updates(database, source)
        if not candidates and thread_updates == 0:
            return MigrationResult(0, 0, None)

        for candidate in candidates:
            assert_file_unchanged(candidate.path, candidate.fingerprint)
        backup = create_backup(codex_home, candidates, database, source, target)
        changed: list[AppliedRollout] = []
        connection = sqlite3.connect(database, timeout=10) if database.exists() else None
        sqlite_committed = False
        try:
            if connection is not None:
                connection.execute("BEGIN IMMEDIATE")
            for candidate in candidates:
                changed.append(rewrite_rollout_atomic(candidate))
            actual_thread_updates = update_threads(connection, source, target) if connection is not None else 0
            migrated_thread_ids = {
                thread_id
                for candidate in candidates
                for thread_id in candidate.thread_ids
            }
            verify(
                codex_home,
                database,
                source,
                target,
                connection=connection,
                migrated_thread_ids=migrated_thread_ids,
            )
            if connection is not None:
                connection.commit()
                sqlite_committed = True
            try:
                complete_manifest(backup)
            except Exception as error:
                if sqlite_committed:
                    raise MigrationError(
                        "History data was migrated consistently, but the backup manifest could not "
                        f"be marked complete: {backup}"
                    ) from error
                raise
            return MigrationResult(
                sum(candidate.updates for candidate in candidates),
                actual_thread_updates,
                backup,
            )
        except Exception as error:
            if sqlite_committed:
                raise
            if connection is not None:
                connection.rollback()
            try:
                restore_rollouts(backup, changed, codex_home)
            except Exception as restore_error:
                raise MigrationError(
                    "History migration failed and an active rollout prevented safe automatic "
                    f"restoration. Restore manually from {backup}: {restore_error}"
                ) from error
            raise
        finally:
            if connection is not None:
                connection.close()


def result_to_json(result: MigrationResult) -> str:
    return json.dumps({
        "rollout_updates": result.rollout_updates,
        "thread_updates": result.thread_updates,
        "backup_dir": str(result.backup_dir) if result.backup_dir else None,
    }, indent=2)


def source_inventory_to_json(source_providers: list[str]) -> str:
    return json.dumps({"source_providers": source_providers}, indent=2)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Migrate local Codex history provider labels.")
    parser.add_argument("--codex-home", type=Path, required=True)
    parser.add_argument("--source")
    parser.add_argument("--target")
    parser.add_argument(
        "--list-sources",
        action="store_true",
        help="List provider IDs found in JSONL and SQLite history without modifying files.",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true", dest="json_output")
    args = parser.parse_args(argv)

    try:
        if args.list_sources:
            if args.source is not None or args.target is not None or args.dry_run:
                raise MigrationError("--list-sources cannot be combined with migration arguments.")
            source_providers = list_source_providers(args.codex_home)
            if args.json_output:
                print(source_inventory_to_json(source_providers))
            elif source_providers:
                print("\n".join(source_providers))
            else:
                print("No provider IDs were found in local Codex history.")
            return 0
        if args.source is None or args.target is None:
            raise MigrationError("Both --source and --target are required for migration.")
        result = run_migration(args.codex_home, args.source, args.target, dry_run=args.dry_run)
    except MigrationError as error:
        if args.json_output:
            print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr)
        else:
            print(f"error: {error}", file=sys.stderr)
        return 1

    if args.json_output:
        print(result_to_json(result))
    else:
        print(f"Rollout session_meta updates: {result.rollout_updates}")
        print(f"SQLite thread updates: {result.thread_updates}")
        if result.backup_dir:
            print(f"Backup directory: {result.backup_dir}")
        elif args.dry_run:
            print("Dry run only; no files were changed.")
        else:
            print("No migration changes were needed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
