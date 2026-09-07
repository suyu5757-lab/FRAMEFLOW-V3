from __future__ import annotations

import unittest
import uuid
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import server


def fusion_project(project_id: str = "PRJ_FUSION") -> dict:
    ready_fields = {
        "artifactId": "ART_READY",
        "qaDecision": "Approved",
        "regulatorRegistered": True,
        "status": "ready",
        "promptQaDecision": "Approved",
    }
    return {
        "id": project_id,
        "name": "融合两阶段测试",
        "ratio": "16:9",
        "duration": 8,
        "generator": "test",
        "brief": "三人押解穿过山路",
        "stage": 0,
        "sortOrder": 0,
        "script": "三人沿山路押解目标，前景角色回头观察，环境保持连续。",
        "assets": [
            {"id": "C001", "name": "前景角色", "assetClass": "character", "grade": "B", "prompt": "角色 Prompt", **ready_fields},
            {"id": "C002", "name": "中景角色", "assetClass": "character", "grade": "B", "prompt": "中景角色 Prompt", **ready_fields},
            {"id": "S001", "name": "山路环境", "assetClass": "scene", "grade": "B", "prompt": "山路环境 Prompt", **ready_fields},
            {"id": "BLEND_SH001", "name": "SH001 融合场景", "assetClass": "fusion", "grade": "B", "note": "山路三人押解的空间关系", "fusionSourceAssetIds": ["C001", "C002", "S001"], "promptRelevantShots": ["SH001"], "assetMetadata": {"fusion_slot": True, "fusion_slot_id": "fusion-slot:SH001", "fusion_shot_id": "SH001"}},
        ],
        "shots": [{"id": "SH001", "scene": "山路", "duration": 4, "purpose": "建立三人押解与后续冲突的空间关系", "action": "三人沿山路前进"}],
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


def prompt_card(asset_id: str, asset_class: str) -> dict:
    return {
        "id": asset_id,
        "assetClass": asset_class,
        "name": asset_id,
        "priority": "B",
        "required": True,
        "targetSkill": f"video-{asset_class}-design-director",
        "relevantShots": ["SH001"],
        "prompt": f"{asset_id} 的正式 Prompt",
        "promptPack": {"identity": asset_id},
        "mustPreserve": ["身份"],
        "mustAvoid": ["变形"],
        "imageGenerationEligible": True,
    }


class FusionPromptFlowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db_path = Path(__file__).parent / f"test-fusion-{uuid.uuid4().hex}.db"
        self.db_patch = mock.patch.object(server, "DB_PATH", self.db_path)
        self.db_patch.start()
        self.client_context = TestClient(server.app)
        self.client = self.client_context.__enter__()
        response = self.client.put("/api/v2/projects/PRJ_FUSION", json={"document": fusion_project()})
        self.assertEqual(response.status_code, 200, response.text)

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        self.db_patch.stop()
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.db_path) + suffix)
            if candidate.is_file():
                candidate.unlink()

    def test_fusion_gate_reports_prompt_qa_blockers_and_opens_after_all_sources_are_ready(self) -> None:
        ready_fields = {
            "artifactId": "ART_READY",
            "qaDecision": "Approved",
            "regulatorRegistered": True,
            "status": "ready",
        }
        sources = [
            {"id": "ENV01", "name": "ENV01", "assetClass": "scene", "prompt": "环境 Prompt", "promptQaDecision": "Pending", **ready_fields},
            {"id": "P01", "name": "P01", "assetClass": "character", "prompt": "角色一 Prompt", "promptQaDecision": "Pending", **ready_fields},
            {"id": "P02", "name": "P02", "assetClass": "character", "prompt": "角色二 Prompt", "promptQaDecision": "Pending", **ready_fields},
        ]
        fusion = {"id": "FUSION_S02", "assetClass": "fusion", "fusionSourceAssetIds": ["ENV01", "P01", "P02"]}

        blocked = server._fusion_auto_gate({"assets": [*sources, fusion]}, fusion)
        self.assertFalse(blocked["allowed"])
        self.assertEqual(blocked["blocked_source_ids"], ["ENV01", "P01", "P02"])
        self.assertIn("ENV01（完成 Prompt QA）", blocked["reason"])
        self.assertIn("P01（完成 Prompt QA）", blocked["reason"])
        self.assertIn("P02（完成 Prompt QA）", blocked["reason"])

        for source in sources:
            source["promptQaDecision"] = "Approved"
        ready = server._fusion_auto_gate({"assets": [*sources, fusion]}, fusion)
        self.assertTrue(ready["allowed"])
        self.assertEqual(ready["blocked_source_ids"], [])
        self.assertEqual(ready["reason"], "前置基础资产已全部就绪，可生成 Fusion Prompt")

    def test_initial_run_only_persists_fusion_plan(self) -> None:
        regulator = {
            "assetExtraction": [],
            "assetRequirements": [
                {"shotId": "SH001", "assetId": "C001", "assetClass": "character"},
                {"shotId": "SH001", "assetId": "C002", "assetClass": "character"},
                {"shotId": "SH001", "assetId": "S001", "assetClass": "scene"},
                {"shotId": "SH001", "assetId": "BLEND_SH001", "assetClass": "fusion"},
            ],
        }
        prompt_output = {
            "assets": [
                prompt_card("C001", "character"),
                prompt_card("C002", "character"),
                prompt_card("S001", "scene"),
                {**prompt_card("BLEND_SH001", "fusion"), "prompt": "不应成为正式融合 Prompt"},
            ],
            "fusionPlans": [{
                "fusionAssetId": "BLEND_SH001",
                "shotId": "SH001",
                "candidateSourceAssetIds": ["C001", "C002", "S001"],
                "shotIntent": "山路三人押解",
                "requiredRoles": ["前景角色", "中景角色", "环境"],
                "continuityConstraints": ["保持山路轴线"],
                "status": "awaiting_connection",
            }],
            "missingAssetRegister": [],
            "dependencyTable": [],
            "routingPlan": [],
            "nextActions": [],
            "warnings": [],
        }
        with mock.patch.object(server, "_run_regulator_agent", new=mock.AsyncMock(return_value=regulator)), mock.patch.object(server, "_run_asset_prompt_agent", new=mock.AsyncMock(return_value=prompt_output)):
            response = self.client.post("/api/v2/projects/PRJ_FUSION/asset-prompt-runs", json={"expected_revision": 1})
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertTrue(payload["run"]["fusionPlans"])
        self.assertFalse(any(card["id"] == "BLEND_SH001" for card in payload["run"]["promptOutput"]["assets"]))
        fusion = next(item for item in payload["library"]["assets"] if item["id"] == "BLEND_SH001")
        self.assertEqual(fusion["fusionPromptState"], "awaiting_connection")
        self.assertFalse(fusion.get("fusionPromptQaAllowed", True))
        self.assertFalse(fusion.get("fusionPromptGenerationAllowed", True))
        self.assertFalse(fusion.get("promptVersion"))
        self.assertEqual(fusion["fusionPlan"]["shot_id"], "SH001")
        self.assertTrue(fusion["fusionSlot"])
        self.assertEqual(fusion["fusionSourceAssetIds"], ["C001", "C002", "S001"])
        board = payload["asset_board"]["board"]
        fusion_handoff = next(node for node in board["nodes"] if node["id"] == "handoff:BLEND_SH001")
        self.assertTrue(fusion_handoff["config"]["prompt_card"])
        self.assertTrue(fusion_handoff["config"]["fusion_slot"])
        self.assertEqual(fusion_handoff["config"]["fusion_source_asset_ids"], ["C001", "C002", "S001"])
        board_node_ids = {node["asset_id"]: node["id"] for node in board["nodes"] if node.get("asset_id") and node["node_type"] == "asset"}
        automatic_inputs = {
            edge["source"]
            for edge in board["edges"]
            if edge["target"] == board_node_ids["BLEND_SH001"] and edge["relation"] == "fusion_input"
        }
        self.assertEqual(automatic_inputs, {board_node_ids["C001"], board_node_ids["C002"], board_node_ids["S001"]})
        self.assertIn(
            {"source": "shot:SH001", "target": board_node_ids["BLEND_SH001"], "relation": "shot_dependency"},
            [{"source": edge["source"], "target": edge["target"], "relation": edge["relation"]} for edge in board["edges"]],
        )

    def test_initial_run_creates_missing_per_shot_fusion_slot_and_auto_links_it(self) -> None:
        project = fusion_project("PRJ_FUSION_SLOT")
        project["assets"] = project["assets"][:3]
        created = self.client.put("/api/v2/projects/PRJ_FUSION_SLOT", json={"document": project})
        self.assertEqual(created.status_code, 200, created.text)
        regulator = {
            "assetExtraction": [],
            "assetRequirements": [
                {"shotId": "SH001", "assetId": "C001", "assetClass": "character"},
                {"shotId": "SH001", "assetId": "C002", "assetClass": "character"},
                {"shotId": "SH001", "assetId": "S001", "assetClass": "scene"},
            ],
        }
        prompt_output = {
            "assets": [prompt_card("C001", "character"), prompt_card("C002", "character"), prompt_card("S001", "scene")],
            "fusionPlans": [],
            "missingAssetRegister": [],
            "dependencyTable": [],
            "routingPlan": [],
            "nextActions": [],
            "warnings": [],
        }
        with mock.patch.object(server, "_run_regulator_agent", new=mock.AsyncMock(return_value=regulator)), mock.patch.object(server, "_run_asset_prompt_agent", new=mock.AsyncMock(return_value=prompt_output)):
            response = self.client.post("/api/v2/projects/PRJ_FUSION_SLOT/asset-prompt-runs", json={"expected_revision": 1})
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        slot = next(item for item in payload["library"]["assets"] if item["id"] == "FUSION_SH001")
        self.assertTrue(slot["fusionSlot"])
        self.assertEqual(slot["fusionSourceAssetIds"], ["C001", "C002", "S001"])
        self.assertIn("FUSION_SH001", [item["fusion_asset_id"] for item in payload["run"]["fusionPlans"]])
        board = payload["asset_board"]["board"]
        node_ids = {node["asset_id"]: node["id"] for node in board["nodes"] if node.get("asset_id") and node["node_type"] == "asset"}
        self.assertIn("handoff:FUSION_SH001", {node["id"] for node in board["nodes"]})
        self.assertEqual(
            {
                edge["source"]
                for edge in board["edges"]
                if edge["target"] == node_ids["FUSION_SH001"] and edge["relation"] == "fusion_input"
            },
            {node_ids["C001"], node_ids["C002"], node_ids["S001"]},
        )

    def test_existing_fusion_slot_auto_links_and_generates_without_manual_edges(self) -> None:
        board = self.client.get("/api/v2/projects/PRJ_FUSION/asset-board").json()
        node_ids = {node["asset_id"]: node["id"] for node in board["board"]["nodes"] if node.get("asset_id") and node["node_type"] == "asset"}
        self.assertEqual(
            {
                edge["source"]
                for edge in board["board"]["edges"]
                if edge["target"] == node_ids["BLEND_SH001"] and edge["relation"] == "fusion_input"
            },
            {node_ids["C001"], node_ids["C002"], node_ids["S001"]},
        )
        with mock.patch.object(server, "_run_fusion_prompt_agent", new=mock.AsyncMock(return_value={
            "fusionAssetId": "BLEND_SH001",
            "shotId": "SH001",
            "sourceAssetIds": ["C001", "C002", "S001"],
            "prompt": "正式融合：两名角色在山路环境中保持前中后景空间关系。",
            "promptPack": {"composition": "前中后景"},
            "mustPreserve": ["角色身份", "山路空间"],
            "mustAvoid": ["重复人物"],
            "warnings": [],
        })):
            generated = self.client.post("/api/v2/projects/PRJ_FUSION/fusion-prompt-runs", json={
                "expected_project_revision": 1,
                "expected_board_revision": board["revision"],
                "fusion_asset_id": "BLEND_SH001",
                "shot_id": "SH001",
                "source_asset_ids": ["C001", "C002", "S001"],
                "confirmed": True,
            })
        self.assertEqual(generated.status_code, 200, generated.text)
        self.assertEqual(generated.json()["run"]["source_asset_ids"], ["C001", "C002", "S001"])

    def test_board_sync_upgrades_existing_prompt_project_and_returns_all_projections(self) -> None:
        project = fusion_project("PRJ_FUSION_SYNC")
        project["assets"] = project["assets"][:3]
        project["shots"][0]["assetRequirements"] = [
            {"assetId": "C001", "assetClass": "character", "required": True},
            {"assetId": "C002", "assetClass": "character", "required": True},
            {"assetId": "S001", "assetClass": "scene", "required": True},
        ]
        created = self.client.put("/api/v2/projects/PRJ_FUSION_SYNC", json={"document": project})
        self.assertEqual(created.status_code, 200, created.text)
        with server.app.state.db.connect() as connection:
            row = connection.execute("SELECT document_json FROM projects WHERE id=?", ("PRJ_FUSION_SYNC",)).fetchone()
            document = server.app.state.db.decode(row["document_json"], {})
            document["assetPromptRuns"] = [{"id": "ASSETPROMPT_EXISTING"}]
            connection.execute("UPDATE projects SET document_json=? WHERE id=?", (server.app.state.db.encode(document), "PRJ_FUSION_SYNC"))
        initial = self.client.get("/api/v2/projects/PRJ_FUSION_SYNC/asset-board")
        self.assertEqual(initial.status_code, 200, initial.text)
        synced = self.client.post("/api/v2/projects/PRJ_FUSION_SYNC/asset-board/sync", json={"expected_revision": initial.json()["revision"], "preserve_layout": True})
        self.assertEqual(synced.status_code, 200, synced.text)
        payload = synced.json()
        self.assertIn("library", payload)
        self.assertIn("story", payload)
        self.assertEqual(payload["project_revision"], 2)
        self.assertTrue(any(asset["id"] == "FUSION_SH001" for asset in payload["library"]["assets"]))
        self.assertTrue(any(node["id"] == "handoff:FUSION_SH001" for node in payload["board"]["nodes"]))

    def _connect_sources(self) -> dict:
        board = self.client.get("/api/v2/projects/PRJ_FUSION/asset-board").json()
        node_ids = {node["asset_id"]: node["id"] for node in board["board"]["nodes"] if node.get("asset_id")}
        board["board"]["edges"].extend([
            {"id": "edge:test:C001:BLEND_SH001", "source": node_ids["C001"], "target": node_ids["BLEND_SH001"], "relation": "fusion_input"},
            {"id": "edge:test:C002:BLEND_SH001", "source": node_ids["C002"], "target": node_ids["BLEND_SH001"], "relation": "fusion_input"},
            {"id": "edge:test:S001:BLEND_SH001", "source": node_ids["S001"], "target": node_ids["BLEND_SH001"], "relation": "fusion_input"},
        ])
        saved = self.client.put("/api/v2/projects/PRJ_FUSION/asset-board", json={"expected_revision": board["revision"], "board": board["board"]})
        self.assertEqual(saved.status_code, 200, saved.text)
        return saved.json()

    def test_targeted_generation_records_lineage_and_stale_state(self) -> None:
        board = self._connect_sources()
        with mock.patch.object(server, "_run_fusion_prompt_agent", new=mock.AsyncMock(return_value={
            "fusionAssetId": "BLEND_SH001",
            "shotId": "SH001",
            "sourceAssetIds": ["C001", "C002", "S001"],
            "prompt": "正式融合：三人沿山路押解，保留前中后景空间关系。",
            "promptPack": {"composition": "前中后景"},
            "mustPreserve": ["角色身份", "山路轴线"],
            "mustAvoid": ["重复人物"],
            "warnings": [],
        })):
            response = self.client.post("/api/v2/projects/PRJ_FUSION/fusion-prompt-runs", json={
                "expected_project_revision": 1,
                "expected_board_revision": board["revision"],
                "fusion_asset_id": "BLEND_SH001",
                "shot_id": "SH001",
                "source_asset_ids": ["C001", "C002", "S001"],
                "confirmed": True,
            })
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["run"]["source_asset_ids"], ["C001", "C002", "S001"])
        self.assertEqual(payload["prompt_version"]["source"], "fusion-connection-agent")
        self.assertIsNone(payload["prompt_version"].get("parent_version"))
        fusion = next(item for item in payload["library"]["assets"] if item["id"] == "BLEND_SH001")
        self.assertEqual(fusion["fusionPromptState"], "prompt_draft_ready")
        self.assertFalse(fusion["fusionPromptStale"])
        self.assertEqual(fusion["fusionPromptRun"]["source_prompt_versions"], {"C001": "", "C002": "", "S001": ""})
        self.assertEqual(fusion["promptQaDecision"], "Pending")

        board_changed = self.client.put("/api/v2/projects/PRJ_FUSION/asset-board", json={
            "expected_revision": payload["asset_board"]["revision"],
            "board": payload["asset_board"]["board"],
        })
        self.assertEqual(board_changed.status_code, 200, board_changed.text)
        library_after_board_change = self.client.get("/api/v2/projects/PRJ_FUSION/assets").json()
        fusion_after_board_change = next(item for item in library_after_board_change["assets"] if item["id"] == "BLEND_SH001")
        self.assertEqual(fusion_after_board_change["fusionPromptState"], "stale")
        self.assertIn("画布", fusion_after_board_change["fusionPromptStaleReason"])

        patched = self.client.patch("/api/v2/projects/PRJ_FUSION/assets/C001", json={
            "expected_revision": payload["revision"],
            "asset_class": "character",
            "prompt": "角色 Prompt 修订版",
            "source": "asset-library",
        })
        self.assertEqual(patched.status_code, 200, patched.text)
        library = self.client.get("/api/v2/projects/PRJ_FUSION/assets").json()
        fusion_after_change = next(item for item in library["assets"] if item["id"] == "BLEND_SH001")
        self.assertEqual(fusion_after_change["fusionPromptState"], "stale")
        self.assertTrue(fusion_after_change["fusionPromptStale"])
        versions = self.client.get("/api/v2/projects/PRJ_FUSION/assets/BLEND_SH001/prompt-versions")
        self.assertEqual(versions.status_code, 200, versions.text)
        self.assertEqual(len(versions.json()["prompt_versions"]), 1)

    def test_targeted_generation_blocks_unconfirmed_or_unsaved_connection(self) -> None:
        board = self.client.get("/api/v2/projects/PRJ_FUSION/asset-board").json()
        base = {
            "expected_project_revision": 1,
            "expected_board_revision": board["revision"],
            "fusion_asset_id": "BLEND_SH001",
            "shot_id": "SH001",
            "source_asset_ids": ["C001", "C002"],
            "confirmed": False,
        }
        response = self.client.post("/api/v2/projects/PRJ_FUSION/fusion-prompt-runs", json=base)
        self.assertEqual(response.status_code, 409, response.text)
        with mock.patch.object(server, "_run_fusion_prompt_agent", new=mock.AsyncMock()):
            response = self.client.post("/api/v2/projects/PRJ_FUSION/fusion-prompt-runs", json={**base, "confirmed": True})
        self.assertEqual(response.status_code, 409, response.text)


if __name__ == "__main__":
    unittest.main()
