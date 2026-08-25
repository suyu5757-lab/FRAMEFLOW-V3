from __future__ import annotations

import hashlib
import json
import sqlite3
import unittest
import uuid
from pathlib import Path
from unittest import mock
from zipfile import ZipFile

from fastapi.testclient import TestClient

import server


def recovery_project() -> dict:
    return {
        "id": "PRJ_RECOVERY", "name": "Recovery test", "ratio": "16:9", "duration": 10,
        "generator": "manual", "brief": "backup export recovery", "stage": 0, "sortOrder": 0,
        "script": "", "assets": [], "shots": [], "audio": {}, "assetRegulator": {},
        "generations": [], "seedancePackages": [], "providerOverrides": {}, "undoStack": [],
        "scriptVersions": [], "storyboardVersions": [], "storyWorkflowRuns": [],
    }


class RecoveryV3Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.db_path = Path(__file__).parent / f"test-recovery-{uuid.uuid4().hex}.db"
        self.db_patch = mock.patch.object(server, "DB_PATH", self.db_path)
        self.db_patch.start()
        self.secret_patch = mock.patch.object(server, "get_secret", return_value=None)
        self.secret_patch.start()
        self.client_context = TestClient(server.app)
        self.client = self.client_context.__enter__()
        created = self.client.put("/api/v2/projects/PRJ_RECOVERY", json={"document": recovery_project()})
        self.assertEqual(created.status_code, 200, created.text)
        self.media_path = server.DATA_DIR / "projects" / "PRJ_RECOVERY" / "artifacts" / "source.mp4"
        self.media_path.parent.mkdir(parents=True, exist_ok=True)
        self.media_path.write_bytes(b"recovery-export-media")
        digest = hashlib.sha256(self.media_path.read_bytes()).hexdigest()
        with server.app.state.db.connect() as connection:
            connection.execute(
                "INSERT INTO artifacts(id,project_id,artifact_type,local_path,sha256,mime_type,qa_decision,status,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                ("ART_RECOVERY", "PRJ_RECOVERY", "video", str(self.media_path), digest, "video/mp4", "Pending", "generated_pending_qa", "{}", server.utcnow()),
            )

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        self.secret_patch.stop()
        self.db_patch.stop()
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.db_path) + suffix)
            if candidate.is_file():
                candidate.unlink()

    def test_verified_backup_contains_sqlite_and_media_hash_manifest(self) -> None:
        response = self.client.post("/api/v2/system/backups", json={"project_id": "PRJ_RECOVERY"})
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["status"], "verified")
        database_path = Path(payload["database_path"]); manifest_path = Path(payload["manifest_path"])
        self.assertTrue(database_path.is_file()); self.assertTrue(manifest_path.is_file())
        self.assertEqual(hashlib.sha256(database_path.read_bytes()).hexdigest(), payload["database_sha256"])
        self.assertEqual(hashlib.sha256(manifest_path.read_bytes()).hexdigest(), payload["manifest_sha256"])
        connection = sqlite3.connect(database_path)
        try:self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        finally:connection.close()
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        source = next(item for item in manifest["files"] if item["relative_path"].endswith("source.mp4"))
        self.assertEqual(source["sha256"], hashlib.sha256(self.media_path.read_bytes()).hexdigest())
        with server.app.state.db.connect() as connection:
            record = connection.execute("SELECT status,verified_at FROM backup_records_v11 WHERE id=?", (payload["id"],)).fetchone()
        self.assertEqual(record["status"], "verified"); self.assertIsNotNone(record["verified_at"])

    def test_project_export_is_self_verifying_and_contains_database_authority(self) -> None:
        response = self.client.post("/api/v2/projects/PRJ_RECOVERY/export")
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json(); archive = Path(payload["archive_path"])
        self.assertEqual(payload["status"], "verified"); self.assertTrue(archive.is_file())
        self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), payload["archive_sha256"])
        with ZipFile(archive, "r") as package:
            manifest = json.loads(package.read("manifest.json").decode("utf-8"))
            self.assertEqual(manifest["project_id"], "PRJ_RECOVERY")
            self.assertEqual(manifest["database_rows"]["artifacts"][0]["id"], "ART_RECOVERY")
            self.assertEqual(hashlib.sha256(package.read("media/artifacts/source.mp4")).hexdigest(), manifest["files"][0]["sha256"])

    def test_recovery_requires_preview_confirmation_and_unchanged_source(self) -> None:
        orphan_root = server.DATA_DIR / "projects" / "PRJ_ORPHAN"
        orphan_media = orphan_root / "artifacts" / "orphan.mp4"
        orphan_media.parent.mkdir(parents=True)
        orphan_media.write_bytes(b"orphan-v1")
        scan = self.client.get("/api/v2/recovery/scan")
        self.assertIn("PRJ_ORPHAN", scan.json()["unregistered_project_directories"])
        preview = self.client.post("/api/v2/recovery/preview", json={"source_project_id": "PRJ_ORPHAN", "proposed_name": "Recovered orphan"})
        self.assertEqual(preview.status_code, 200, preview.text)
        plan = preview.json(); self.assertTrue(plan["dry_run"]); self.assertFalse(plan["apply_performed"])
        with server.app.state.db.connect() as connection:
            self.assertIsNone(connection.execute("SELECT 1 FROM projects WHERE id='PRJ_ORPHAN'").fetchone())
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM artifacts WHERE project_id='PRJ_ORPHAN'").fetchone()[0], 0)
        unconfirmed = self.client.post("/api/v2/recovery/apply", json={"preview_id": plan["id"], "manifest_sha256": plan["manifest_sha256"], "confirmed": False})
        self.assertEqual(unconfirmed.status_code, 409, unconfirmed.text)
        orphan_media.write_bytes(b"orphan-v2-changed")
        changed = self.client.post("/api/v2/recovery/apply", json={"preview_id": plan["id"], "manifest_sha256": plan["manifest_sha256"], "confirmed": True})
        self.assertEqual(changed.status_code, 409, changed.text)
        self.assertEqual(changed.json()["details"]["recovery"]["code"], "source_changed")

        refreshed = self.client.post("/api/v2/recovery/preview", json={"source_project_id": "PRJ_ORPHAN", "proposed_name": "Recovered orphan"}).json()
        applied = self.client.post("/api/v2/recovery/apply", json={"preview_id": refreshed["id"], "manifest_sha256": refreshed["manifest_sha256"], "confirmed": True})
        self.assertEqual(applied.status_code, 200, applied.text)
        self.assertTrue(applied.json()["verified"]); self.assertEqual(applied.json()["artifact_candidates_created"], 1)
        with server.app.state.db.connect() as connection:
            project = connection.execute("SELECT document_json FROM projects WHERE id='PRJ_ORPHAN'").fetchone()
            artifact = connection.execute("SELECT qa_decision,status,sha256 FROM artifacts WHERE project_id='PRJ_ORPHAN'").fetchone()
        self.assertIsNotNone(project)
        self.assertEqual((artifact["qa_decision"], artifact["status"]), ("Pending", "mapping_required"))
        self.assertEqual(artifact["sha256"], hashlib.sha256(orphan_media.read_bytes()).hexdigest())
        self.assertTrue(orphan_media.is_file())

    def test_recovery_preview_never_overwrites_existing_project(self) -> None:
        preview = self.client.post("/api/v2/recovery/preview", json={"source_project_id": "PRJ_RECOVERY"})
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertEqual(preview.json()["status"], "blocked")
        self.assertFalse(preview.json()["apply_allowed"])
        self.assertEqual(preview.json()["conflicts"][0]["code"], "project_id_exists")


if __name__ == "__main__":
    unittest.main()
