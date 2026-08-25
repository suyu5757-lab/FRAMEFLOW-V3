from __future__ import annotations

import json
import unittest
import uuid
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import server
from frameflow.database import Database, utcnow
from frameflow.maintenance import derive_story_asset_links


def project_document(project_id: str = "PRJ_MAINTENANCE") -> dict:
    return {
        "id": project_id,
        "name": "维护测试项目",
        "ratio": "16:9",
        "duration": 12,
        "generator": "local-fake",
        "brief": "maintenance contract",
        "stage": 0,
        "sortOrder": 0,
        "script": "",
        "assets": [{"id": "C001", "assetClass": "character", "assetRole": "identity", "required": True}],
        "shots": [{"id": "S001", "status": "ready", "duration": 4}],
        "audio": {},
        "assetRegulator": {},
        "generations": [],
        "seedancePackages": [],
        "providerOverrides": {},
        "undoStack": [],
        "scriptVersions": [],
        "storyboardVersions": [],
        "storyWorkflowRuns": [],
    }


class MaintenanceV3Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.db_path = Path(__file__).parent / f"test-maintenance-{uuid.uuid4().hex}.db"
        self.db_patch = mock.patch.object(server, "DB_PATH", self.db_path)
        self.db_patch.start()
        self.secret_patch = mock.patch.object(server, "get_secret", return_value=None)
        self.secret_patch.start()
        self.client_context = TestClient(server.app)
        self.client = self.client_context.__enter__()
        response = self.client.put("/api/v2/projects/PRJ_MAINTENANCE", json={"document": project_document()})
        self.assertEqual(response.status_code, 200, response.text)

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        self.secret_patch.stop()
        self.db_patch.stop()
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.db_path) + suffix)
            if candidate.is_file():
                candidate.unlink()

    def test_archive_is_hidden_by_default_and_restorable(self) -> None:
        archived = self.client.patch(
            "/api/v2/projects/PRJ_MAINTENANCE",
            json={"lifecycleStatus": "archived", "expected_revision": 1},
        )
        self.assertEqual(archived.status_code, 200, archived.text)
        self.assertEqual(self.client.get("/api/v2/projects").json()["projects"], [])
        visible = self.client.get("/api/v2/projects?include_archived=true")
        self.assertEqual(visible.status_code, 200, visible.text)
        self.assertEqual(visible.json()["projects"][0]["document"]["lifecycleStatus"], "archived")

        restored = self.client.patch(
            "/api/v2/projects/PRJ_MAINTENANCE",
            json={"lifecycleStatus": "active", "expected_revision": 2},
        )
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertEqual(len(self.client.get("/api/v2/projects").json()["projects"]), 1)

    def test_delete_blocks_active_v3_runs_and_cleans_after_completion(self) -> None:
        kept = self.client.put("/api/v2/projects/PRJ_KEEP", json={"document": project_document("PRJ_KEEP")})
        self.assertEqual(kept.status_code, 200, kept.text)
        run_id = "RUN_MAINTENANCE"
        now = utcnow()
        with Database(self.db_path).connect() as connection:
            connection.execute(
                "INSERT INTO workflow_runs_v3 (id, project_id, graph_revision, status, request_json, graph_snapshot_json, estimate_json, result_json, error_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (run_id, "PRJ_MAINTENANCE", 1, "running", "{}", "{}", "{}", None, None, now, now),
            )
        blocked = self.client.delete("/api/v2/projects/PRJ_MAINTENANCE")
        self.assertEqual(blocked.status_code, 409, blocked.text)
        self.assertTrue(blocked.json()["message"])

        with Database(self.db_path).connect() as connection:
            connection.execute("UPDATE workflow_runs_v3 SET status='succeeded' WHERE id=?", (run_id,))
        deleted = self.client.delete("/api/v2/projects/PRJ_MAINTENANCE")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertTrue(deleted.json()["project_files_preserved"])
        remaining = self.client.get("/api/v2/projects").json()["projects"]
        self.assertEqual([item["document"]["id"] for item in remaining], ["PRJ_KEEP"])

    def test_asset_links_only_add_verified_relationships(self) -> None:
        result = derive_story_asset_links(
            project_document(),
            [{"logical_asset_id": "C001", "metadata_json": json.dumps({"relevant_shots": ["S001", "UNKNOWN"]})}],
        )
        self.assertEqual([(item["asset_id"], item["shot_id"]) for item in result["added"]], [("C001", "S001")])
        self.assertEqual(result["unresolved"][0]["shot_id"], "UNKNOWN")
        self.assertEqual(result["document"]["shots"][0]["assetRequirements"][0]["assetId"], "C001")

    def test_system_data_audit_cannot_be_green_with_missing_project_directory(self) -> None:
        project_root = server.DATA_DIR / "projects" / "PRJ_MAINTENANCE"
        self.assertTrue(project_root.is_dir())
        project_root.rmdir()
        storage = self.client.get("/api/v2/projects/integrity")
        audit = self.client.get("/api/v2/system/data-audit")
        self.assertEqual(storage.status_code, 200, storage.text)
        self.assertEqual(audit.status_code, 200, audit.text)
        self.assertFalse(storage.json()["ok"])
        self.assertFalse(audit.json()["ok"])
        self.assertIn("PRJ_MAINTENANCE", audit.json()["missing_project_directories"])
        self.assertTrue(any(item["code"] == "missing_project_directory" for item in audit.json()["critical_issues"]))

    def test_system_data_audit_cannot_be_green_with_unregistered_project_directory(self) -> None:
        orphan = server.DATA_DIR / "projects" / "PRJ_UNREGISTERED"
        orphan.mkdir(parents=True)
        try:
            storage = self.client.get("/api/v2/projects/integrity")
            audit = self.client.get("/api/v2/system/data-audit")
            self.assertFalse(storage.json()["ok"])
            self.assertFalse(audit.json()["ok"])
            self.assertIn("PRJ_UNREGISTERED", audit.json()["unregistered_project_directories"])
            self.assertTrue(any(item["code"] == "unregistered_project_directory" for item in audit.json()["critical_issues"]))
        finally:
            orphan.rmdir()

    def test_project_creation_creates_directory_and_rolls_back_row_when_directory_fails(self) -> None:
        created = self.client.post("/api/v2/projects", json={"name": "Atomic project", "ratio": "16:9", "duration": 15, "generator": "manual", "brief": ""})
        self.assertEqual(created.status_code, 201, created.text)
        created_id = created.json()["document"]["id"]
        self.assertTrue((server.DATA_DIR / "projects" / created_id).is_dir())
        self.assertTrue(self.client.get(f"/api/v2/projects/{created_id}/integrity").json()["ok"])

        database = server.app.state.db
        original_mkdir = Path.mkdir

        def fail_target(path: Path, *args, **kwargs):
            if path.name == "PRJ_ATOMIC_FAIL":
                raise OSError("synthetic mkdir failure")
            return original_mkdir(path, *args, **kwargs)

        failed_doc = project_document("PRJ_ATOMIC_FAIL")
        with mock.patch.object(Path, "mkdir", new=fail_target):
            with self.assertRaises(OSError):
                server._insert_project_with_directory(database, "PRJ_ATOMIC_FAIL", "Atomic fail", failed_doc, 1, utcnow(), utcnow())
        with database.connect() as connection:
            row = connection.execute("SELECT 1 FROM projects WHERE id='PRJ_ATOMIC_FAIL'").fetchone()
        self.assertIsNone(row)
        self.assertFalse((server.DATA_DIR / "projects" / "PRJ_ATOMIC_FAIL").exists())


if __name__ == "__main__":
    unittest.main()
