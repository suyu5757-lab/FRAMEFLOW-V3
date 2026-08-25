from __future__ import annotations

import asyncio
import hashlib
import json
import unittest
import uuid
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import server


def delivery_project(project_id: str = "PRJ_DELIVERY") -> dict:
    return {
        "id": project_id,
        "name": "V3 交付测试",
        "ratio": "16:9",
        "duration": 12,
        "generator": "V3 local",
        "brief": "多轨时间线测试",
        "stage": 0,
        "sortOrder": 0,
        "script": "",
        "assets": [{
            "id": "ASSET_VIDEO",
            "name": "已批准镜头视频",
            "assetClass": "video",
            "assetRole": "shot_video",
            "grade": "A",
            "required": True,
            "status": "ready",
            "artifactId": "ART_VIDEO",
            "activeVersionId": "AV_ASSET_VIDEO_001",
            "qaDecision": "Approved",
            "regulatorRegistered": True,
        }],
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


class FrameflowV3DeliveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db_path = Path(__file__).parent / f"test-v3-delivery-{uuid.uuid4().hex}.db"
        self.db_patch = mock.patch.object(server, "DB_PATH", self.db_path)
        self.db_patch.start()
        self.secret_patch = mock.patch.object(server, "get_secret", return_value=None)
        self.secret_patch.start()
        self.video_path: Path | None = None
        self.client_context = TestClient(server.app)
        self.client = self.client_context.__enter__()
        self.assertEqual(self.client.put("/api/v2/projects/PRJ_DELIVERY", json={"document": delivery_project()}).status_code, 200)

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        self.secret_patch.stop()
        self.db_patch.stop()
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.db_path) + suffix)
            if candidate.is_file():
                candidate.unlink()
        if self.video_path and self.video_path.is_file():
            self.video_path.unlink()

    def _video_artifact(self, artifact_id: str = "ART_VIDEO") -> Path:
        path = server.DATA_DIR / "projects" / "PRJ_DELIVERY" / "artifacts" / f"{artifact_id}.mp4"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"v3-test-video")
        self.video_path = path
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        with server.app.state.db.connect() as connection:
            connection.execute(
                "INSERT INTO artifacts(id,project_id,artifact_type,local_path,sha256,mime_type,qa_decision,status,created_at,logical_asset_id,asset_class,asset_role,qa_owner) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (artifact_id, "PRJ_DELIVERY", "video", str(path), digest, "video/mp4", "Approved", "ready", server.utcnow(), "ASSET_VIDEO", "video", "shot_video", "video-shot-director"),
            )
            connection.execute(
                "INSERT INTO asset_qa_runs(id,project_id,artifact_id,logical_asset_id,qa_owner,qa_type,status,decision,report_json,finished_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                ("QA_ART_VIDEO", "PRJ_DELIVERY", artifact_id, "ASSET_VIDEO", "video-shot-director", "video", "completed", "Approved", "{}", server.utcnow(), server.utcnow()),
            )
            connection.execute(
                "INSERT INTO asset_versions(id,project_id,logical_asset_id,asset_class,version,artifact_id,status,is_active,registration_json,created_at,approved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                ("AV_ASSET_VIDEO_001", "PRJ_DELIVERY", "ASSET_VIDEO", "video", 1, artifact_id, "active", 1, "{}", server.utcnow(), server.utcnow()),
            )
        return path

    def _ready_shot_timeline(self) -> dict:
        self._video_artifact()
        project = delivery_project()
        project["shots"] = [{"id": "SH001", "status": "approved", "directorApproved": True, "artifactId": "ART_VIDEO", "duration": 4}]
        saved = self.client.put("/api/v2/projects/PRJ_DELIVERY", json={"document": project, "expected_revision": 1})
        self.assertEqual(saved.status_code, 200, saved.text)
        return self.client.get("/api/v2/projects/PRJ_DELIVERY/timeline").json()

    def _assemble(self, timeline: dict):
        return self.client.post(
            "/api/v2/projects/PRJ_DELIVERY/timeline/assemble",
            json={"expected_revision": timeline["revision"]},
        )

    def _assert_gate_conflict(self, response, expected_code: str) -> None:
        self.assertEqual(response.status_code, 409, response.text)
        payload = response.json()
        gate = payload.get("details", {}).get("production_gate", {})
        self.assertEqual(gate.get("code"), expected_code, payload)

    def test_v3_is_root_surface_and_legacy_api_is_retired(self) -> None:
        self.assertEqual(self.client.get("/").status_code, 200)
        self.assertEqual(self.client.get("/studio/").status_code, 404)
        self.assertEqual(self.client.get("/api/v2/projects").status_code, 200)
        retired = self.client.get("/api/projects")
        self.assertEqual(retired.status_code, 410)
        self.assertEqual(retired.json()["code"], "legacy_api_retired")

    def test_timeline_revision_assembly_and_render_approval_snapshot(self) -> None:
        self._video_artifact()
        project = delivery_project()
        project["shots"] = [{"id": "SH001", "status": "approved", "directorApproved": True, "artifactId": "ART_VIDEO", "duration": 4}]
        saved = self.client.put("/api/v2/projects/PRJ_DELIVERY", json={"document": project, "expected_revision": 1})
        self.assertEqual(saved.status_code, 200, saved.text)
        timeline = self.client.get("/api/v2/projects/PRJ_DELIVERY/timeline").json()
        assembled = self.client.post("/api/v2/projects/PRJ_DELIVERY/timeline/assemble", json={"expected_revision": timeline["revision"]})
        self.assertEqual(assembled.status_code, 200, assembled.text)
        self.assertEqual(assembled.json()["assembly"]["added_clips"], 1)
        document = assembled.json()["document"]
        self.assertEqual(document["tracks"][0]["clips"][0]["artifact_id"], "ART_VIDEO")
        estimate = self.client.post("/api/v2/renders/estimate", json={"project_id": "PRJ_DELIVERY", "timeline_revision": assembled.json()["revision"]})
        self.assertEqual(estimate.status_code, 200, estimate.text)
        self.assertEqual(estimate.json()["estimate"]["estimated_cost"], 0)
        created = self.client.post("/api/v2/renders", json={"project_id": "PRJ_DELIVERY", "timeline_revision": assembled.json()["revision"]})
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()["status"], "awaiting_confirmation")
        approved = self.client.post(f"/api/v2/renders/{created.json()['id']}/approve", json={"detail": {"test": True}})
        self.assertEqual(approved.status_code, 200, approved.text)
        self.assertEqual(approved.json()["request"]["confirmed"], True)
        repeated = self.client.post(f"/api/v2/renders/{created.json()['id']}/approve", json={"detail": {"test": "again"}})
        self.assertEqual(repeated.status_code, 409, repeated.text)
        with server.app.state.db.connect() as connection:
            consumed = connection.execute("SELECT approval_consumed_at FROM render_jobs_v6 WHERE id=?", (created.json()["id"],)).fetchone()[0]
        self.assertIsNotNone(consumed)

    def test_repeated_render_create_reuses_one_inflight_job(self) -> None:
        timeline = self._ready_shot_timeline()
        assembled = self._assemble(timeline).json()
        responses = [
            self.client.post("/api/v2/renders", json={"project_id": "PRJ_DELIVERY", "timeline_revision": assembled["revision"]})
            for _ in range(10)
        ]
        self.assertTrue(all(response.status_code == 200 for response in responses), [response.text for response in responses])
        payloads = [response.json() for response in responses]
        self.assertEqual(len({payload["id"] for payload in payloads}), 1)
        self.assertEqual(sum(payload["idempotent_replay"] is False for payload in payloads), 1)
        with server.app.state.db.connect() as connection:
            count = connection.execute("SELECT COUNT(*) FROM render_jobs_v6 WHERE status='awaiting_confirmation'").fetchone()[0]
        self.assertEqual(count, 1)

    def test_timeline_rejects_external_source_paths(self) -> None:
        timeline = self.client.get("/api/v2/projects/PRJ_DELIVERY/timeline").json()
        document = timeline["document"]
        document["tracks"][0]["clips"] = [{"id": "unsafe", "source": "C:/outside.mp4", "start": 0, "duration": 1, "source_in": 0, "speed": 1, "volume": 1, "fade_in": 0, "fade_out": 0, "metadata": {}}]
        saved = self.client.put("/api/v2/projects/PRJ_DELIVERY/timeline", json={"document": document, "expected_revision": timeline["revision"]})
        self.assertEqual(saved.status_code, 200, saved.text)
        estimate = self.client.post("/api/v2/renders/estimate", json={"project_id": "PRJ_DELIVERY"})
        self.assertEqual(estimate.status_code, 422, estimate.text)

    def test_render_output_name_cannot_escape_delivery_directory(self) -> None:
        response = self.client.post("/api/v2/renders/estimate", json={"project_id": "PRJ_DELIVERY", "output_name": "../outside.mp4"})
        self.assertEqual(response.status_code, 422, response.text)

    def test_render_worker_writes_delivery_manifest_and_urls(self) -> None:
        self._video_artifact()
        project = delivery_project()
        project["shots"] = [{"id": "SH001", "status": "approved", "directorApproved": True, "artifactId": "ART_VIDEO", "duration": 4}]
        self.assertEqual(self.client.put("/api/v2/projects/PRJ_DELIVERY", json={"document": project, "expected_revision": 1}).status_code, 200)
        timeline = self.client.get("/api/v2/projects/PRJ_DELIVERY/timeline").json()
        assembled = self.client.post("/api/v2/projects/PRJ_DELIVERY/timeline/assemble", json={"expected_revision": timeline["revision"]}).json()
        created = self.client.post("/api/v2/renders", json={"project_id": "PRJ_DELIVERY", "timeline_revision": assembled["revision"]}).json()

        def fake_render(_: str, __: dict, ___: dict, output: Path) -> None:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(b"fake-mp4")

        with mock.patch.object(server, "render_timeline", side_effect=fake_render), mock.patch.object(server, "find_binary", return_value="ffmpeg"):
            self.assertEqual(self.client.post(f"/api/v2/renders/{created['id']}/approve", json={"detail": {"test": True}}).status_code, 200)
            asyncio.run(server.run_v3_render_task(server.app, created["id"]))
        detail = self.client.get(f"/api/v2/renders/{created['id']}").json()
        self.assertEqual(detail["status"], "succeeded", detail)
        self.assertTrue(detail["result"]["delivery"]["video_url"].startswith("/api/project-files/PRJ_DELIVERY/"))
        self.assertTrue(Path(detail["result"]["manifest"]).is_file())
        self.assertEqual([item["kind"] for item in detail["result"]["delivery"]["outputs"]], ["master_burn_in", "clean", "srt"])
        self.assertTrue(detail["result"]["delivery"]["package_url"].endswith("/delivery.zip"))
        manifest = json.loads(Path(detail["result"]["manifest"]).read_text(encoding="utf-8"))
        self.assertEqual(manifest["timeline_revision"], assembled["revision"])
        self.assertEqual(manifest["delivery"]["package_url"], detail["result"]["delivery"]["package_url"])

    def test_timeline_preflight_exposes_shot_gaps_and_delivery_gate(self) -> None:
        project = delivery_project()
        project["shots"] = [{"id": f"SH{index:03d}", "scene": f"S{(index - 1) // 3 + 1:03d}", "status": "ready", "duration": 3} for index in range(1, 21)]
        self.assertEqual(self.client.put("/api/v2/projects/PRJ_DELIVERY", json={"document": project, "expected_revision": 1}).status_code, 200)
        preflight = self.client.get("/api/v2/projects/PRJ_DELIVERY/timeline/preflight")
        self.assertEqual(preflight.status_code, 200, preflight.text)
        payload = preflight.json()
        self.assertEqual(payload["summary"]["shot_total"], 20)
        self.assertEqual(payload["summary"]["shot_placed"], 0)
        self.assertEqual(payload["summary"]["blocked_shots"], 20)
        self.assertFalse(payload["summary"]["delivery_ready"])
        self.assertEqual(payload["deliverables"]["master_burn_in"], "blocked")
        self.assertEqual(len(payload["tracks"]), 7)
        self.assertTrue(any(item["code"] == "missing_video_artifact" for item in payload["shots"][5]["blockers"]))

    def test_preview_job_is_proxy_optional_and_does_not_register_final_artifact(self) -> None:
        self._video_artifact()
        project = delivery_project()
        project["shots"] = [{"id": "SH001", "status": "approved", "directorApproved": True, "artifactId": "ART_VIDEO", "duration": 4}]
        self.assertEqual(self.client.put("/api/v2/projects/PRJ_DELIVERY", json={"document": project, "expected_revision": 1}).status_code, 200)
        timeline = self.client.get("/api/v2/projects/PRJ_DELIVERY/timeline").json()
        assembled = self.client.post("/api/v2/projects/PRJ_DELIVERY/timeline/assemble", json={"expected_revision": timeline["revision"]}).json()

        def fake_render(_: str, __: dict, ___: dict, output: Path) -> None:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(b"fake-preview")

        with mock.patch.object(server, "render_timeline", side_effect=fake_render), mock.patch.object(server, "find_binary", return_value="ffmpeg"):
            queued = self.client.post(f"/api/v2/projects/PRJ_DELIVERY/timeline/preview", json={"expected_revision": assembled["revision"], "resolution": "960x540", "use_proxies": False})
            self.assertEqual(queued.status_code, 200, queued.text)
            asyncio.run(server.run_v3_render_task(server.app, queued.json()["id"]))
        detail = self.client.get(f"/api/v2/renders/{queued.json()['id']}").json()
        self.assertEqual(detail["status"], "succeeded", detail)
        self.assertTrue(detail["result"]["preview_url"].endswith("/preview.mp4"))
        self.assertNotIn("artifact", detail["result"])
        with server.app.state.db.connect() as connection:
            final_count = connection.execute("SELECT COUNT(*) AS count FROM artifacts WHERE project_id=? AND artifact_type LIKE 'final_video%'", ("PRJ_DELIVERY",)).fetchone()["count"]
        self.assertEqual(final_count, 0)

    def test_pending_artifact_cannot_be_assembled_even_when_shot_is_director_approved(self) -> None:
        timeline = self._ready_shot_timeline()
        with server.app.state.db.connect() as connection:
            connection.execute("UPDATE artifacts SET qa_decision='Pending',status='generated_pending_qa' WHERE id='ART_VIDEO'")
        self._assert_gate_conflict(self._assemble(timeline), "qa_not_approved")

    def test_unregistered_artifact_cannot_be_assembled(self) -> None:
        timeline = self._ready_shot_timeline()
        with server.app.state.db.connect() as connection:
            connection.execute("UPDATE asset_versions SET is_active=0,status='candidate' WHERE id='AV_ASSET_VIDEO_001'")
        self._assert_gate_conflict(self._assemble(timeline), "active_version_ambiguous")

    def test_superseded_artifact_cannot_be_assembled(self) -> None:
        timeline = self._ready_shot_timeline()
        with server.app.state.db.connect() as connection:
            connection.execute(
                "INSERT INTO artifacts(id,project_id,artifact_type,local_path,sha256,mime_type,qa_decision,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                ("ART_REPLACEMENT", "PRJ_DELIVERY", "video", str(self.video_path), hashlib.sha256(self.video_path.read_bytes()).hexdigest(), "video/mp4", "Approved", "ready", server.utcnow()),
            )
            connection.execute("UPDATE asset_versions SET is_active=0,status='superseded' WHERE id='AV_ASSET_VIDEO_001'")
            connection.execute(
                "INSERT INTO asset_versions(id,project_id,logical_asset_id,asset_class,version,artifact_id,status,is_active,registration_json,created_at,approved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                ("AV_ASSET_VIDEO_002", "PRJ_DELIVERY", "ASSET_VIDEO", "video", 2, "ART_REPLACEMENT", "active", 1, "{}", server.utcnow(), server.utcnow()),
            )
        self._assert_gate_conflict(self._assemble(timeline), "artifact_superseded")

    def test_wrong_project_artifact_cannot_be_assembled(self) -> None:
        project = delivery_project()
        project["shots"] = [{"id": "SH001", "status": "approved", "directorApproved": True, "artifactId": "ART_OTHER", "duration": 4}]
        project["assets"][0]["artifactId"] = "ART_OTHER"
        self.assertEqual(self.client.put("/api/v2/projects/PRJ_DELIVERY", json={"document": project, "expected_revision": 1}).status_code, 200)
        with server.app.state.db.connect() as connection:
            now = server.utcnow()
            connection.execute(
                "INSERT INTO projects(id,name,document_json,revision,created_at,updated_at,lifecycle_status) VALUES(?,?,?,?,?,?,?)",
                ("PRJ_OTHER", "Other", server.app.state.db.encode({"id": "PRJ_OTHER", "assets": []}), 1, now, now, "active"),
            )
            connection.execute(
                "INSERT INTO artifacts(id,project_id,artifact_type,local_path,sha256,mime_type,qa_decision,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                ("ART_OTHER", "PRJ_OTHER", "video", "C:/outside/other.mp4", "0" * 64, "video/mp4", "Approved", "ready", server.utcnow()),
            )
        timeline = self.client.get("/api/v2/projects/PRJ_DELIVERY/timeline").json()
        self._assert_gate_conflict(self._assemble(timeline), "wrong_project")

    def test_missing_physical_file_cannot_be_assembled(self) -> None:
        timeline = self._ready_shot_timeline()
        assert self.video_path is not None
        self.video_path.unlink()
        self._assert_gate_conflict(self._assemble(timeline), "file_missing")

    def test_hash_mismatch_cannot_be_assembled(self) -> None:
        timeline = self._ready_shot_timeline()
        assert self.video_path is not None
        self.video_path.write_bytes(b"tampered-video")
        self._assert_gate_conflict(self._assemble(timeline), "hash_mismatch")

    def test_pending_artifact_blocks_preflight_preview_estimate_and_create_including_single(self) -> None:
        timeline = self._ready_shot_timeline()
        assembled = self._assemble(timeline)
        self.assertEqual(assembled.status_code, 200, assembled.text)
        revision = assembled.json()["revision"]
        with server.app.state.db.connect() as connection:
            connection.execute("UPDATE artifacts SET qa_decision='Pending',status='generated_pending_qa' WHERE id='ART_VIDEO'")
        preflight = self.client.get("/api/v2/projects/PRJ_DELIVERY/timeline/preflight")
        self.assertEqual(preflight.status_code, 200, preflight.text)
        self.assertFalse(preflight.json()["summary"]["delivery_ready"])
        self.assertEqual(self.client.post("/api/v2/projects/PRJ_DELIVERY/timeline/preview", json={"expected_revision": revision}).status_code, 409)
        self.assertEqual(self.client.post("/api/v2/renders/estimate", json={"project_id": "PRJ_DELIVERY", "timeline_revision": revision, "delivery_set": "single"}).status_code, 409)
        self.assertEqual(self.client.post("/api/v2/renders", json={"project_id": "PRJ_DELIVERY", "timeline_revision": revision, "delivery_set": "single"}).status_code, 409)

    def test_render_approve_revalidates_production_authority(self) -> None:
        timeline = self._ready_shot_timeline()
        assembled = self._assemble(timeline).json()
        created = self.client.post("/api/v2/renders", json={"project_id": "PRJ_DELIVERY", "timeline_revision": assembled["revision"]})
        self.assertEqual(created.status_code, 200, created.text)
        with server.app.state.db.connect() as connection:
            connection.execute("UPDATE artifacts SET qa_decision='Pending',status='generated_pending_qa' WHERE id='ART_VIDEO'")
        approved = self.client.post(f"/api/v2/renders/{created.json()['id']}/approve", json={"detail": {"test": True}})
        self._assert_gate_conflict(approved, "qa_not_approved")

    def test_worker_start_revalidates_and_does_not_render_invalid_input(self) -> None:
        timeline = self._ready_shot_timeline()
        assembled = self._assemble(timeline).json()
        created = self.client.post("/api/v2/renders", json={"project_id": "PRJ_DELIVERY", "timeline_revision": assembled["revision"]}).json()
        with server.app.state.db.connect() as connection:
            connection.execute("UPDATE render_jobs_v6 SET status='queued' WHERE id=?", (created["id"],))
            connection.execute("UPDATE artifacts SET qa_decision='Pending',status='generated_pending_qa' WHERE id='ART_VIDEO'")
        with mock.patch.object(server, "render_timeline") as render_mock:
            asyncio.run(server.run_v3_render_task(server.app, created["id"]))
        self.assertEqual(render_mock.call_count, 0)
        detail = self.client.get(f"/api/v2/renders/{created['id']}").json()
        self.assertEqual(detail["status"], "failed", detail)

    def test_final_delivery_and_package_revalidate_after_render(self) -> None:
        timeline = self._ready_shot_timeline()
        assembled = self._assemble(timeline).json()
        created = self.client.post(
            "/api/v2/renders",
            json={"project_id": "PRJ_DELIVERY", "timeline_revision": assembled["revision"], "delivery_set": "single"},
        ).json()
        with server.app.state.db.connect() as connection:
            connection.execute("UPDATE render_jobs_v6 SET status='queued' WHERE id=?", (created["id"],))

        def mutate_after_render(_: str, __: dict, ___: dict, output: Path, *____) -> None:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(b"rendered-but-not-delivered")
            with server.app.state.db.connect() as connection:
                connection.execute("UPDATE asset_versions SET is_active=0,status='superseded' WHERE id='AV_ASSET_VIDEO_001'")

        with mock.patch.object(server, "render_timeline", side_effect=mutate_after_render), mock.patch.object(server, "find_binary", return_value="ffmpeg"):
            asyncio.run(server.run_v3_render_task(server.app, created["id"]))
        detail = self.client.get(f"/api/v2/renders/{created['id']}").json()
        self.assertEqual(detail["status"], "failed", detail)
        with server.app.state.db.connect() as connection:
            final_count = connection.execute("SELECT COUNT(*) AS count FROM artifacts WHERE project_id=? AND artifact_type LIKE 'final_video%'", ("PRJ_DELIVERY",)).fetchone()["count"]
        self.assertEqual(final_count, 0)
        delivery_root = server.DATA_DIR / "projects" / "PRJ_DELIVERY" / "deliveries" / created["id"]
        self.assertFalse((delivery_root / "delivery.zip").exists())


if __name__ == "__main__":
    unittest.main()
