from __future__ import annotations

import unittest
import uuid
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import server
from frameflow.dashboard import build_dashboard_snapshot


def document(project_id: str, name: str = "Dashboard test") -> dict:
    return {
        "id": project_id,
        "name": name,
        "ratio": "16:9",
        "duration": 30,
        "generator": "Seedance 2.5",
        "brief": "dashboard test",
        "sortOrder": 0,
        "script": "",
        "assets": [],
        "shots": [],
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


class DashboardApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db_path = Path(__file__).parent / f"test-dashboard-{uuid.uuid4().hex}.db"
        self.db_patch = mock.patch.object(server, "DB_PATH", self.db_path)
        self.db_patch.start()
        self.secret_patch = mock.patch.object(server, "get_secret", return_value=None)
        self.secret_patch.start()
        self.client_context = TestClient(server.app)
        self.client = self.client_context.__enter__()
        response = self.client.put("/api/v2/projects/DASH_1", json={"document": document("DASH_1")})
        self.assertEqual(response.status_code, 200, response.text)

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        self.secret_patch.stop()
        self.db_patch.stop()
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.db_path) + suffix)
            if candidate.is_file():
                candidate.unlink()

    def test_empty_project_is_not_started_and_points_to_story(self) -> None:
        response = self.client.get("/api/v2/dashboard?project_id=DASH_1")
        self.assertEqual(response.status_code, 200, response.text)
        selected = response.json()["selected_project"]
        self.assertEqual(selected["project"]["status"], "not_started")
        self.assertEqual(selected["primary_next_task"]["title"], "完成故事与分镜")
        self.assertEqual(selected["primary_next_task"]["route"], "story")
        self.assertLessEqual(len(selected["task_queue"]), 6)
        self.assertEqual(selected["project"]["ratio"], "16:9")

    def test_required_a_asset_is_a_blocker_and_is_targeted(self) -> None:
        changed = document("DASH_1")
        changed["assets"] = [{"id": "CHAR_A", "type": "角色", "grade": "A", "name": "主角"}]
        saved = self.client.put("/api/v2/projects/DASH_1", json={"document": changed, "expected_revision": 1})
        self.assertEqual(saved.status_code, 200, saved.text)
        selected = self.client.get("/api/v2/dashboard?project_id=DASH_1").json()["selected_project"]
        self.assertEqual(selected["project"]["status"], "blocked")
        self.assertEqual(selected["primary_next_task"]["targetId"], "CHAR_A")
        self.assertEqual(selected["primary_next_task"]["status"], "blocked")
        self.assertGreaterEqual(selected["project"]["blocker_count"], 1)

    def test_dashboard_lists_projects_and_does_not_expose_credentials(self) -> None:
        second = self.client.put("/api/v2/projects/DASH_2", json={"document": document("DASH_2", "Second project")})
        self.assertEqual(second.status_code, 200, second.text)
        response = self.client.get("/api/v2/dashboard?project_id=DASH_1")
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual({item["project_id"] for item in payload["projects"]}, {"DASH_1", "DASH_2"})
        self.assertEqual(payload["selected_project"]["project"]["project_id"], "DASH_1")
        self.assertNotIn("api_key", response.text.lower())
        self.assertNotIn("credential", response.text.lower())

    def test_missing_project_is_404(self) -> None:
        response = self.client.get("/api/v2/dashboard?project_id=DOES_NOT_EXIST")
        self.assertEqual(response.status_code, 404)

    def test_pending_paid_run_is_confirmation_not_completion(self) -> None:
        snapshot = build_dashboard_snapshot(document("DASH_1"), latest_run={"id": "RUN_PAID", "status": "awaiting_confirmation"})
        self.assertEqual(snapshot["metrics"]["execution"]["run_status"], "awaiting_confirmation")
        self.assertEqual(snapshot["primary_next_task"]["action"], "confirm_generation")
        self.assertEqual(snapshot["primary_next_task"]["targetId"], "RUN_PAID")
        self.assertNotEqual(snapshot["stages"][-2]["status"], "completed")


if __name__ == "__main__":
    unittest.main()
