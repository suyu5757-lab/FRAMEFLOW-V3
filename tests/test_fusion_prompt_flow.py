from __future__ import annotations

import base64
import unittest
import uuid
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import server


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


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

    def test_prerequisite_gate_derives_prompt_pack_dependencies_and_blocks_intake(self) -> None:
        project = fusion_project("PRJ_PREREQUISITE")
        project["assets"] = [
            {"id": "P01", "name": "P01", "assetClass": "character", "prompt": "P01 Prompt", **{
                "artifactId": "ART_P01", "qaDecision": "Approved", "regulatorRegistered": True,
                "status": "ready", "promptQaDecision": "Approved",
            }},
            {"id": "ENV01", "name": "ENV01", "assetClass": "scene", "prompt": "ENV01 Prompt", **{
                "artifactId": "ART_ENV01", "qaDecision": "Approved", "regulatorRegistered": True,
                "status": "ready", "promptQaDecision": "Approved",
            }},
            {"id": "P12", "name": "P12", "assetClass": "prop", "prompt": "P12 Prompt"},
            {
                "id": "P08", "name": "P08", "assetClass": "prop", "prompt": "P08 Prompt",
                "promptQaDecision": "Approved",
                "promptPack": {
                    "referenceStrategy": {"referenceRoles": [
                        {"assetId": "P01", "role": "发射者身份与接口"},
                        {"assetId": "P12", "role": "实体命中承载物"},
                    ]},
                    "generationNotes": "先依赖P01、ENV01和P12基础资产。",
                },
            },
        ]
        project["assetRegulator"] = {"dependencyTable": [{
            "from": "P01", "to": ["P08"], "reason": "沿用 P01 的身份与接口连续性",
        }]}
        created = self.client.put("/api/v2/projects/PRJ_PREREQUISITE", json={"document": project})
        self.assertEqual(created.status_code, 200, created.text)

        library_response = self.client.get("/api/v2/projects/PRJ_PREREQUISITE/assets")
        self.assertEqual(library_response.status_code, 200, library_response.text)
        library = {item["id"]: item for item in library_response.json()["assets"]}
        p08 = library["P08"]
        self.assertEqual(set(item["asset_id"] for item in p08["prerequisiteDependencies"]), {"P01", "ENV01", "P12"})
        self.assertFalse(p08["prerequisiteGate"]["allowed"])
        self.assertEqual(p08["prerequisiteGate"]["blocked_asset_ids"], ["P12"])
        self.assertIn("P12", p08["prerequisiteGate"]["reason"])
        self.assertIn("prerequisite_assets", p08["readiness"]["production_missing"])
        self.assertFalse(p08["production_ready"])
        self.assertTrue(library["P01"]["prerequisiteGate"]["allowed"])
        self.assertTrue(library["ENV01"]["prerequisiteGate"]["allowed"])

        intake = self.client.post(
            "/api/v2/projects/PRJ_PREREQUISITE/asset-intake",
            data={"logical_asset_id": "P08", "asset_class": "prop", "asset_role": "prop", "source_type": "chatgpt-web"},
            files={"file": ("p08.png", PNG_1X1, "image/png")},
        )
        self.assertEqual(intake.status_code, 409, intake.text)
        self.assertEqual(intake.json()["code"], "prerequisite_blocked")
        self.assertEqual(intake.json()["details"]["prerequisite_gate"]["blocked_asset_ids"], ["P12"])

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
        # The connection-driven Prompt Pack is the authoritative reference
        # snapshot for a fusion asset. Registration must not require a second
        # manual asset_reference_roles_v4 entry for the same inputs.
        gate = self.client.post("/api/v2/projects/PRJ_FUSION/assets/BLEND_SH001/fusion-gate")
        self.assertEqual(gate.status_code, 200, gate.text)
        self.assertEqual(gate.json()["status"], "allowed")

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

        board_resaved = self.client.put("/api/v2/projects/PRJ_FUSION/asset-board", json={
            "expected_revision": payload["asset_board"]["revision"],
            "board": payload["asset_board"]["board"],
        })
        self.assertEqual(board_resaved.status_code, 200, board_resaved.text)
        library_after_board_change = self.client.get("/api/v2/projects/PRJ_FUSION/assets").json()
        fusion_after_board_change = next(item for item in library_after_board_change["assets"] if item["id"] == "BLEND_SH001")
        # Re-saving the same board (including a layout-only revision) must not
        # invalidate a Prompt whose semantic inputs are unchanged. Artifact
        # upload/withdrawal uses this same board refresh path.
        self.assertEqual(fusion_after_board_change["fusionPromptState"], "prompt_draft_ready")
        self.assertFalse(fusion_after_board_change["fusionPromptStale"])

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

    def test_fusion_prompt_stays_usable_when_output_image_is_replaced(self) -> None:
        board = self._connect_sources()
        with mock.patch.object(server, "_run_fusion_prompt_agent", new=mock.AsyncMock(return_value={
            "fusionAssetId": "BLEND_SH001",
            "shotId": "SH001",
            "sourceAssetIds": ["C001", "C002", "S001"],
            "prompt": "正式融合：三人沿山路押解，保持空间连续。",
            "promptPack": {"composition": "前中后景"},
            "mustPreserve": ["角色身份", "山路轴线"],
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
        generated_payload = generated.json()
        prompt_version = generated_payload["prompt_version"]["id"]

        intake = self.client.post(
            "/api/v2/projects/PRJ_FUSION/asset-intake",
            data={
                "logical_asset_id": "BLEND_SH001",
                "asset_class": "fusion",
                "asset_role": "shot-fusion",
                "source_type": "chatgpt-web",
                "prompt_version": prompt_version,
                "relevant_shots_json": '["SH001"]',
            },
            files={"file": ("fusion-first.png", PNG_1X1, "image/png")},
        )
        self.assertEqual(intake.status_code, 200, intake.text)
        intake_payload = intake.json()
        first_artifact_id = intake_payload["artifact"]["id"]
        self.assertIn("asset_board", intake_payload)
        library_after_intake = self.client.get("/api/v2/projects/PRJ_FUSION/assets").json()
        fusion_after_intake = next(item for item in library_after_intake["assets"] if item["id"] == "BLEND_SH001")
        self.assertFalse(fusion_after_intake["fusionPromptStale"])
        handoff_after_intake = next(node for node in intake_payload["asset_board"]["board"]["nodes"] if node["id"] == "handoff:BLEND_SH001")
        self.assertEqual(handoff_after_intake["config"]["artifact_id"], first_artifact_id)

        qa = self.client.post(f"/api/v2/projects/PRJ_FUSION/artifacts/{first_artifact_id}/qa-runs", json={"qa_type": "image", "manual_review": True})
        self.assertEqual(qa.status_code, 200, qa.text)
        qa_run_id = qa.json()["qa_run"]["id"]
        approved = self.client.post(f"/api/v2/projects/PRJ_FUSION/qa-runs/{qa_run_id}/submit", json={"decision": "Approved", "report": {"manual_review": True}})
        self.assertEqual(approved.status_code, 200, approved.text)
        self.assertEqual(approved.json()["artifact"]["status"], "approved_pending_registration")
        board_after_qa = self.client.get("/api/v2/projects/PRJ_FUSION/asset-board").json()

        synced_after_qa = self.client.post(
            "/api/v2/projects/PRJ_FUSION/asset-board/sync",
            json={"expected_revision": board_after_qa["revision"], "preserve_layout": True},
        )
        self.assertEqual(synced_after_qa.status_code, 200, synced_after_qa.text)
        handoff_after_qa = next(node for node in synced_after_qa.json()["board"]["nodes"] if node["id"] == "handoff:BLEND_SH001")
        self.assertEqual(handoff_after_qa["config"]["artifact_status"], "approved_pending_registration")
        self.assertEqual(handoff_after_qa["config"]["artifact_qa_decision"], "Approved")

        archived = self.client.delete(f"/api/v2/projects/PRJ_FUSION/artifacts/{first_artifact_id}")
        self.assertEqual(archived.status_code, 200, archived.text)
        library_after_archive = self.client.get("/api/v2/projects/PRJ_FUSION/assets").json()
        fusion_after_archive = next(item for item in library_after_archive["assets"] if item["id"] == "BLEND_SH001")
        self.assertFalse(fusion_after_archive["fusionPromptStale"])
        archived_handoff = next(node for node in archived.json()["asset_board"]["board"]["nodes"] if node["id"] == "handoff:BLEND_SH001")
        self.assertIsNone(archived_handoff["config"]["artifact_id"])

        replacement = self.client.post(
            "/api/v2/projects/PRJ_FUSION/asset-intake",
            data={
                "logical_asset_id": "BLEND_SH001",
                "asset_class": "fusion",
                "asset_role": "shot-fusion",
                "source_type": "chatgpt-web",
                "prompt_version": prompt_version,
                "relevant_shots_json": '["SH001"]',
            },
            files={"file": ("fusion-replacement.png", PNG_1X1, "image/png")},
        )
        self.assertEqual(replacement.status_code, 200, replacement.text)
        replacement_payload = replacement.json()
        self.assertNotEqual(replacement_payload["artifact"]["id"], first_artifact_id)
        replacement_handoff = next(node for node in replacement_payload["asset_board"]["board"]["nodes"] if node["id"] == "handoff:BLEND_SH001")
        self.assertEqual(replacement_handoff["config"]["artifact_id"], replacement_payload["artifact"]["id"])
        library_after_replacement = self.client.get("/api/v2/projects/PRJ_FUSION/assets").json()
        fusion_after_replacement = next(item for item in library_after_replacement["assets"] if item["id"] == "BLEND_SH001")
        self.assertFalse(fusion_after_replacement["fusionPromptStale"])

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
