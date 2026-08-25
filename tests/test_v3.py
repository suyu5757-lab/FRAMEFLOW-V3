from __future__ import annotations

import unittest
import uuid
import time
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import server
import frameflow.database as database_module
from frameflow import asset_audit
from frameflow.database import Database


def project_document() -> dict:
    return {
        "id": "PRJ_V3", "name": "V3 测试", "ratio": "16:9", "duration": 24,
        "generator": "Seedance 2.5", "brief": "测试工作流图", "stage": 0,
        "sortOrder": 0, "script": "", "assets": [], "shots": [], "audio": {},
        "assetRegulator": {}, "generations": [], "seedancePackages": [],
        "providerOverrides": {}, "undoStack": [], "scriptVersions": [],
        "storyboardVersions": [], "storyWorkflowRuns": [],
    }


class FrameflowV3Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.db_path = Path(__file__).parent / f"test-v3-{uuid.uuid4().hex}.db"
        self.db_patch = mock.patch.object(server, "DB_PATH", self.db_path)
        self.db_patch.start()
        self.secret_patch = mock.patch.object(server, "get_secret", return_value=None)
        self.secret_patch.start()
        self.client_context = TestClient(server.app)
        self.client = self.client_context.__enter__()
        response = self.client.put("/api/v2/projects/PRJ_V3", json={"document": project_document()})
        self.assertEqual(response.status_code, 200, response.text)

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        self.secret_patch.stop()
        self.db_patch.stop()
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.db_path) + suffix)
            if candidate.is_file():
                candidate.unlink()

    def test_graph_is_projected_and_revision_conflicts_are_rejected(self) -> None:
        first = self.client.get("/api/v2/projects/PRJ_V3/graph")
        self.assertEqual(first.status_code, 200, first.text)
        payload = first.json()
        self.assertEqual(payload["revision"], 1)
        self.assertEqual(len(payload["graph"]["nodes"]), 8)
        payload["graph"]["nodes"][0]["label"] = "新版故事"
        saved = self.client.put("/api/v2/projects/PRJ_V3/graph", json={"graph": payload["graph"], "expected_revision": 1})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["revision"], 2)
        conflict = self.client.put("/api/v2/projects/PRJ_V3/graph", json={"graph": payload["graph"], "expected_revision": 1})
        self.assertEqual(conflict.status_code, 409)

    def test_execution_cycle_is_rejected_but_reference_cycle_is_allowed(self) -> None:
        payload = self.client.get("/api/v2/projects/PRJ_V3/graph").json()
        graph = payload["graph"]
        graph["edges"].append({"id": "cycle", "source": "delivery", "target": "story", "relation": "execution"})
        response = self.client.put("/api/v2/projects/PRJ_V3/graph", json={"graph": graph, "expected_revision": 1})
        self.assertEqual(response.status_code, 422)
        graph["edges"][-1]["relation"] = "reference"
        response = self.client.put("/api/v2/projects/PRJ_V3/graph", json={"graph": graph, "expected_revision": 1})
        self.assertEqual(response.status_code, 200, response.text)

    def test_graph_groups_are_persisted_and_group_cycles_are_rejected(self) -> None:
        payload = self.client.get("/api/v2/projects/PRJ_V3/graph").json()
        graph = payload["graph"]
        graph["nodes"].append({
            "id": "group:preflight", "kind": "group", "label": "前期", "position": {"x": 0, "y": 0},
            "config": {"width": 460, "height": 280, "collapsed": True}, "inputs": [], "outputs": [],
            "status": "idle", "version": 1, "locked": False,
        })
        graph["nodes"][0]["config"]["group_id"] = "group:preflight"
        saved = self.client.put("/api/v2/projects/PRJ_V3/graph", json={"graph": graph, "expected_revision": 1})
        self.assertEqual(saved.status_code, 200, saved.text)
        persisted = self.client.get("/api/v2/projects/PRJ_V3/graph").json()["graph"]
        self.assertTrue(persisted["nodes"][-1]["config"]["collapsed"])
        self.assertEqual(persisted["nodes"][0]["config"]["group_id"], "group:preflight")

        persisted["nodes"].append({
            "id": "group:second", "kind": "group", "label": "二级", "position": {"x": 0, "y": 0},
            "config": {"group_id": "group:preflight"}, "inputs": [], "outputs": [],
            "status": "idle", "version": 1, "locked": False,
        })
        persisted["nodes"][-2]["config"]["group_id"] = "group:second"
        cycle = self.client.put("/api/v2/projects/PRJ_V3/graph", json={"graph": persisted, "expected_revision": 2})
        self.assertEqual(cycle.status_code, 422, cycle.text)

    def test_approval_estimate_contains_generation_parameters_and_run_snapshot_selection(self) -> None:
        payload = self.client.get("/api/v2/projects/PRJ_V3/graph").json()
        graph = payload["graph"]
        generate = next(node for node in graph["nodes"] if node["id"] == "generate")
        generate["config"].update({
            "provider_profile_id": "ark-default", "model": "seedance-2.5", "quantity": 2,
            "resolution": "1080p", "duration": 8, "seed": 42, "prompt_version": "PROMPT_v3",
            "estimated_cost": 1.25,
        })
        saved = self.client.put("/api/v2/projects/PRJ_V3/graph", json={"graph": graph, "expected_revision": 1})
        self.assertEqual(saved.status_code, 200, saved.text)
        estimate = self.client.post("/api/v2/runs/estimate", json={"project_id": "PRJ_V3", "node_ids": ["delivery"]})
        self.assertEqual(estimate.status_code, 200, estimate.text)
        paid = estimate.json()["estimate"]["paid_nodes"][0]
        self.assertEqual(paid["model"], "seedance-2.5")
        self.assertEqual(paid["quantity"], 2)
        self.assertEqual(paid["resolution"], "1080p")
        self.assertEqual(paid["duration"], 8)
        self.assertEqual(paid["seed"], 42)
        self.assertEqual(paid["prompt_version"], "PROMPT_v3")
        created = self.client.post("/api/v2/runs", json={"project_id": "PRJ_V3", "node_ids": ["delivery"]})
        self.assertEqual(created.status_code, 200, created.text)
        detail = self.client.get(f"/api/v2/runs/{created.json()['id']}").json()
        self.assertEqual(detail["request"]["selected_node_ids"], [node["id"] for node in graph["nodes"]])
        self.assertTrue(detail["request"]["approval_required"])

    def test_paid_graph_run_requires_approval(self) -> None:
        response = self.client.post("/api/v2/runs", json={"project_id": "PRJ_V3", "node_ids": ["generate"]})
        self.assertEqual(response.status_code, 200, response.text)
        run = response.json()
        self.assertEqual(run["status"], "awaiting_confirmation")
        detail = self.client.get(f"/api/v2/runs/{run['id']}").json()
        self.assertEqual(detail["approval_gates"][0]["status"], "pending")
        approved = self.client.post(f"/api/v2/runs/{run['id']}/approve", json={"detail": {"approved_by": "test"}})
        self.assertEqual(approved.status_code, 200, approved.text)
        self.assertEqual(approved.json()["status"], "queued")
        repeated = self.client.post(f"/api/v2/runs/{run['id']}/approve", json={"detail": {"approved_by": "test-again"}})
        self.assertEqual(repeated.status_code, 409, repeated.text)
        with server.app.state.db.connect() as connection:
            gate = connection.execute("SELECT status,approval_consumed_at FROM approval_gates_v3 WHERE run_id=?", (run["id"],)).fetchone()
        self.assertEqual(gate["status"], "approved")
        self.assertIsNotNone(gate["approval_consumed_at"])

    def test_concurrent_generate_times_ten_returns_one_run_and_one_approval_gate(self) -> None:
        body = {"project_id": "PRJ_V3", "node_ids": ["generate"], "max_parallel": 3, "confirmed": False}

        def submit(_: int):
            return self.client.post("/api/v2/runs", json=body)

        with ThreadPoolExecutor(max_workers=10) as pool:
            responses = list(pool.map(submit, range(10)))
        self.assertTrue(all(response.status_code == 200 for response in responses), [response.text for response in responses])
        payloads = [response.json() for response in responses]
        run_ids = {payload["id"] for payload in payloads}
        self.assertEqual(len(run_ids), 1, payloads)
        self.assertEqual(sum(payload["idempotent_replay"] is False for payload in payloads), 1)
        run_id = next(iter(run_ids))
        with server.app.state.db.connect() as connection:
            run_count = connection.execute("SELECT COUNT(*) FROM workflow_runs_v3 WHERE id=?", (run_id,)).fetchone()[0]
            gate_count = connection.execute("SELECT COUNT(*) FROM approval_gates_v3 WHERE run_id=?", (run_id,)).fetchone()[0]
            node_count = connection.execute("SELECT COUNT(*) FROM node_runs_v3 WHERE run_id=?", (run_id,)).fetchone()[0]
        self.assertEqual(run_count, 1)
        self.assertEqual(gate_count, 1)
        self.assertEqual(node_count, 7)

    def test_partial_run_includes_execution_ancestors_in_estimate_and_snapshot(self) -> None:
        estimate = self.client.post("/api/v2/runs/estimate", json={
            "project_id": "PRJ_V3", "node_ids": ["delivery"],
        })
        self.assertEqual(estimate.status_code, 200, estimate.text)
        self.assertEqual(estimate.json()["estimate"]["node_count"], 8)
        self.assertEqual(estimate.json()["estimate"]["paid_node_count"], 1)
        created = self.client.post("/api/v2/runs", json={
            "project_id": "PRJ_V3", "node_ids": ["delivery"],
        })
        self.assertEqual(created.status_code, 200, created.text)
        detail = self.client.get(f"/api/v2/runs/{created.json()['id']}")
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertEqual(len(detail.json()["nodes"]), 8)

    def test_runtime_executes_checkpoints_reuses_cache_and_emits_events(self) -> None:
        first = self.client.post("/api/v2/runs", json={"project_id": "PRJ_V3", "node_ids": ["story"]})
        self.assertEqual(first.status_code, 200, first.text)
        first_id = first.json()["id"]
        for _ in range(50):
            detail = self.client.get(f"/api/v2/runs/{first_id}").json()
            if detail["status"] == "succeeded":
                break
            time.sleep(0.02)
        self.assertEqual(detail["status"], "succeeded")
        self.assertEqual(detail["nodes"][0]["status"], "succeeded")

        second = self.client.post("/api/v2/runs", json={"project_id": "PRJ_V3", "node_ids": ["story"]})
        self.assertEqual(second.status_code, 200, second.text)
        second_id = second.json()["id"]
        for _ in range(50):
            cached = self.client.get(f"/api/v2/runs/{second_id}").json()
            if cached["status"] == "succeeded":
                break
            time.sleep(0.02)
        self.assertEqual(cached["status"], "succeeded")
        self.assertEqual(cached["nodes"][0]["status"], "cached")
        events = self.client.get(f"/api/v2/runs/{second_id}/events")
        self.assertEqual(events.status_code, 200, events.text)
        self.assertIn("node_cached", events.text)

        graph = self.client.get("/api/v2/projects/PRJ_V3/graph").json()
        graph["graph"]["nodes"][0]["config"]["cache_marker"] = "changed-upstream"
        changed = self.client.put("/api/v2/projects/PRJ_V3/graph", json={"graph": graph["graph"], "expected_revision": graph["revision"]})
        self.assertEqual(changed.status_code, 200, changed.text)
        third = self.client.post("/api/v2/runs", json={"project_id": "PRJ_V3", "node_ids": ["story"]})
        self.assertEqual(third.status_code, 200, third.text)
        third_id = third.json()["id"]
        for _ in range(50):
            invalidated = self.client.get(f"/api/v2/runs/{third_id}").json()
            if invalidated["status"] == "succeeded":
                break
            time.sleep(0.02)
        self.assertEqual(invalidated["status"], "succeeded")
        self.assertEqual(invalidated["nodes"][0]["status"], "succeeded")

    def test_runtime_retries_retryable_node_and_classifies_final_failure(self) -> None:
        graph_response = self.client.get("/api/v2/projects/PRJ_V3/graph")
        self.assertEqual(graph_response.status_code, 200, graph_response.text)
        graph = graph_response.json()["graph"]
        graph["nodes"][0]["config"] = {
            "executor": "fail", "max_attempts": 2, "error_kind": "rate_limit", "retryable": True,
        }
        saved = self.client.put("/api/v2/projects/PRJ_V3/graph", json={"graph": graph, "expected_revision": 1})
        self.assertEqual(saved.status_code, 200, saved.text)
        created = self.client.post("/api/v2/runs", json={"project_id": "PRJ_V3", "node_ids": ["story"]})
        self.assertEqual(created.status_code, 200, created.text)
        run_id = created.json()["id"]
        for _ in range(50):
            detail = self.client.get(f"/api/v2/runs/{run_id}").json()
            if detail["status"] == "failed":
                break
            time.sleep(0.02)
        self.assertEqual(detail["status"], "failed")
        self.assertEqual(detail["nodes"][0]["attempt"], 2)
        self.assertEqual(detail["nodes"][0]["error"]["kind"], "rate_limit")
        events = self.client.get(f"/api/v2/runs/{run_id}/events")
        self.assertIn("node_retry_scheduled", events.text)

    def test_timeline_defaults_and_uses_optimistic_revision(self) -> None:
        first = self.client.get("/api/v2/projects/PRJ_V3/timeline").json()
        self.assertEqual((first["document"]["width"], first["document"]["height"]), (1920, 1080))
        first["document"]["duration"] = 30
        saved = self.client.put("/api/v2/projects/PRJ_V3/timeline", json={"document": first["document"], "expected_revision": 1})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["revision"], 2)
        conflict = self.client.put("/api/v2/projects/PRJ_V3/timeline", json={"document": first["document"], "expected_revision": 1})
        self.assertEqual(conflict.status_code, 409)

    def test_story_document_is_structured_revisioned_and_checked(self) -> None:
        first = self.client.get("/api/v2/projects/PRJ_V3/story")
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["story"]["script"], "")
        saved = self.client.put("/api/v2/projects/PRJ_V3/story", json={
            "expected_revision": 1,
            "spec": {
                "creative_goal": "一个人在雨夜找回录音带",
                "audience": "短片观众",
                "platform": "抖音",
                "duration": 12,
                "ratio": "16:9",
                "language": "中文",
                "brand_requirements": ["保留品牌色"],
                "must_preserve": ["录音带"],
                "must_avoid": ["血腥"],
                "structure": [{"id": "S01", "label": "建立悬念"}],
                "beats": [{"id": "B01", "label": "按下播放键"}],
            },
            "script": "雨声里，他按下播放键。",
            "scenes": [{"id": "SC01", "name": "雨夜街口"}],
            "shots": [{
                "id": "SH01", "scene": "SC01", "duration": 6, "purpose": "建立悬念",
                "size": "近景", "camera": "固定", "action": "按下录音带播放键",
                "composition": "中心构图", "performance": "迟疑后坚定", "dialogue": "",
                "narration": "", "lighting": "路灯", "color": "冷蓝", "style": "写实",
                "firstFrame": "手握录音带", "lastFrame": "磁带转动", "sound": "雨声",
                "continuity": "保持右手持物", "status": "ready",
            }],
        })
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["revision"], 2)
        self.assertTrue(saved.json()["checks"]["ok"])
        self.assertEqual(saved.json()["story"]["spec"]["beats"][0]["id"], "B01")
        versions = self.client.get("/api/v2/projects/PRJ_V3/story/versions")
        self.assertEqual(versions.status_code, 200, versions.text)
        self.assertEqual(versions.json()["scriptVersions"][-1]["status"], "active")
        conflict = self.client.put("/api/v2/projects/PRJ_V3/story", json={
            "expected_revision": 1,
            "spec": {"creative_goal": "冲突", "duration": 12, "ratio": "16:9"},
            "script": "冲突", "scenes": [], "shots": [],
        })
        self.assertEqual(conflict.status_code, 409)

    def test_story_diff_and_rollback_create_new_versions_without_overwriting_history(self) -> None:
        shot = {"id": "SH01", "scene": "SC01", "duration": 4, "purpose": "建立", "size": "近景", "camera": "固定", "action": "按键"}
        base = {"expected_revision": 1, "spec": {"creative_goal": "测试", "duration": 4, "ratio": "16:9"}, "script": "第一版", "scenes": [{"id": "SC01", "name": "室内"}], "shots": [shot]}
        first = self.client.put("/api/v2/projects/PRJ_V3/story", json=base)
        self.assertEqual(first.status_code, 200, first.text)
        first_id = first.json()["story"]["script_versions"][-1]["id"]
        second = self.client.put("/api/v2/projects/PRJ_V3/story", json={**base, "expected_revision": 2, "script": "第二版\n新增转折"})
        self.assertEqual(second.status_code, 200, second.text)
        second_id = second.json()["story"]["script_versions"][-1]["id"]
        diff = self.client.get(f"/api/v2/projects/PRJ_V3/story/diff?from_version_id={first_id}&to_version_id={second_id}")
        self.assertEqual(diff.status_code, 200, diff.text)
        self.assertTrue(any(item["type"] == "add" for item in diff.json()["script_diff"]))
        rolled = self.client.post("/api/v2/projects/PRJ_V3/story/rollback", json={"expected_revision": 3, "version_id": first_id, "scope": "script"})
        self.assertEqual(rolled.status_code, 200, rolled.text)
        self.assertEqual(rolled.json()["story"]["script"], "第一版")
        self.assertEqual(rolled.json()["story"]["script_versions"][-1]["source"], "rollback")

    def test_story_checks_cover_generator_limits_and_cross_shot_continuity(self) -> None:
        body = {
            "expected_revision": 1,
            "spec": {"creative_goal": "连续性测试", "duration": 32, "ratio": "16:9"},
            "script": "测试",
            "scenes": [{"id": "SC01", "name": "同一场次"}],
            "shots": [
                {"id": "SH01", "scene": "SC01", "duration": 16, "purpose": "建立", "size": "中景", "camera": "固定", "action": "站立", "lastFrame": "门关闭", "wardrobe": "黑色", "generator": "Seedance 2.0"},
                {"id": "SH02", "scene": "SC01", "duration": 16, "purpose": "反应", "size": "近景", "camera": "固定", "action": "回头", "firstFrame": "门打开", "wardrobe": "白色", "generator": "Seedance 2.0"},
            ],
        }
        response = self.client.put("/api/v2/projects/PRJ_V3/story", json=body)
        self.assertEqual(response.status_code, 200, response.text)
        checks = response.json()["checks"]
        self.assertTrue(any(issue["code"] == "generator_duration_limit" for issue in checks["issues"]))
        self.assertTrue(any(issue["code"] in {"state_continuity", "frame_continuity"} for issue in checks["issues"]))

    def test_partial_storyboard_acceptance_preserves_unselected_existing_shots(self) -> None:
        base_shots = [
            {"id": "SH01", "scene": "SC01", "duration": 4, "purpose": "原镜头一", "size": "近景", "camera": "固定", "action": "按键"},
            {"id": "SH02", "scene": "SC01", "duration": 4, "purpose": "保留镜头", "size": "中景", "camera": "推进", "action": "回头"},
        ]
        saved = self.client.put("/api/v2/projects/PRJ_V3/story", json={"expected_revision": 1, "spec": {"creative_goal": "局部接受", "duration": 8, "ratio": "16:9"}, "script": "原剧本", "scenes": [{"id": "SC01", "name": "室内"}], "shots": base_shots})
        self.assertEqual(saved.status_code, 200, saved.text)
        created = self.client.post("/api/v2/projects/PRJ_V3/story/runs", json={"goal": "full", "strength": "balanced"})
        self.assertEqual(created.status_code, 200, created.text)
        run_id = created.json()["id"]
        candidate = {"proposedScript": "候选剧本", "feasibility": {"verdict": "可执行", "difficulty": "low"}, "productionElements": {}, "scenes": [{"id": "SC01", "name": "室内"}], "shots": [
            {"id": "SH01", "scene": "SC01", "duration": 5, "purpose": "更新镜头一", "size": "特写", "camera": "固定", "action": "按键"},
            {"id": "SH03", "scene": "SC01", "duration": 3, "purpose": "新镜头", "size": "全景", "camera": "拉远", "action": "离开"},
        ], "risks": [], "assetHandoff": {"characters": [], "scenes": [], "props": []}}
        with mock.patch.object(server, "_run_storyboard_agent", new=mock.AsyncMock(return_value=candidate)), mock.patch.object(server, "_run_regulator_agent", new=mock.AsyncMock(return_value={"assetExtraction": [], "assetRequirements": [], "nextActions": []})):
            started = self.client.post(f"/api/v2/story-runs/{run_id}/start")
            self.assertEqual(started.status_code, 200, started.text)
            accepted = self.client.post(f"/api/v2/story-runs/{run_id}/accept-storyboard", json={"scope": "shots_only", "shot_ids": ["SH01"]})
            self.assertEqual(accepted.status_code, 200, accepted.text)
        current = self.client.get("/api/v2/projects/PRJ_V3").json()["document"]
        current_by_id = {shot["id"]: shot for shot in current["shots"]}
        self.assertEqual(current_by_id["SH01"]["purpose"], "更新镜头一")
        self.assertIn("SH02", current_by_id)
        self.assertNotIn("SH03", current_by_id)

    def test_story_candidate_requires_acceptance_before_active_script_changes(self) -> None:
        created = self.client.post("/api/v2/projects/PRJ_V3/story/runs", json={
            "goal": "full", "strength": "balanced", "audience": "短片观众", "platform": "短视频",
        })
        self.assertEqual(created.status_code, 200, created.text)
        run_id = created.json()["id"]
        storyboard = {
            "sourceScriptVersionId": created.json().get("source_script_version_id"),
            "proposedScript": "候选剧本：他按下播放键。",
            "feasibility": {"verdict": "可执行", "difficulty": "low"},
            "productionElements": {},
            "scenes": [{"id": "SC01", "name": "雨夜"}],
            "shots": [{"id": "SH01", "scene": "SC01", "duration": 5, "purpose": "悬念", "size": "近景", "camera": "固定", "action": "按键"}],
            "risks": [],
            "assetHandoff": {"characters": [], "scenes": [], "props": []},
        }
        regulator = {"assetExtraction": [], "assetRequirements": [], "nextActions": []}
        with mock.patch.object(server, "_run_storyboard_agent", new=mock.AsyncMock(return_value=storyboard)), mock.patch.object(server, "_run_regulator_agent", new=mock.AsyncMock(return_value=regulator)):
            started = self.client.post(f"/api/v2/story-runs/{run_id}/start")
            self.assertEqual(started.status_code, 200, started.text)
            self.assertEqual(started.json()["run"]["status"], "storyboard_review_required")
            before_accept = self.client.get("/api/v2/projects/PRJ_V3").json()["document"]
            self.assertEqual(before_accept["script"], "")
            accepted = self.client.post(f"/api/v2/story-runs/{run_id}/accept-storyboard", json={"scope": "all"})
            self.assertEqual(accepted.status_code, 200, accepted.text)
            self.assertEqual(accepted.json()["run"]["status"], "regulator_review_required")
        finalized = self.client.post(f"/api/v2/story-runs/{run_id}/accept-regulator")
        self.assertEqual(finalized.status_code, 200, finalized.text)
        self.assertEqual(finalized.json()["run"]["status"], "succeeded")
        after_accept = self.client.get("/api/v2/projects/PRJ_V3").json()["document"]
        self.assertEqual(after_accept["script"], "候选剧本：他按下播放键。")
        self.assertTrue(any(version.get("status") == "active" and version.get("source") == "agent" for version in after_accept["scriptVersions"]))

    def test_provider_catalog_never_exposes_credentials(self) -> None:
        response = self.client.get("/api/v2/providers/catalog")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn("credential_ref", response.text)
        self.assertNotIn("api_key", response.text.lower())

    def test_v3_root_is_served_and_old_studio_entry_is_not_runtime_surface(self) -> None:
        root = self.client.get("/")
        self.assertEqual(root.status_code, 200, root.text)
        self.assertIn('id="root"', root.text)
        self.assertEqual(self.client.get("/studio/").status_code, 404)

    def test_custom_template_can_be_created_and_applied_with_revision(self) -> None:
        graph = self.client.get("/api/v2/projects/PRJ_V3/graph").json()["graph"]
        graph["template_id"] = "custom:smoke"
        created = self.client.post("/api/v2/workflow-templates", json={
            "id": "custom:smoke", "name": "测试模板", "description": "模板测试", "category": "test", "graph": graph,
        })
        self.assertEqual(created.status_code, 200, created.text)
        applied = self.client.post("/api/v2/projects/PRJ_V3/apply-template", json={
            "template_id": "custom:smoke", "expected_revision": 1,
        })
        self.assertEqual(applied.status_code, 200, applied.text)
        self.assertEqual(applied.json()["graph"]["template_id"], "custom:smoke")
        conflict = self.client.post("/api/v2/projects/PRJ_V3/apply-template", json={
            "template_id": "custom:smoke", "expected_revision": 1,
        })
        self.assertEqual(conflict.status_code, 409)

    def test_provider_v3_probe_and_route_preview_are_safe(self) -> None:
        with mock.patch.object(server, "probe_profile", new=mock.AsyncMock(return_value={
            "ok": True, "models": ["test-model"], "capabilities": ["orchestrator"], "model_readiness": {},
        })), mock.patch.object(server, "get_profile_secret", return_value="test-secret"):
            probed = self.client.post("/api/v2/providers/openai-default/probe")
        self.assertEqual(probed.status_code, 200, probed.text)
        self.assertNotIn("credential_ref", probed.text)
        preview = self.client.post("/api/v2/providers/route-preview", json={
            "capability": "orchestrator", "provider_profile_id": "openai-default", "model": "test-model",
        })
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertTrue(preview.json()["selected"])
        self.assertNotIn("api_key", preview.text.lower())

    def test_agent_plan_snapshots_context_previews_patch_and_creates_candidates_only_after_apply(self) -> None:
        class FakeAdapter:
            adapter_id = "fake-orchestrator"

            def supports(self, capability):
                return capability == "orchestrator"

            def validate_request(self, capability, request):
                return []

            async def submit(self, capability, request, credential):
                return {"structured": {
                    "reply": "已整理节点编排和剧本候选。",
                    "patch": {
                        "add_nodes": [{
                            "id": "agent-review", "kind": "agent", "label": "连续性检查 Agent",
                            "position": {"x": 900, "y": 180}, "config": {"paid": False},
                            "inputs": ["context"], "outputs": ["patch"], "status": "idle", "version": 1, "locked": False,
                        }],
                        "modify_nodes": [{"node_id": "story", "label": "故事与分镜（Agent 建议）"}],
                        "add_edges": [{"id": "edge:story:agent-review", "source": "story", "target": "agent-review", "source_port": "output", "target_port": "input", "relation": "execution"}],
                        "candidates": [{"kind": "script", "title": "剧本候选 v1", "content": "雨夜里，他按下播放键。"}],
                        "suggested_run_node_ids": ["agent-review"],
                        "actions": ["node_orchestration", "candidate_draft"],
                    },
                    "actions": ["node_orchestration", "candidate_draft"],
                    "next_skill": None,
                    "requires_confirmation": False,
                }}

            def contract(self):
                return {"capabilities": ["orchestrator"]}

        with mock.patch.object(server, "adapter_for_profile", return_value=FakeAdapter()), mock.patch.object(server, "get_profile_secret", return_value="test-secret"):
            created = self.client.post("/api/v2/projects/PRJ_V3/agent/plans", json={
                "project_id": "PRJ_V3", "message": "为故事节点增加连续性检查，并草拟脚本候选。",
                "selected_node_ids": ["story"], "graph_revision": 1, "project_revision": 1,
                "context": {"selected_role": "导演"}, "cost_boundary": {"currency": "USD", "max_cost": 5},
            })
        self.assertEqual(created.status_code, 200, created.text)
        plan = created.json()["plan"]
        self.assertEqual(plan["status"], "awaiting_review")
        self.assertEqual(plan["input_snapshot"]["selected_node_ids"], ["story"])
        self.assertEqual(plan["input_snapshot"]["execution_boundaries"]["agent_never_executes_media"], True)
        self.assertEqual(plan["preview"]["added"]["nodes"][0]["id"], "agent-review")
        self.assertEqual(plan["preview"]["candidates"][0]["kind"], "script")
        self.assertEqual(self.client.get("/api/v2/projects/PRJ_V3").json()["document"]["script"], "")

        applied = self.client.post(f"/api/v2/agent/plans/{plan['id']}/apply", json={
            "expected_project_revision": 1, "expected_graph_revision": 1, "detail": {"approved_by": "test"},
        })
        self.assertEqual(applied.status_code, 200, applied.text)
        self.assertEqual(applied.json()["status"], "applied")
        self.assertEqual(applied.json()["graph_revision"], 2)
        candidates = self.client.get("/api/v2/projects/PRJ_V3/agent/candidates")
        self.assertEqual(candidates.status_code, 200, candidates.text)
        self.assertEqual(candidates.json()["candidates"][0]["status"], "candidate")
        self.assertEqual(self.client.get("/api/v2/projects/PRJ_V3/graph").json()["graph"]["nodes"][-1]["id"], "agent-review")
        again = self.client.post(f"/api/v2/agent/plans/{plan['id']}/apply", json={})
        self.assertEqual(again.status_code, 409)

    def test_agent_patch_preview_rejects_locked_node_and_revision_conflict(self) -> None:
        graph = self.client.get("/api/v2/projects/PRJ_V3/graph").json()
        graph["graph"]["nodes"][0]["locked"] = True
        saved = self.client.put("/api/v2/projects/PRJ_V3/graph", json={"graph": graph["graph"], "expected_revision": 1})
        self.assertEqual(saved.status_code, 200, saved.text)
        preview = self.client.post("/api/v2/agent/patches/preview", json={
            "project_id": "PRJ_V3", "graph_revision": 2, "patch": {"modify_nodes": [{"node_id": "story", "label": "不应修改"}]},
        })
        self.assertEqual(preview.status_code, 422, preview.text)
        conflict = self.client.post("/api/v2/agent/patches/preview", json={
            "project_id": "PRJ_V3", "graph_revision": 1, "patch": {},
        })
        self.assertEqual(conflict.status_code, 409, conflict.text)

    def test_artifact_lineage_is_project_scoped_and_traceable(self) -> None:
        now = server.utcnow()
        with server.app.state.db.connect() as connection:
            for artifact_id in ("ART_PARENT", "ART_CHILD"):
                connection.execute(
                    "INSERT INTO artifacts(id,project_id,artifact_type,local_path,sha256,created_at) VALUES(?,?,?,?,?,?)",
                    (artifact_id, "PRJ_V3", "image", f"{artifact_id}.png", artifact_id, now),
                )
        created = self.client.post("/api/v2/artifacts/ART_CHILD/lineage", json={
            "parent_artifact_id": "ART_PARENT", "relation": "reference", "node_id": "story",
        })
        self.assertEqual(created.status_code, 200, created.text)
        lineage = self.client.get("/api/v2/artifacts/ART_CHILD/lineage")
        self.assertEqual(lineage.status_code, 200, lineage.text)
        self.assertEqual(lineage.json()["parents"][0]["parent_artifact_id"], "ART_PARENT")


class FrameflowMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db_path = Path(__file__).parent / f"test-migration-{uuid.uuid4().hex}.db"

    def tearDown(self) -> None:
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.db_path) + suffix)
            if candidate.is_file():
                candidate.unlink()

    def test_v3_migration_is_idempotent_and_rollback_keeps_project_json(self) -> None:
        first = Database(self.db_path)
        document = {"id": "KEEP", "name": "迁移保留", "unknown_field": {"safe": True}}
        with first.connect() as connection:
            now = server.utcnow()
            connection.execute(
                "INSERT INTO projects(id,name,document_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                ("KEEP", document["name"], first.encode(document), 1, now, now),
            )
            versions = [row[0] for row in connection.execute("SELECT version FROM schema_migrations ORDER BY version")]
        self.assertEqual(versions, list(range(1, database_module.SCHEMA_VERSION + 1)))
        first.rollback_to(1)
        with first.connect() as connection:
            self.assertEqual(connection.execute("SELECT document_json FROM projects WHERE id='KEEP'").fetchone()[0], first.encode(document))
            self.assertEqual([row[0] for row in connection.execute("SELECT version FROM schema_migrations ORDER BY version")], [1])
        reopened = Database(self.db_path)
        with reopened.connect() as connection:
            self.assertEqual(connection.execute("SELECT json_extract(document_json, '$.unknown_field.safe') FROM projects WHERE id='KEEP'").fetchone()[0], 1)
            self.assertEqual([row[0] for row in connection.execute("SELECT version FROM schema_migrations ORDER BY version")], list(range(1, database_module.SCHEMA_VERSION + 1)))

    def test_existing_v1_project_is_upgraded_without_changing_document_or_media_metadata(self) -> None:
        now = server.utcnow()
        connection = sqlite3.connect(self.db_path)
        try:
            connection.executescript(database_module.MIGRATIONS[1]["up"])
            connection.execute(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
            )
            connection.execute("INSERT INTO schema_migrations(version, applied_at) VALUES(1, ?)", (now,))
            document = {"id": "V1", "name": "旧项目", "shots": [{"id": "S1"}], "unknown": {"kept": True}}
            connection.execute(
                "INSERT INTO projects(id,name,document_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                ("V1", document["name"], Database.encode(document), 7, now, now),
            )
            connection.execute(
                "INSERT INTO artifacts(id,project_id,artifact_type,local_path,sha256,created_at) VALUES(?,?,?,?,?,?)",
                ("ART_V1", "V1", "image", "projects/V1/hero.png", "hash-v1", now),
            )
            connection.commit()
        finally:
            connection.close()

        upgraded = Database(self.db_path)
        with upgraded.connect() as connection:
            self.assertEqual(connection.execute("SELECT document_json FROM projects WHERE id='V1'").fetchone()[0], Database.encode(document))
            self.assertEqual(connection.execute("SELECT revision FROM projects WHERE id='V1'").fetchone()[0], 7)
            self.assertEqual(tuple(connection.execute("SELECT local_path, sha256 FROM artifacts WHERE id='ART_V1'").fetchone()), ("projects/V1/hero.png", "hash-v1"))
            self.assertEqual([row[0] for row in connection.execute("SELECT version FROM schema_migrations ORDER BY version")], list(range(1, database_module.SCHEMA_VERSION + 1)))
            self.assertIsNotNone(connection.execute("SELECT logical_asset_id FROM artifacts WHERE id='ART_V1'").fetchone())

    def test_v9_prompt_authority_migration_supersedes_older_duplicate_and_adds_snapshot_table(self) -> None:
        database = Database(self.db_path)
        database.rollback_to(8)
        now = server.utcnow()
        document = {"id": "PROMPT_MIG", "name": "Prompt migration", "assets": [{"id": "ASSET_1"}]}
        with database.connect() as connection:
            connection.execute(
                "INSERT INTO projects(id,name,document_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                ("PROMPT_MIG", document["name"], database.encode(document), 1, now, now),
            )
            for prompt_id, version in (("PROMPT_OLD", 1), ("PROMPT_NEW", 2)):
                connection.execute(
                    "INSERT INTO prompt_versions(id,project_id,logical_asset_id,asset_class,version,prompt,source,status,rebuilt_from_failure_ids,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (prompt_id, "PROMPT_MIG", "ASSET_1", "character", version, f"Prompt {version}", "test", "prompt_qa_approved", "[]", now),
                )
        migrated = Database(self.db_path)
        with migrated.connect() as connection:
            rows = connection.execute("SELECT id,status FROM prompt_versions ORDER BY version").fetchall()
            self.assertEqual([(row["id"], row["status"]) for row in rows], [("PROMPT_OLD", "superseded"), ("PROMPT_NEW", "prompt_qa_approved")])
            self.assertIsNotNone(connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='generation_snapshots_v9'").fetchone())
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM schema_migrations WHERE version=9").fetchone()[0], 1)
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("UPDATE prompt_versions SET status='prompt_qa_approved' WHERE id='PROMPT_OLD'")

    def test_v13_library_projection_indexes_are_used_for_project_reads(self) -> None:
        database = Database(self.db_path)
        database.rollback_to(12)
        migrated = Database(self.db_path)
        with migrated.connect() as connection:
            plans = {
                "artifacts": [row[3] for row in connection.execute("EXPLAIN QUERY PLAN SELECT * FROM artifacts WHERE project_id=? ORDER BY created_at DESC", ("P",))],
                "versions": [row[3] for row in connection.execute("EXPLAIN QUERY PLAN SELECT * FROM asset_versions WHERE project_id=? ORDER BY version DESC", ("P",))],
                "prompts": [row[3] for row in connection.execute("EXPLAIN QUERY PLAN SELECT * FROM prompt_versions WHERE project_id=? ORDER BY logical_asset_id,version DESC,id DESC", ("P",))],
            }
        self.assertTrue(all(any("USING INDEX" in detail for detail in plan) for plan in plans.values()), plans)
        self.assertTrue(all(not any("USE TEMP B-TREE" in detail for detail in plan) for plan in plans.values()), plans)

    def test_v15_foreign_keys_preserve_legacy_prompt_label_and_bind_new_canonical_id(self) -> None:
        database = Database(self.db_path)
        database.rollback_to(14)
        now = server.utcnow()
        with database.connect() as connection:
            connection.execute("INSERT INTO projects(id,name,document_json,revision,created_at,updated_at,lifecycle_status) VALUES(?,?,?,?,?,?,?)", ("FK_PROJECT", "FK", database.encode({"id": "FK_PROJECT", "assets": [{"id": "AST_FK"}]}), 1, now, now, "active"))
            connection.execute("INSERT INTO artifacts(id,project_id,artifact_type,local_path,sha256,created_at) VALUES(?,?,?,?,?,?)", ("ART_FK", "FK_PROJECT", "image", "projects/FK_PROJECT/a.png", "f" * 64, now))
            connection.execute("INSERT INTO asset_qa_runs(id,project_id,artifact_id,logical_asset_id,qa_owner,qa_type,status,decision,created_at) VALUES(?,?,?,?,?,?,?,?,?)", ("QA_FK", "FK_PROJECT", "ART_FK", "AST_FK", "test", "image", "completed", "Approved", now))
            connection.execute("INSERT INTO prompt_versions(id,project_id,logical_asset_id,asset_class,version,prompt,source,status,source_qa_run_id,rebuilt_from_failure_ids,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", ("PROMPT_FK", "FK_PROJECT", "AST_FK", "character", 1, "canonical", "test", "prompt_qa_approved", "QA_FK", "[]", now))
            connection.execute("INSERT INTO asset_versions(id,project_id,logical_asset_id,asset_class,version,artifact_id,prompt_version,status,is_active,registration_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", ("AV_LEGACY", "FK_PROJECT", "AST_FK", "character", 1, "ART_FK", "v01", "active", 1, "{}", now))
        migrated = Database(self.db_path)
        with migrated.connect() as connection:
            legacy = connection.execute("SELECT prompt_version,prompt_version_id FROM asset_versions WHERE id='AV_LEGACY'").fetchone()
            self.assertEqual(tuple(legacy), ("v01", None))
            self.assertGreaterEqual(len(connection.execute("PRAGMA foreign_key_list(artifacts)").fetchall()), 1)
            self.assertGreaterEqual(len(connection.execute("PRAGMA foreign_key_list(asset_versions)").fetchall()), 3)
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("INSERT INTO asset_versions(id,project_id,logical_asset_id,asset_class,version,artifact_id,prompt_version,prompt_version_id,status,is_active,registration_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", ("AV_BAD", "FK_PROJECT", "AST_FK", "character", 2, "MISSING_ART", "v02", None, "active", 0, "{}", now))
        created = asset_audit.create_asset_version(migrated, "FK_PROJECT", "AST_FK", "character", "ART_FK", "PROMPT_FK", "candidate", False)
        self.assertEqual(created["prompt_version"], "PROMPT_FK")
        self.assertEqual(created["prompt_version_id"], "PROMPT_FK")

    def test_interrupted_migration_rolls_back_and_can_be_retried(self) -> None:
        now = server.utcnow()
        connection = sqlite3.connect(self.db_path)
        try:
            connection.executescript(database_module.MIGRATIONS[1]["up"])
            connection.execute(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
            )
            connection.execute("INSERT INTO schema_migrations(version, applied_at) VALUES(1, ?)", (now,))
            connection.execute(
                "INSERT INTO projects(id,name,document_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                ("RETRY", "可重试项目", Database.encode({"id": "RETRY", "name": "可重试项目"}), 1, now, now),
            )
            connection.commit()
        finally:
            connection.close()

        broken = {
            "up": "ALTER TABLE artifacts ADD COLUMN transient_test_column TEXT;\nSELECT definitely_missing_function();",
            "down": "",
        }
        with mock.patch.dict(database_module.MIGRATIONS, {2: broken}, clear=False):
            with self.assertRaises(sqlite3.OperationalError):
                Database(self.db_path)

        connection = sqlite3.connect(self.db_path)
        try:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(artifacts)")}
            versions = [row[0] for row in connection.execute("SELECT version FROM schema_migrations ORDER BY version")]
            project_json = connection.execute("SELECT document_json FROM projects WHERE id='RETRY'").fetchone()[0]
        finally:
            connection.close()
        self.assertNotIn("transient_test_column", columns)
        self.assertEqual(versions, [1])
        self.assertEqual(project_json, Database.encode({"id": "RETRY", "name": "可重试项目"}))

        reopened = Database(self.db_path)
        with reopened.connect() as connection:
            self.assertEqual([row[0] for row in connection.execute("SELECT version FROM schema_migrations ORDER BY version")], list(range(1, database_module.SCHEMA_VERSION + 1)))


if __name__ == "__main__":
    unittest.main()
