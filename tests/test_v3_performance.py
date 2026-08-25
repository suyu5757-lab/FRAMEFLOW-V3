from __future__ import annotations

import statistics
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import server


def performance_document() -> dict:
    classes = ("character", "scene", "prop", "fusion")
    assets = [
        {
            "id": f"AST_{index:04d}", "name": f"Performance Asset {index:04d}",
            "assetClass": classes[index % len(classes)], "skill": classes[index % len(classes)],
            "grade": "A" if index % 5 == 0 else "B", "status": "missing", "prompt": "",
        }
        for index in range(1000)
    ]
    shots = [
        {"id": f"SH_{index:03d}", "scene": f"Scene {index % 25}", "duration": 2, "purpose": "performance", "assetRequirements": []}
        for index in range(300)
    ]
    return {"id": "PRJ_PERF", "name": "Performance", "ratio": "16:9", "duration": 600, "generator": "manual", "brief": "performance", "stage": 0, "sortOrder": 0, "script": "benchmark", "assets": assets, "shots": shots, "audio": {}, "assetRegulator": {}, "generations": [], "seedancePackages": [], "providerOverrides": {}, "undoStack": [], "scriptVersions": [], "storyboardVersions": [], "storyWorkflowRuns": []}


class PerformanceV3Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.db_path = Path(__file__).parent / f"test-performance-{uuid.uuid4().hex}.db"
        self.db_patch = mock.patch.object(server, "DB_PATH", self.db_path)
        self.db_patch.start()
        self.context = TestClient(server.app)
        self.client = self.context.__enter__()
        response = self.client.put("/api/v2/projects/PRJ_PERF", json={"document": performance_document()})
        self.assertEqual(response.status_code, 200, response.text)

    def tearDown(self) -> None:
        self.context.__exit__(None, None, None)
        self.db_patch.stop()
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.db_path) + suffix)
            if candidate.is_file():
                candidate.unlink()

    def _p95_ms(self, request_path: str) -> tuple[float, dict]:
        elapsed = []
        payload = {}
        for _ in range(5):
            started = time.perf_counter()
            response = self.client.get(request_path)
            elapsed.append((time.perf_counter() - started) * 1000)
            self.assertEqual(response.status_code, 200, response.text)
            payload = response.json()
        return max(elapsed), payload

    def test_1000_assets_300_shots_library_and_dashboard_p95_are_under_one_second(self) -> None:
        library_p95, library = self._p95_ms("/api/v2/projects/PRJ_PERF/assets?page=1&page_size=100&sort=priority")
        dashboard_p95, dashboard = self._p95_ms("/api/v2/dashboard?project_id=PRJ_PERF")
        self.assertEqual(library["pagination"]["total"], 1000)
        self.assertEqual(len(library["assets"]), 100)
        self.assertEqual(dashboard["selected_project"]["project"]["project_id"], "PRJ_PERF")
        self.assertLess(library_p95, 1000, f"library p95={library_p95:.2f}ms")
        self.assertLess(dashboard_p95, 1000, f"dashboard p95={dashboard_p95:.2f}ms")


if __name__ == "__main__":
    unittest.main()
