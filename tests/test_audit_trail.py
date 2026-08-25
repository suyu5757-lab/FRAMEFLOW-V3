from __future__ import annotations

import unittest
import threading
import uuid
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import server
from frameflow import audit_trail
from frameflow import database as database_module
from frameflow.database import Database


class AuditTrailCoverageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db_path = Path(__file__).parent / f"test-audit-{uuid.uuid4().hex}.db"
        self.db_patch = mock.patch.object(server, "DB_PATH", self.db_path)
        self.db_patch.start()
        self.context = TestClient(server.app, raise_server_exceptions=False)
        self.client = self.context.__enter__()
        created = self.client.post(
            "/api/v2/projects",
            json={"name": "FF-P2-013 audit test", "ratio": "16:9", "duration": 8, "generator": "manual", "brief": "audit coverage"},
        )
        self.assertEqual(created.status_code, 201, created.text)
        self.project_id = created.json()["document"]["id"]

    def tearDown(self) -> None:
        self.context.__exit__(None, None, None)
        self.db_patch.stop()
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.db_path) + suffix)
            if candidate.is_file():
                candidate.unlink()

    def test_project_update_has_complete_durable_audit_event(self) -> None:
        updated = self.client.patch(
            f"/api/v2/projects/{self.project_id}",
            json={"expected_revision": 1, "name": "FF-P2-013 audit test updated"},
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        events = self.client.get(f"/api/v2/projects/{self.project_id}/audit-events")
        self.assertEqual(events.status_code, 200, events.text)
        event = next(item for item in events.json()["events"] if item["action"] == "project_updated")
        self.assertEqual(event["actor"], "local-operator")
        self.assertEqual(event["reason"], "project_metadata_updated")
        self.assertEqual(event["target_type"], "project")
        self.assertEqual(event["target_id"], self.project_id)
        self.assertEqual(event["before"]["name"], "FF-P2-013 audit test")
        self.assertEqual(event["after"]["name"], "FF-P2-013 audit test updated")
        self.assertEqual(event["result"], "success")
        self.assertTrue(event["created_at"])

    def test_story_and_asset_mutations_have_before_after_contract(self) -> None:
        story = self.client.put(
            f"/api/v2/projects/{self.project_id}/story",
            json={
                "expected_revision": 1,
                "spec": {"creative_goal": "audit story", "duration": 8, "ratio": "16:9"},
                "script": "A door opens.",
                "scenes": [{"id": "SC01", "location": "room"}],
                "shots": [{"id": "SH01", "scene": "SC01", "duration": 4, "purpose": "open", "size": "wide", "camera": "locked", "action": "door opens"}],
            },
        )
        self.assertEqual(story.status_code, 200, story.text)
        asset = self.client.post(
            f"/api/v2/projects/{self.project_id}/assets",
            json={"expected_revision": 2, "name": "Lead", "asset_class": "character", "asset_role": "hero"},
        )
        self.assertEqual(asset.status_code, 200, asset.text)
        asset_id = asset.json()["asset"]["id"]
        events = self.client.get(f"/api/v2/projects/{self.project_id}/audit-events?limit=20").json()["events"]
        story_event = next(item for item in events if item["action"] == "story_updated")
        self.assertEqual(story_event["actor"], "local-operator")
        self.assertEqual(story_event["reason"], "story_document_updated")
        self.assertEqual(story_event["target_id"], self.project_id)
        self.assertEqual(story_event["before"]["script"], "")
        self.assertEqual(story_event["after"]["script"], "A door opens.")
        asset_event = next(item for item in events if item["action"] == "asset_created")
        self.assertEqual(asset_event["target_id"], asset_id)
        self.assertEqual(asset_event["before"], {})
        self.assertEqual(asset_event["after"]["name"], "Lead")
        self.assertEqual(asset_event["result"], "success")

    def test_prompt_mutation_has_reason_and_redacts_secret_like_fields(self) -> None:
        created = self.client.post(
            f"/api/v2/projects/{self.project_id}/assets",
            json={"expected_revision": 1, "name": "Scene", "asset_class": "scene", "asset_role": "location"},
        )
        self.assertEqual(created.status_code, 200, created.text)
        asset_id = created.json()["asset"]["id"]
        prompt = self.client.post(
            f"/api/v2/projects/{self.project_id}/assets/{asset_id}/prompt-versions",
            json={"prompt": "A quiet room", "source": "asset-library", "change_reason": "initial_prompt"},
        )
        self.assertEqual(prompt.status_code, 200, prompt.text)
        events = self.client.get(f"/api/v2/projects/{self.project_id}/audit-events?limit=20").json()["events"]
        event = next(item for item in events if item["action"] == "prompt_version_created")
        self.assertEqual(event["reason"], "prompt_version_created")
        self.assertEqual(event["after"]["prompt"], "A quiet room")
        self.assertEqual(event["result"], "success")

        audit_trail.record_event(
            server.app.state.db,
            project_id=self.project_id,
            action="redaction_probe",
            target_type="project",
            target_id=self.project_id,
            reason="test_redaction",
            after={"visible": "ok", "api_key": "should-not-leak", "nested": {"password": "hidden"}},
        )
        redacted = audit_trail.list_events(server.app.state.db, self.project_id, 20)
        probe = next(item for item in redacted if item["action"] == "redaction_probe")
        self.assertEqual(probe["after"]["visible"], "ok")
        self.assertEqual(probe["after"]["api_key"], "[REDACTED]")
        self.assertEqual(probe["after"]["nested"]["password"], "[REDACTED]")

    def test_audit_write_failure_rolls_back_project_mutation(self) -> None:
        with mock.patch.object(server.audit_trail, "write_event_connection", side_effect=RuntimeError("audit unavailable")):
            failed = self.client.patch(
                f"/api/v2/projects/{self.project_id}",
                json={"expected_revision": 1, "name": "must roll back"},
            )
        self.assertEqual(failed.status_code, 500, failed.text)
        current = self.client.get(f"/api/v2/projects/{self.project_id}")
        self.assertEqual(current.status_code, 200, current.text)
        self.assertEqual(current.json()["document"]["name"], "FF-P2-013 audit test")
        self.assertEqual(current.json()["revision"], 1)
        events = self.client.get(f"/api/v2/projects/{self.project_id}/audit-events").json()["events"]
        self.assertFalse(any(item["action"] == "project_updated" for item in events))

    def test_v15_to_v16_migration_preserves_rows_and_integrity(self) -> None:
        legacy_path = Path(__file__).parent / f"test-audit-v15-{uuid.uuid4().hex}.db"
        legacy = Database.__new__(Database)
        legacy.path = legacy_path
        legacy._lock = threading.RLock()
        try:
            with legacy.connect() as connection:
                legacy.applied_versions(connection)
                for version in range(1, 16):
                    if version == 8:
                        columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(projects)").fetchall()}
                        if "lifecycle_status" not in columns:
                            connection.execute("ALTER TABLE projects ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active'")
                    legacy._apply_migration(connection, database_module.MIGRATIONS[version]["up"])
                    connection.execute("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)", (version, "2026-08-24T00:00:00+00:00"))
                    connection.execute("COMMIT")
                connection.execute(
                    "INSERT INTO projects(id,name,document_json,revision,created_at,updated_at,lifecycle_status) VALUES(?,?,?,?,?,?,?)",
                    ("PRJ_MIGRATION", "migration", "{}", 1, "now", "now", "active"),
                )
            with legacy.connect() as connection:
                before_count = connection.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
            legacy.migrate()
            with legacy.connect() as connection:
                self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 0)
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM projects").fetchone()[0], before_count)
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM audit_events_v16").fetchone()[0], 0)
                self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
                self.assertEqual({row[0] for row in connection.execute("SELECT version FROM schema_migrations")}, set(range(1, 17)))
        finally:
            for suffix in ("", "-wal", "-shm"):
                candidate = Path(str(legacy_path) + suffix)
                if candidate.is_file():
                    candidate.unlink()


if __name__ == "__main__":
    unittest.main()
