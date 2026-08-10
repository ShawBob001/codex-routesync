import importlib.util
import io
import json
import os
import shutil
import sqlite3
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("migrate-history-provider.py")
SPEC = importlib.util.spec_from_file_location("migrate_history_provider", SCRIPT)
migration = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(migration)

MigrationError = migration.MigrationError
run_migration = migration.run_migration
held_maintenance_lock = migration.held_maintenance_lock
list_source_providers = migration.list_source_providers


def read_jsonl(path: Path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def read_thread_providers(database: Path):
    with sqlite3.connect(database) as connection:
        return dict(connection.execute("SELECT id, model_provider FROM threads"))


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="csb-migrate-test-"))
        self.home = self.root / ".codex"
        sessions = self.home / "sessions" / "2026" / "08" / "10"
        sessions.mkdir(parents=True)
        (self.home / "archived_sessions").mkdir(parents=True)
        self.rollout = sessions / "rollout.jsonl"
        self.source = "relay.corp/v2"
        self.target = "openai"
        self.session_meta = {
            "timestamp": "2026-08-10T00:00:00.000Z",
            "type": "session_meta",
            "model_provider": self.source,
            "payload": {
                "id": "thread-1",
                "timestamp": "2026-08-10T00:00:00.000Z",
                "cwd": "/tmp/project",
                "originator": "codex_vscode",
                "model_provider": self.source,
                "preserve": {"nested": True},
            },
        }
        self.non_session_record = {
            "timestamp": "2026-08-10T00:00:01.000Z",
            "type": "response_item",
            "model_provider": self.source,
            "payload": {
                "type": "message",
                "role": "user",
                "content": "do not mutate message contents",
                "model_provider": self.source,
            },
        }
        self.flat_session_meta = {
            "type": "session_meta",
            "id": "flat-thread",
            "model_provider": self.source,
            "payload": {"id": "flat-thread", "cwd": "/tmp/legacy-fixture"},
        }
        self.original_lines = [
            json.dumps(self.session_meta),
            json.dumps(self.non_session_record, separators=(", ", ": ")),
            json.dumps(self.flat_session_meta),
        ]
        self.rollout.write_text("\n".join(self.original_lines) + "\n", encoding="utf-8")
        self.before_rollout = self.rollout.read_bytes()

        self.database = self.home / "state_5.sqlite"
        with sqlite3.connect(self.database) as connection:
            connection.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, title TEXT)")
            connection.execute(
                "INSERT INTO threads (id, model_provider, title) VALUES (?, ?, ?)",
                ("thread-1", self.source, "private title"),
            )
            connection.execute(
                "INSERT INTO threads (id, model_provider, title) VALUES (?, ?, ?)",
                ("thread-2", self.target, "already migrated"),
            )

    def tearDown(self):
        shutil.rmtree(self.root)

    def test_dry_run_reports_nested_provider_without_writing(self):
        result = run_migration(self.home, self.source, self.target, dry_run=True)

        self.assertEqual((result.rollout_updates, result.thread_updates), (1, 1))
        self.assertIsNone(result.backup_dir)
        self.assertEqual(self.rollout.read_bytes(), self.before_rollout)

    def test_list_sources_uses_history_inventory_only_and_is_read_only(self):
        inventory_rollout = self.home / "archived_sessions" / "inventory.jsonl"
        inventory_rollout.write_text(
            "\n".join([
                json.dumps({
                    "type": "session_meta",
                    "model_provider": "Friendly Display Name",
                    "payload": {"id": "orphaned-thread", "model_provider": "orphaned-provider"},
                }),
                json.dumps({
                    "type": "session_meta",
                    "model_provider": "flat-display-only",
                    "payload": {"id": "flat-only-thread"},
                }),
                json.dumps({
                    "type": "response_item",
                    "payload": {"model_provider": "message-only-provider"},
                }),
            ]) + "\n",
            encoding="utf-8",
        )
        with sqlite3.connect(self.database) as connection:
            connection.execute(
                "INSERT INTO threads (id, model_provider, title) VALUES (?, ?, ?)",
                ("sqlite-only-thread", "sqlite-only-provider", "inventory only"),
            )

        before_files = {
            path.relative_to(self.home): path.read_bytes()
            for path in self.home.rglob("*")
            if path.is_file()
        }

        providers = list_source_providers(self.home)
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            exit_code = migration.main([
                "--codex-home",
                str(self.home),
                "--list-sources",
                "--json",
            ])

        expected = [
            "openai",
            "orphaned-provider",
            "relay.corp/v2",
            "sqlite-only-provider",
        ]
        self.assertEqual(providers, expected)
        self.assertEqual(exit_code, 0)
        self.assertEqual(json.loads(stdout.getvalue()), {"source_providers": expected})
        after_files = {
            path.relative_to(self.home): path.read_bytes()
            for path in self.home.rglob("*")
            if path.is_file()
        }
        self.assertEqual(after_files, before_files)
        self.assertFalse((self.home / migration.LOCK_FILE).exists())
        self.assertFalse((self.home / migration.BACKUP_ROOT).exists())

    def test_migration_updates_only_nested_session_provider_and_is_idempotent(self):
        first = run_migration(self.home, self.source, self.target)
        second = run_migration(self.home, self.source, self.target)

        self.assertEqual((first.rollout_updates, first.thread_updates), (1, 1))
        self.assertEqual((second.rollout_updates, second.thread_updates), (0, 0))
        self.assertIsNone(second.backup_dir)

        records = read_jsonl(self.rollout)
        self.assertEqual(records[0]["payload"]["model_provider"], self.target)
        self.assertEqual(records[0]["payload"]["preserve"], {"nested": True})
        self.assertEqual(records[0]["model_provider"], self.source)
        self.assertEqual(records[1], self.non_session_record)
        self.assertEqual(records[2], self.flat_session_meta)
        self.assertEqual(self.rollout.read_text(encoding="utf-8").splitlines()[1:], self.original_lines[1:])

        providers = read_thread_providers(self.database)
        self.assertEqual(providers["thread-1"], self.target)
        self.assertEqual(providers["thread-2"], self.target)
        self.assertIsNotNone(first.backup_dir)
        manifest = json.loads((first.backup_dir / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["status"], "complete")

    def test_non_session_record_with_nested_provider_is_ignored(self):
        source = "message-only-provider"
        path = self.home / "archived_sessions" / "ignored.jsonl"
        record = {
            "type": "response_item",
            "payload": {"id": "message-1", "model_provider": source},
        }
        original = (json.dumps(record, separators=(", ", ": ")) + "\n").encode("utf-8")
        path.write_bytes(original)

        result = run_migration(self.home, source, self.target)

        self.assertEqual((result.rollout_updates, result.thread_updates), (0, 0))
        self.assertEqual(path.read_bytes(), original)
        self.assertIsNone(result.backup_dir)

    def test_flat_session_provider_is_never_treated_as_real_metadata(self):
        source = "flat-only-provider"
        path = self.home / "archived_sessions" / "flat.jsonl"
        record = {
            "type": "session_meta",
            "id": "flat-only-thread",
            "model_provider": source,
            "payload": {"id": "flat-only-thread"},
        }
        original = (json.dumps(record) + "\n").encode("utf-8")
        path.write_bytes(original)

        result = run_migration(self.home, source, self.target)

        self.assertEqual((result.rollout_updates, result.thread_updates), (0, 0))
        self.assertEqual(path.read_bytes(), original)

    def test_invalid_json_aborts_before_backup_or_write(self):
        self.rollout.write_text("{invalid}\n", encoding="utf-8")

        with self.assertRaises(MigrationError):
            run_migration(self.home, self.source, self.target)

        backup_root = self.home / migration.BACKUP_ROOT
        self.assertFalse(backup_root.exists())
        self.assertEqual(read_thread_providers(self.database)["thread-1"], self.source)

    def test_locked_migration_is_rejected(self):
        with held_maintenance_lock(self.home):
            with self.assertRaises(MigrationError):
                run_migration(self.home, self.source, self.target)

    def test_stale_lockfile_is_recovered(self):
        lock_path = self.home / migration.LOCK_FILE
        lock_path.write_text('{"pid":999999,"token":"stale"}\n', encoding="utf-8")
        stale_time = time.time() - migration.LOCK_STALE_SECONDS - 10
        os.utime(lock_path, (stale_time, stale_time))

        with held_maintenance_lock(self.home):
            details = json.loads(lock_path.read_text(encoding="utf-8"))
            self.assertNotEqual(details["token"], "stale")

        self.assertFalse(lock_path.exists())

    def test_rollout_append_after_inventory_aborts_without_overwriting_append(self):
        original_rewrite = migration.rewrite_rollout_atomic
        appended = {
            "type": "response_item",
            "payload": {"type": "message", "content": "appended by active turn"},
        }

        def append_then_rewrite(candidate):
            with candidate.path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(appended) + "\n")
            return original_rewrite(candidate)

        with mock.patch.object(migration, "rewrite_rollout_atomic", side_effect=append_then_rewrite):
            with self.assertRaisesRegex(MigrationError, "changed after inventory"):
                run_migration(self.home, self.source, self.target)

        records = read_jsonl(self.rollout)
        self.assertEqual(records[0]["payload"]["model_provider"], self.source)
        self.assertEqual(records[-1], appended)
        self.assertEqual(read_thread_providers(self.database)["thread-1"], self.source)

    def test_thread_id_mismatch_rolls_back_both_stores(self):
        with sqlite3.connect(self.database) as connection:
            connection.execute(
                "UPDATE threads SET model_provider = ? WHERE id = ?",
                ("different-provider", "thread-1"),
            )

        with self.assertRaisesRegex(MigrationError, "providers disagree"):
            run_migration(self.home, self.source, self.target)

        self.assertEqual(self.rollout.read_bytes(), self.before_rollout)
        self.assertEqual(read_thread_providers(self.database)["thread-1"], "different-provider")

    def test_manifest_completion_failure_never_splits_jsonl_and_sqlite(self):
        with mock.patch.object(migration, "complete_manifest", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(MigrationError, "migrated consistently"):
                run_migration(self.home, self.source, self.target)

        records = read_jsonl(self.rollout)
        self.assertEqual(records[0]["payload"]["model_provider"], self.target)
        self.assertEqual(read_thread_providers(self.database)["thread-1"], self.target)

        backup_root = self.home / migration.BACKUP_ROOT
        manifests = list(backup_root.glob("*/manifest.json"))
        self.assertEqual(len(manifests), 1)
        manifest = json.loads(manifests[0].read_text(encoding="utf-8"))
        self.assertEqual(manifest["status"], "prepared")

        retry = run_migration(self.home, self.source, self.target)
        self.assertEqual((retry.rollout_updates, retry.thread_updates), (0, 0))


if __name__ == "__main__":
    unittest.main()
