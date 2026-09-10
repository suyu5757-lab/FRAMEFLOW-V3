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
from frameflow.providers import STORYBOARD_OUTPUT_SCHEMA


def project_document() -> dict:
    return {
        "id": "PRJ_V3", "name": "V3 测试", "ratio": "16:9", "duration": 24,
        "generator": "Seedance 2.5", "brief": "测试工作流图", "stage": 0,
        "sortOrder": 0, "script": "", "assets": [], "shots": [], "audio": {},
        "assetRegulator": {}, "generations": [], "seedancePackages": [],
        "providerOverrides": {}, "undoStack": [], "scriptVersions": [],
        "storyboardVersions": [], "storyWorkflowRuns": [],
    }


def scene_ledger(scene_id: str, name: str, relevant_shots: list[str] | None = None) -> dict:
    """Build the complete scene contract used by storyboard-run fixtures."""
    return {
        "id": scene_id,
        "name": name,
        "description": f"{name} 的空间摘要",
        "interiorExterior": "外景",
        "timeOfDay": "夜",
        "location": name,
        "characterIds": [],
        "propIds": [],
        "narrativeFunction": "建立空间与叙事状态",
        "emotion": "克制的悬念",
        "visualAnchors": ["明确的空间边界", "可见的材质状态"],
        "spatialGeography": "前景与主体位置清晰，背景保持连续",
        "materialEvidence": "地面和主体表面有可见接触与反光",
        "lightingCausality": "主光源方向与阴影结果一致",
        "soundscape": "环境声持续并服务于剪辑衔接",
        "productionDifficulty": "medium",
        "relevantShots": relevant_shots or [],
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

    def test_storyboard_provider_schema_requires_continuity_and_seedance_plan(self) -> None:
        shot_schema = STORYBOARD_OUTPUT_SCHEMA["properties"]["shots"]["items"]
        continuity = shot_schema["properties"]["continuity"]
        seedance = shot_schema["properties"]["seedancePlan"]
        self.assertEqual(set(continuity["required"]), {"screenDirection", "eyeline", "motionVector", "cutIn", "cutOut", "matchAction", "editBridge", "preRoll", "postRoll", "firstFrame", "lastFrame"})
        self.assertIn("continuity", shot_schema["required"] if "required" in shot_schema else [])
        self.assertIn("promptTimeline", seedance["required"])
        self.assertIn("referenceAssignments", seedance["required"])
        self.assertIn("fallbackRoute", seedance["required"])
        scene_schema = STORYBOARD_OUTPUT_SCHEMA["properties"]["scenes"]["items"]
        self.assertIn("relevantShots", scene_schema["required"])
        self.assertIn("lightingCausality", scene_schema["required"])

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

    def test_story_asset_gap_is_pending_asset_work_not_a_story_blocker(self) -> None:
        response = self.client.put("/api/v2/projects/PRJ_V3/story", json={
            "expected_revision": 1,
            "spec": {"creative_goal": "资产准备阶段", "duration": 6, "ratio": "16:9"},
            "script": "镜头完成后进入资产生产。",
            "scenes": [{"id": "SC01", "name": "夜景平台"}],
            "shots": [{
                "id": "SH01", "scene": "SC01", "duration": 6, "purpose": "建立空间",
                "size": "中景", "camera": "固定", "action": "人物站在平台边缘",
                "composition": "中心构图", "performance": "观察", "dialogue": "",
                "narration": "", "lighting": "冷光", "color": "蓝紫", "style": "电影感",
                "firstFrame": "人物入画", "lastFrame": "人物抬头", "sound": "风声",
                "continuity": "保持站位", "assetRequirements": [{"assetId": "CHAR_MISSING", "assetClass": "character"}],
            }],
        })
        self.assertEqual(response.status_code, 200, response.text)
        checks = response.json()["checks"]
        self.assertTrue(checks["ok"])
        self.assertEqual(checks["errors"], 0)
        gap = next(issue for issue in checks["issues"] if issue["code"] == "asset_gap")
        self.assertEqual(gap["severity"], "warning")
        self.assertEqual(gap["details"]["missing_assets"][0]["asset_id"], "CHAR_MISSING")

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
        candidate = {"proposedScript": "候选剧本", "feasibility": {"verdict": "可执行", "difficulty": "low"}, "productionElements": {}, "scenes": [scene_ledger("SC01", "室内", ["SH01", "SH03"])], "shots": [
            {"id": "SH01", "scene": "SC01", "duration": 5, "purpose": "更新镜头一", "size": "特写", "camera": "固定", "action": "按键", "visibleEvent": "手指按下按键", "eventConsequence": "指示灯亮起", "seedancePlan": {"model": "seedance2.5", "generationMode": "reference_to_video"}, "continuity": {"cutIn": "手指入画"}},
            {"id": "SH03", "scene": "SC01", "duration": 3, "purpose": "新镜头", "size": "全景", "camera": "拉远", "action": "离开", "visibleEvent": "角色离开画面", "eventConsequence": "门口只剩雨幕", "seedancePlan": {"model": "seedance2.5", "generationMode": "reference_to_video"}, "continuity": {"cutOut": "雨声延续"}},
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
            "scenes": [scene_ledger("SC01", "雨夜", ["SH01"])],
            "shots": [{"id": "SH01", "scene": "SC01", "duration": 5, "purpose": "悬念", "size": "近景", "camera": "固定", "action": "按键", "visibleEvent": "手指按下按键", "eventConsequence": "屏幕突然亮起", "seedancePlan": {"model": "seedance2.5", "generationMode": "reference_to_video"}, "continuity": {"cutIn": "黑屏后入画"}}],
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

    def test_accept_script_only_keeps_shot_candidate_review_open_until_shots_are_accepted(self) -> None:
        created = self.client.post("/api/v2/projects/PRJ_V3/story/runs", json={"goal": "full", "strength": "balanced"})
        self.assertEqual(created.status_code, 200, created.text)
        run_id = created.json()["id"]
        candidate = {
            "proposedScript": "先接受剧本，不应立即进入资产总控。",
            "feasibility": {"verdict": "可执行", "difficulty": "low"},
            "productionElements": {},
            "scenes": [scene_ledger("SC01", "室内", ["SH01"])],
            "shots": [{"id": "SH01", "scene": "SC01", "duration": 5, "purpose": "建立", "size": "中景", "camera": "固定", "action": "抬头", "visibleEvent": "角色抬头看向门外", "eventConsequence": "雨水从屋檐落下遮断视线", "seedancePlan": {"model": "seedance2.5", "generationMode": "reference_to_video"}, "continuity": {"cutIn": "环境声先入"}}],
            "risks": [], "assetHandoff": {"characters": [], "scenes": [], "props": []},
        }
        regulator = mock.AsyncMock(return_value={"assetExtraction": [], "assetRequirements": [], "nextActions": []})
        with mock.patch.object(server, "_run_storyboard_agent", new=mock.AsyncMock(return_value=candidate)), mock.patch.object(server, "_run_regulator_agent", new=regulator):
            started = self.client.post(f"/api/v2/story-runs/{run_id}/start")
            self.assertEqual(started.status_code, 200, started.text)
            script_only = self.client.post(f"/api/v2/story-runs/{run_id}/accept-storyboard", json={"scope": "script_only"})
            self.assertEqual(script_only.status_code, 200, script_only.text)
            self.assertEqual(script_only.json()["run"]["status"], "storyboard_review_required")
            regulator.assert_not_awaited()
            shots_only = self.client.post(f"/api/v2/story-runs/{run_id}/accept-storyboard", json={"scope": "shots_only", "shot_ids": ["SH01"]})
            self.assertEqual(shots_only.status_code, 200, shots_only.text)
            self.assertEqual(shots_only.json()["run"]["status"], "regulator_review_required")
            regulator.assert_awaited_once()
        current = self.client.get("/api/v2/projects/PRJ_V3").json()["document"]
        self.assertEqual(current["script"], candidate["proposedScript"])
        self.assertEqual(current["shots"][0]["id"], "SH01")

    def test_explicit_script_duration_overrides_reference_duration_for_story_runs(self) -> None:
        source = "视频时长：13–15秒。少女在机库中抬眼，机甲回应。"
        saved = self.client.put("/api/v2/projects/PRJ_V3/story", json={
            "expected_revision": 1,
            "spec": {"creative_goal": "剧本时长优先", "duration": 30, "ratio": "16:9", "generator_profile": "seedance2.5"},
            "script": source,
            "scenes": [],
            "shots": [],
        })
        self.assertEqual(saved.status_code, 200, saved.text)
        # Deliberately send the old page reference duration. The server must
        # still derive the run duration and automatic budget from the script.
        created = self.client.post("/api/v2/projects/PRJ_V3/story/runs", json={
            "workflow_mode": "optimize_script_and_storyboard",
            "duration": 30,
            "generator_profile": "seedance2.5",
        })
        self.assertEqual(created.status_code, 200, created.text)
        run = self.client.get(f"/api/v2/story-runs/{created.json()['id']}")
        self.assertEqual(run.status_code, 200, run.text)
        input_package = run.json()["run"]["input"]
        self.assertEqual(input_package["duration"], 14.0)
        self.assertEqual(input_package["reference_duration"], 30)
        self.assertEqual(input_package["duration_source"], "script_explicit")
        self.assertEqual(input_package["script_duration"]["minimum"], 13.0)
        self.assertEqual(input_package["script_duration"]["maximum"], 15.0)
        self.assertEqual(input_package["shot_budget"]["automatic_shot_count_max"], 3)
        story = self.client.get("/api/v2/projects/PRJ_V3/story")
        self.assertEqual(story.status_code, 200, story.text)
        self.assertEqual(story.json()["story"]["spec"]["duration"], 14)
        self.assertEqual(story.json()["story"]["spec"]["duration_source"], "script_explicit")

    def test_story_candidate_revision_carries_feedback_and_previous_candidate_context(self) -> None:
        source = "视频时长：8秒。人物在雨夜按下开关。"
        saved = self.client.put("/api/v2/projects/PRJ_V3/story", json={
            "expected_revision": 1,
            "spec": {"creative_goal": "候选修订", "duration": 30, "ratio": "16:9", "generator_profile": "seedance2.5"},
            "script": source,
            "scenes": [],
            "shots": [],
        })
        self.assertEqual(saved.status_code, 200, saved.text)
        first = self.client.post("/api/v2/projects/PRJ_V3/story/runs", json={"workflow_mode": "optimize_script_and_storyboard", "duration": 30, "generator_profile": "seedance2.5"})
        self.assertEqual(first.status_code, 200, first.text)
        first_id = first.json()["id"]
        candidate = {
            "proposedScript": "候选：人物更克制地按下开关。",
            "feasibility": {"verdict": "可执行", "difficulty": "low"},
            "productionElements": {},
            "scenes": [scene_ledger("S001", "雨夜控制台", ["SH01"])],
            "shots": [{"id": "SH01", "scene": "S001", "duration": 8, "purpose": "建立按键动作", "size": "近景", "camera": "缓慢推进", "action": "手指按下开关", "visibleEvent": "手指触碰开关", "eventConsequence": "开关指示灯亮起", "seedancePlan": {"model": "seedance2.5", "generationMode": "reference_to_video"}, "continuity": {"cutIn": "雨声先入", "cutOut": "指示灯保持亮起"}}],
            "risks": [],
            "assetHandoff": {"characters": [], "scenes": [], "props": []},
        }
        with mock.patch.object(server, "_run_storyboard_agent", new=mock.AsyncMock(return_value=candidate)):
            started = self.client.post(f"/api/v2/story-runs/{first_id}/start")
        self.assertEqual(started.status_code, 200, started.text)
        revised = self.client.post("/api/v2/projects/PRJ_V3/story/runs", json={
            "workflow_mode": "optimize_script_and_storyboard",
            "duration": 30,
            "generator_profile": "seedance2.5",
            "revision_feedback": "保留一镜到底感觉，减少推进速度，并让指示灯的亮起更明确。",
            "revision_of_run_id": first_id,
        })
        self.assertEqual(revised.status_code, 200, revised.text)
        revision_input = self.client.get(f"/api/v2/story-runs/{revised.json()['id']}").json()["run"]["input"]
        self.assertEqual(revision_input["revision_of_run_id"], first_id)
        self.assertIn("减少推进速度", revision_input["revision_feedback"])
        self.assertEqual(revision_input["revision_context"]["run_id"], first_id)
        self.assertEqual(revision_input["revision_context"]["storyboard_output"]["shots"][0]["id"], "SH01")

    def test_storyboard_from_source_preserves_script_byte_for_byte_on_acceptance(self) -> None:
        source = "原文：雨落在玻璃上。\n\n角色说：不要替我改写这句话……"
        saved = self.client.put("/api/v2/projects/PRJ_V3/story", json={
            "expected_revision": 1,
            "spec": {"creative_goal": "锁定原文", "duration": 60, "ratio": "16:9", "generator_profile": "seedance2.5"},
            "script": source,
            "scenes": [scene_ledger("C01", "室内", ["SH01"])],
            "shots": [],
        })
        self.assertEqual(saved.status_code, 200, saved.text)
        created = self.client.post("/api/v2/projects/PRJ_V3/story/runs", json={
            "goal": "script_storyboard", "workflow_mode": "storyboard_from_source", "duration": 60, "generator_profile": "seedance2.5",
        })
        self.assertEqual(created.status_code, 200, created.text)
        run_id = created.json()["id"]
        candidate = {
            "proposedScript": "供应商不应有机会写入的改写版本",
            "feasibility": {"verdict": "可执行", "difficulty": "low"},
            "productionElements": {},
            "scenes": [scene_ledger("C01", "室内", ["SH01"])],
            "shots": [{"id": "SH01", "scene": "C01", "duration": 8, "purpose": "建立", "size": "中景", "camera": "固定", "action": "雨滴滑落", "visibleEvent": "雨滴沿玻璃滑落", "eventConsequence": "玻璃表面的倒影被水痕切断", "seedancePlan": {"model": "seedance2.5", "generationMode": "reference_to_video", "targetDuration": 8}, "continuity": {"cutIn": "雨声先入", "cutOut": "倒影稳定"}}],
            "risks": [], "assetHandoff": {"characters": [], "scenes": [], "props": []},
        }
        regulator = {"assetExtraction": [], "assetRequirements": [], "nextActions": []}
        with mock.patch.object(server, "_run_storyboard_agent", new=mock.AsyncMock(return_value=candidate)), mock.patch.object(server, "_run_regulator_agent", new=mock.AsyncMock(return_value=regulator)):
            started = self.client.post(f"/api/v2/story-runs/{run_id}/start")
            self.assertEqual(started.status_code, 200, started.text)
            self.assertEqual(started.json()["run"]["storyboard_output"]["proposedScript"], source)
            accepted = self.client.post(f"/api/v2/story-runs/{run_id}/accept-storyboard", json={"scope": "all"})
            self.assertEqual(accepted.status_code, 200, accepted.text)
        current = self.client.get("/api/v2/projects/PRJ_V3").json()["document"]
        self.assertEqual(current["script"], source)
        self.assertFalse(any(version.get("source") == "agent" for version in current.get("scriptVersions", [])))
        self.assertEqual(current["shots"][0]["seedancePlan"]["model"], "seedance2.5")
        self.assertEqual(current["scenes"][0]["spatialGeography"], candidate["scenes"][0]["spatialGeography"])
        story_after = self.client.get("/api/v2/projects/PRJ_V3/story").json()
        self.assertNotIn("duration_mismatch", {issue["code"] for issue in story_after["checks"]["issues"]})

    def test_storyboard_handoff_merges_repeated_stable_asset_ids(self) -> None:
        source = "锁定原文：角色走上高架。"
        saved = self.client.put("/api/v2/projects/PRJ_V3/story", json={
            "expected_revision": 1,
            "spec": {"creative_goal": "去重交接", "duration": 12, "ratio": "16:9", "generator_profile": "seedance2.5"},
            "script": source,
            "scenes": [],
            "shots": [],
        })
        self.assertEqual(saved.status_code, 200, saved.text)
        created = self.client.post("/api/v2/projects/PRJ_V3/story/runs", json={"workflow_mode": "storyboard_from_source", "duration": 12, "generator_profile": "seedance2.5"})
        self.assertEqual(created.status_code, 200, created.text)
        run_id = created.json()["id"]
        candidate = {
            "proposedScript": "供应商返回的改写会被锁定原文覆盖",
            "feasibility": {"verdict": "可执行", "difficulty": "low"},
            "productionElements": {},
            "scenes": [scene_ledger("S001", "高架", ["SH01"])],
            "shots": [{"id": "SH01", "scene": "S001", "duration": 8, "purpose": "建立", "size": "中景", "camera": "固定", "action": "抬头", "visibleEvent": "角色抬头", "eventConsequence": "雨水顺着护栏落下", "seedancePlan": {"model": "seedance2.5", "generationMode": "reference_to_video"}, "continuity": {"cutIn": "雨声先入"}}],
            "risks": [],
            "assetHandoff": {"characters": [{"id": "C001", "name": "主角", "relevantShots": ["SH01"]}, {"id": "C001", "generationReferenceAssets": [{"assetId": "STYLE01", "role": "视觉风格"}]}], "scenes": [{"id": "S001", "name": "高架"}], "props": [], "soundRequirements": []},
        }
        with mock.patch.object(server, "_run_storyboard_agent", new=mock.AsyncMock(return_value=candidate)):
            started = self.client.post(f"/api/v2/story-runs/{run_id}/start")
        self.assertEqual(started.status_code, 200, started.text)
        output = started.json()["run"]["storyboard_output"]
        self.assertEqual(started.json()["run"]["status"], "storyboard_review_required")
        self.assertEqual(len(output["assetHandoff"]["characters"]), 1)
        self.assertEqual(output["assetHandoff"]["characters"][0]["relevantShots"], ["SH01"])
        self.assertEqual(output["assetHandoff"]["characters"][0]["generationReferenceAssets"][0]["assetId"], "STYLE01")

    def test_storyboard_contract_failure_retries_once_without_retrying_budget_failure(self) -> None:
        source = "锁定原文：雨夜平台。"
        saved = self.client.put("/api/v2/projects/PRJ_V3/story", json={
            "expected_revision": 1,
            "spec": {"creative_goal": "合同重试", "duration": 12, "ratio": "16:9", "generator_profile": "seedance2.5"},
            "script": source,
            "scenes": [],
            "shots": [],
        })
        self.assertEqual(saved.status_code, 200, saved.text)
        created = self.client.post("/api/v2/projects/PRJ_V3/story/runs", json={"workflow_mode": "storyboard_from_source", "duration": 12, "generator_profile": "seedance2.5"})
        self.assertEqual(created.status_code, 200, created.text)
        run_id = created.json()["id"]
        invalid = {"proposedScript": "错误改写", "feasibility": {"verdict": "可执行", "difficulty": "low"}, "productionElements": {}, "scenes": [], "risks": [], "assetHandoff": {"characters": [], "scenes": [], "props": []}}
        valid = {"proposedScript": "错误改写", "feasibility": {"verdict": "可执行", "difficulty": "low"}, "productionElements": {}, "scenes": [scene_ledger("S001", "平台", ["SH01"])], "shots": [{"id": "SH01", "scene": "S001", "duration": 8, "purpose": "建立", "size": "中景", "camera": "固定", "action": "抬头", "visibleEvent": "角色抬头", "eventConsequence": "雨水从护栏落下", "seedancePlan": {"model": "seedance2.5", "generationMode": "reference_to_video"}, "continuity": {"cutIn": "雨声先入"}}], "risks": [], "assetHandoff": {"characters": [], "scenes": [], "props": []}}
        agent = mock.AsyncMock(side_effect=[invalid, valid])
        with mock.patch.object(server, "_run_storyboard_agent", new=agent):
            started = self.client.post(f"/api/v2/story-runs/{run_id}/start")
        self.assertEqual(started.status_code, 200, started.text)
        self.assertEqual(started.json()["run"]["status"], "storyboard_review_required")
        self.assertEqual(agent.await_count, 2)
        self.assertTrue(started.json()["run"]["storyboard_output"].get("contractRepairRetry"))

    def test_storyboard_candidate_over_budget_is_rejected_before_acceptance(self) -> None:
        created = self.client.post("/api/v2/projects/PRJ_V3/story/runs", json={"goal": "full", "workflow_mode": "optimize_script_and_storyboard", "duration": 60, "generator_profile": "seedance2.0"})
        self.assertEqual(created.status_code, 200, created.text)
        run_id = created.json()["id"]
        shots = [{"id": f"SH{index:02d}", "scene": "C01", "duration": 7, "purpose": f"事件 {index}", "size": "中景", "camera": "固定", "action": "动作"} for index in range(1, 10)]
        candidate = {"proposedScript": "候选", "feasibility": {"verdict": "可执行", "difficulty": "medium"}, "productionElements": {}, "scenes": [scene_ledger("C01", "夜", [shot["id"] for shot in shots])], "shots": shots, "risks": [], "assetHandoff": {"characters": [], "scenes": [], "props": []}}
        with mock.patch.object(server, "_run_storyboard_agent", new=mock.AsyncMock(return_value=candidate)):
            started = self.client.post(f"/api/v2/story-runs/{run_id}/start")
        self.assertEqual(started.status_code, 422, started.text)
        self.assertIn("shot_budget_exceeded", str(started.json()))
        self.assertEqual(self.client.get(f"/api/v2/story-runs/{run_id}").json()["run"]["status"], "failed")

    def test_asset_handoff_acceptance_persists_reference_roles_and_receipt(self) -> None:
        created = self.client.post("/api/v2/projects/PRJ_V3/story/runs", json={"goal": "full", "duration": 12, "generator_profile": "seedance2.5"})
        self.assertEqual(created.status_code, 200, created.text)
        run_id = created.json()["id"]
        candidate = {
            "proposedScript": "资产交接测试",
            "feasibility": {"verdict": "可执行", "difficulty": "medium"},
            "productionElements": {},
            "scenes": [scene_ledger("S001", "雨夜平台", ["SH01"])],
            "shots": [{"id": "SH01", "scene": "S001", "duration": 6, "purpose": "建立空间", "size": "中景", "camera": "固定", "action": "雨水落下", "visibleEvent": "雨水沿平台边缘落下", "eventConsequence": "积水表面产生连续波纹", "seedancePlan": {"model": "seedance2.5", "generationMode": "reference_to_video"}, "continuity": {"cutIn": "风声先入", "cutOut": "波纹保持"}}],
            "risks": [],
            "assetHandoff": {
                "characters": [{"id": "C001", "name": "主角", "productionRole": "base_asset", "relevantShots": ["SH01"], "generationReferenceAssets": []}],
                "scenes": [{"id": "S001", "name": "雨夜平台", "productionRole": "base_asset", "relevantShots": ["SH01"], "generationReferenceAssets": []}],
                "props": [{"id": "P001", "name": "雨伞", "productionRole": "prop", "relevantShots": ["SH01"], "generationReferenceAssets": [{"assetId": "C001", "role": "尺度与手持关系", "reason": "确认角色手持比例"}]}],
                "soundRequirements": [{"id": "AUDIO001", "name": "雨声", "sourceText": "连续雨声", "relevantShots": ["SH01"]}],
            },
        }
        regulator = {"assetExtraction": [{"id": "C001", "assetClass": "character", "name": "主角", "priority": "B"}, {"id": "S001", "assetClass": "scene", "name": "雨夜平台", "priority": "B"}, {"id": "P001", "assetClass": "prop", "name": "雨伞", "priority": "B"}], "assetRequirements": [{"shotId": "SH01", "assetId": "C001", "assetClass": "character", "role": "主角", "required": True}], "nextActions": []}
        with mock.patch.object(server, "_run_storyboard_agent", new=mock.AsyncMock(return_value=candidate)), mock.patch.object(server, "_run_regulator_agent", new=mock.AsyncMock(return_value=regulator)):
            started = self.client.post(f"/api/v2/story-runs/{run_id}/start")
            self.assertEqual(started.status_code, 200, started.text)
            accepted = self.client.post(f"/api/v2/story-runs/{run_id}/accept-storyboard", json={"scope": "all"})
            self.assertEqual(accepted.status_code, 200, accepted.text)
            finalized = self.client.post(f"/api/v2/story-runs/{run_id}/accept-regulator")
            self.assertEqual(finalized.status_code, 200, finalized.text)
        receipt = finalized.json()["handoffReceipt"]
        self.assertEqual(finalized.json()["run"]["status"], "succeeded")
        self.assertGreaterEqual(receipt["createdAssets"].__len__(), 3)
        self.assertEqual(receipt["shotAssetEdges"], 1)
        self.assertEqual(receipt["referenceAssetEdges"], 1)
        self.assertIn("C001", receipt["resolvedAssetIds"])
        project = self.client.get("/api/v2/projects/PRJ_V3").json()["document"]
        prop = next(asset for asset in project["assets"] if asset["id"] == "P001")
        self.assertEqual(prop["assetMetadata"]["generationReferenceAssets"][0]["role"], "尺度与手持关系")

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
