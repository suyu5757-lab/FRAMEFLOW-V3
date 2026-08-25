from __future__ import annotations

import hashlib
import unittest
import uuid
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import server


def matrix_project(project_id: str = "PRJ_MATRIX") -> dict:
    return {
        "id": project_id,
        "name": "V3 功能矩阵测试",
        "ratio": "16:9",
        "duration": 12,
        "generator": "V3 local",
        "brief": "全量路由矩阵",
        "stage": 0,
        "sortOrder": 0,
        "script": "",
        "assets": [
            {
                "id": "AST_CHAR",
                "name": "测试角色",
                "assetClass": "character",
                "type": "角色",
                "grade": "A",
                "status": "ready",
                "artifactId": "ART_MATRIX",
                "activeVersionId": "AV_AST_CHAR_001",
                "qaDecision": "Approved",
                "regulatorRegistered": True,
            },
            {
                "id": "FUSION_1",
                "name": "测试融合",
                "assetClass": "fusion",
                "type": "融合资产",
                "grade": "B",
                "status": "missing",
            },
        ],
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


class FrameflowV3FunctionMatrixTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db_path = Path(__file__).parent / f"test-v3-matrix-{uuid.uuid4().hex}.db"
        self.db_patch = mock.patch.object(server, "DB_PATH", self.db_path)
        self.db_patch.start()
        self.secret_patch = mock.patch.object(server, "get_secret", return_value=None)
        self.secret_patch.start()
        self.client_context = TestClient(server.app)
        self.client = self.client_context.__enter__()
        saved = self.client.put("/api/v2/projects/PRJ_MATRIX", json={"document": matrix_project()})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.source_path = server.DATA_DIR / "projects" / "PRJ_MATRIX" / "artifacts" / "source.mp4"
        self.source_path.parent.mkdir(parents=True, exist_ok=True)
        self.source_path.write_bytes(b"matrix-video-source")
        with server.app.state.db.connect() as connection:
            digest = hashlib.sha256(self.source_path.read_bytes()).hexdigest()
            for artifact_id, logical_asset_id, artifact_type, mime_type in (
                ("ART_MATRIX", "AST_CHAR", "video", "video/mp4"),
                ("ART_PARENT", "AST_CHAR", "image", "image/png"),
                ("ART_CHILD", "AST_CHAR", "image", "image/png"),
            ):
                connection.execute(
                    "INSERT INTO artifacts(id,project_id,artifact_type,logical_asset_id,local_path,sha256,mime_type,qa_decision,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (artifact_id, "PRJ_MATRIX", artifact_type, logical_asset_id, str(self.source_path), digest, mime_type, "Approved", "ready" if artifact_id == "ART_MATRIX" else "approved", server.utcnow()),
                )
            connection.execute(
                "INSERT INTO asset_qa_runs(id,project_id,artifact_id,logical_asset_id,qa_owner,qa_type,status,decision,report_json,finished_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                ("QA_ART_MATRIX", "PRJ_MATRIX", "ART_MATRIX", "AST_CHAR", "video-shot-director", "video", "completed", "Approved", "{}", server.utcnow(), server.utcnow()),
            )
            connection.execute(
                "INSERT INTO asset_versions(id,project_id,logical_asset_id,asset_class,version,artifact_id,status,is_active,registration_json,created_at,approved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                ("AV_AST_CHAR_001", "PRJ_MATRIX", "AST_CHAR", "character", 1, "ART_MATRIX", "active", 1, "{}", server.utcnow(), server.utcnow()),
            )

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        self.secret_patch.stop()
        self.db_patch.stop()
        if self.source_path.is_file():
            self.source_path.unlink()
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.db_path) + suffix)
            if candidate.is_file():
                candidate.unlink()

    def test_project_template_health_and_missing_resource_contracts(self) -> None:
        self.assertEqual(self.client.get("/api/v2/projects").status_code, 200)
        self.assertEqual(self.client.get("/api/v2/projects/PRJ_MATRIX").status_code, 200)
        self.assertEqual(self.client.get("/api/v2/workflow-templates").status_code, 200)
        self.assertEqual(self.client.get("/api/v2/providers/catalog").status_code, 200)
        self.assertEqual(self.client.get("/api/health").status_code, 200)
        self.assertEqual(self.client.get("/api/system/doctor").status_code, 200)
        self.assertEqual(self.client.get("/api/project-files/PRJ_MATRIX/artifacts/source.mp4").status_code, 200)
        self.assertEqual(self.client.get("/api/project-files/PRJ_MATRIX/../source.mp4").status_code, 404)
        self.assertEqual(self.client.get("/generated/does-not-exist.bin").status_code, 404)
        self.assertEqual(self.client.get("/not-a-v3-page").status_code, 404)
        self.assertEqual(self.client.get("/api/v2/projects/DOES_NOT_EXIST").status_code, 404)
        self.assertEqual(self.client.get("/api/v2/providers/DOES_NOT_EXIST/contract").status_code, 404)

    def test_run_control_event_stream_and_cancel_contracts(self) -> None:
        created = self.client.post("/api/v2/runs", json={"project_id": "PRJ_MATRIX", "node_ids": ["generate"]})
        self.assertEqual(created.status_code, 200, created.text)
        run_id = created.json()["id"]
        self.assertEqual(self.client.get(f"/api/v2/runs/{run_id}").status_code, 200)
        self.assertEqual(self.client.get(f"/api/v2/runs/{run_id}/events").status_code, 200)
        self.assertEqual(self.client.post(f"/api/v2/runs/{run_id}/cancel").status_code, 200)
        self.assertEqual(self.client.post(f"/api/v2/runs/{run_id}/cancel").status_code, 409)
        self.assertEqual(self.client.get("/api/v2/runs/DOES_NOT_EXIST").status_code, 404)

        queued = self.client.post("/api/v2/runs", json={"project_id": "PRJ_MATRIX", "node_ids": ["story"]})
        self.assertEqual(queued.status_code, 200, queued.text)
        queued_id = queued.json()["id"]
        with server.app.state.db.connect() as connection:
            connection.execute("UPDATE workflow_runs_v3 SET status='queued' WHERE id=?", (queued_id,))
        paused = self.client.post(f"/api/v2/runs/{queued_id}/pause")
        self.assertEqual(paused.status_code, 200, paused.text)
        resumed = self.client.post(f"/api/v2/runs/{queued_id}/resume")
        self.assertEqual(resumed.status_code, 200, resumed.text)

    def test_agent_read_events_reject_and_alias_preview_contracts(self) -> None:
        class FakeAdapter:
            async def submit(self, capability, request, credential):
                return {"structured": {"reply": "矩阵测试", "patch": {}}}

            def supports(self, capability):
                return capability == "orchestrator"

            def validate_request(self, capability, request):
                return []

        with mock.patch.object(server, "adapter_for_profile", return_value=FakeAdapter()), mock.patch.object(server, "get_profile_secret", return_value="test-secret"):
            created = self.client.post("/api/v2/agent/plans", json={"project_id": "PRJ_MATRIX", "message": "读取项目状态"})
        self.assertEqual(created.status_code, 200, created.text)
        plan_id = created.json()["id"]
        self.assertEqual(self.client.get(f"/api/v2/agent/plans/{plan_id}").status_code, 200)
        self.assertEqual(self.client.get(f"/api/v2/agent/plans/{plan_id}/events").status_code, 200)
        self.assertEqual(self.client.get("/api/v2/projects/PRJ_MATRIX/agent/plans").status_code, 200)
        self.assertEqual(self.client.post(f"/api/v2/agent/plans/{plan_id}/reject", json={}).status_code, 200)
        self.assertEqual(self.client.post(f"/api/v2/agent/plans/{plan_id}/apply", json={}).status_code, 409)
        with mock.patch.object(server, "adapter_for_profile", return_value=FakeAdapter()), mock.patch.object(server, "get_profile_secret", return_value="test-secret"):
            second = self.client.post("/api/v2/projects/PRJ_MATRIX/agent/plans", json={"project_id": "PRJ_MATRIX", "message": "批准空补丁"})
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(self.client.post(f"/api/v2/agent/plans/{second.json()['id']}/approve", json={}).status_code, 200)
        preview = self.client.post("/api/v2/projects/PRJ_MATRIX/agent/patches/preview", json={"project_id": "PRJ_MATRIX", "patch": {}})
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertEqual(self.client.get("/api/v2/projects/PRJ_MATRIX/agent/candidates").status_code, 200)

    def test_assets_metadata_comparison_fusion_gate_and_lineage(self) -> None:
        library = self.client.get("/api/v2/projects/PRJ_MATRIX/assets")
        self.assertEqual(library.status_code, 200, library.text)
        self.assertEqual(self.client.get("/api/v2/projects/PRJ_MATRIX/asset-gates").status_code, 200)
        updated = self.client.patch("/api/v2/projects/PRJ_MATRIX/assets/AST_CHAR", json={
            "expected_revision": 1,
            "asset_class": "character",
            "grade": "A",
            "usage_roles": ["identity"],
            "references": [{"reference_id": "ART_PARENT", "reference_kind": "artifact", "artifact_id": "ART_PARENT", "role": "identity"}],
        })
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(self.client.get("/api/v2/projects/PRJ_MATRIX/assets/AST_CHAR/comparisons").status_code, 200)
        comparison = self.client.post("/api/v2/projects/PRJ_MATRIX/assets/AST_CHAR/comparisons", json={
            "comparison_group": "matrix", "strategy": "ab", "candidate_artifact_ids": ["ART_PARENT", "ART_CHILD"],
        })
        self.assertEqual(comparison.status_code, 200, comparison.text)
        comparison_id = comparison.json()["comparison"]["id"]
        reviewed = self.client.post(f"/api/v2/projects/PRJ_MATRIX/assets/AST_CHAR/comparisons/{comparison_id}/review", json={
            "candidate_artifact_id": "ART_PARENT", "score": 88, "decision": "Approved", "comment": "matrix",
        })
        self.assertEqual(reviewed.status_code, 200, reviewed.text)
        gate = self.client.post("/api/v2/projects/PRJ_MATRIX/assets/FUSION_1/fusion-gate")
        self.assertEqual(gate.status_code, 200, gate.text)
        self.assertEqual(gate.json()["status"], "blocked")
        self.assertEqual(self.client.post("/api/v2/projects/PRJ_MATRIX/assets/AST_CHAR/fusion-gate").status_code, 422)
        lineage = self.client.post("/api/v2/artifacts/ART_CHILD/lineage", json={"parent_artifact_id": "ART_PARENT", "relation": "reference"})
        self.assertEqual(lineage.status_code, 200, lineage.text)
        self.assertEqual(self.client.get("/api/v2/artifacts/ART_CHILD/lineage").status_code, 200)
        self.assertEqual(self.client.post("/api/v2/artifacts/ART_CHILD/lineage", json={"parent_artifact_id": "ART_CHILD"}).status_code, 422)

    def test_proxy_render_story_chain_and_legacy_boundary(self) -> None:
        proxy = self.client.post("/api/v2/projects/PRJ_MATRIX/proxies", json={"artifact_id": "ART_MATRIX", "preset": "preview_360p"})
        self.assertEqual(proxy.status_code, 200, proxy.text)
        proxy_id = proxy.json()["id"]
        detail = self.client.get(f"/api/v2/proxies/{proxy_id}")
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertIn(detail.json()["status"], {"queued", "failed", "ready"})

        timeline = {
            "version": 1, "fps": 30, "width": 1920, "height": 1080, "duration": 4,
            "tracks": [{"id": "video-main", "kind": "video", "name": "主视频", "muted": False, "locked": False, "clips": [{
                "id": "clip-1", "artifact_id": "ART_MATRIX", "start": 0, "duration": 2, "source_in": 0,
                "speed": 1, "volume": 1, "fade_in": 0, "fade_out": 0, "metadata": {},
            }]}], "metadata": {},
        }
        saved = self.client.put("/api/v2/projects/PRJ_MATRIX/timeline", json={"document": timeline, "expected_revision": 1})
        self.assertEqual(saved.status_code, 200, saved.text)
        estimate = self.client.post("/api/v2/renders/estimate", json={"project_id": "PRJ_MATRIX", "timeline_revision": saved.json()["revision"]})
        self.assertEqual(estimate.status_code, 200, estimate.text)
        created = self.client.post("/api/v2/renders", json={"project_id": "PRJ_MATRIX", "timeline_revision": saved.json()["revision"]})
        self.assertEqual(created.status_code, 200, created.text)
        render_id = created.json()["id"]
        self.assertEqual(self.client.get(f"/api/v2/renders/{render_id}").status_code, 200)
        self.assertEqual(self.client.post(f"/api/v2/renders/{render_id}/cancel").status_code, 200)
        self.assertEqual(self.client.post(f"/api/v2/renders/{render_id}/cancel").status_code, 409)

        story = self.client.post("/api/v2/projects/PRJ_MATRIX/story/runs", json={"goal": "full"})
        self.assertEqual(story.status_code, 200, story.text)
        story_id = story.json()["id"]
        self.assertEqual(self.client.get("/api/v2/projects/PRJ_MATRIX/story/runs").status_code, 200)
        self.assertEqual(self.client.get(f"/api/v2/story-runs/{story_id}").status_code, 200)
        self.assertEqual(self.client.post(f"/api/v2/story-runs/{story_id}/reject-storyboard").status_code, 200)
        self.assertEqual(self.client.post(f"/api/v2/story-runs/{story_id}/reject-regulator").status_code, 200)
        self.assertEqual(self.client.post(f"/api/v2/story-runs/{story_id}/cancel").status_code, 200)
        for legacy_path in (
            "/api/projects/PRJ_MATRIX",
            "/api/provider-profiles",
            "/api/assets/intake",
            "/api/assets/upload",
            "/api/projects/PRJ_MATRIX/story-optimization-runs",
        ):
            self.assertEqual(self.client.get(legacy_path).status_code, 410, legacy_path)


if __name__ == "__main__":
    unittest.main()
